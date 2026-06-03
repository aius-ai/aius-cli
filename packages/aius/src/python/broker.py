"""Aius notebook broker.

Reads newline-delimited JSON-RPC 2.0 requests on stdin, writes responses on
stdout. Manages Jupyter notebooks (.ipynb) and a pool of persistent kernels —
one per notebook — so the agent builds and runs notebooks cell-by-cell instead
of executing raw Python.

Adapted from MrFishPL/aius-old `nb_mcp` (MIT): notebook file ops via nbformat,
a persistent ipykernel per notebook via jupyter_client, and full-notebook
re-execution via nbclient. The kernel cwd is each notebook's `artifacts/` dir,
so `plt.savefig("f.png")` / `df.to_csv("t.csv")` land there with no path work.

Methods:
  nb_init {path, title}            → create notebook + artifacts dir
  nb_add_markdown {path, text}
  nb_add_code {path, source}
  nb_replace_last {path, source}   → invalidates the persistent kernel
  nb_delete_last {path}            → invalidates the persistent kernel
  nb_show_source {path}            → [{cell_type, execution_count, source}]
  nb_show_output {path, cell_index?}
  nb_run_last {path, timeout?}     → run last code cell on persistent kernel
  nb_run_all {path, timeout?}      → re-run all on a fresh transient kernel
  nb_kernel_stop {path}
  nb_artifacts {path}              → list files in the notebook's artifacts dir
  context_ingest {root}            → deep ingest of context docs + raw data profile
  protocol_make {root, goal_slug, data_path, target, metric, ...}
                                   → freeze CV folds + metric + ground truth (fair-comparison protocol)
  protocol_score {root, goal_slug, model_name, predictions}
                                   → score per-fold predictions through the frozen protocol; update leaderboard
  info {}                          → {status, notebooks, kernels}
  shutdown {}
"""
from __future__ import annotations

import contextlib
import json
import os
import queue as _queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
_OUTPUT_LIMIT = 8_000
_KERNEL_READY_TIMEOUT_S = 30
_CELL_TIMEOUT_S = 600
_GRACEFUL_SHUTDOWN_TIMEOUT_S = 2.0


def strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def truncate(text: str, limit: int = _OUTPUT_LIMIT) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n…[truncated {len(text) - limit} chars]…\n" + text[-half:]


# --- notebook file ops (nbformat) --------------------------------------------


def _nb():
    import nbformat
    from nbformat import v4

    return nbformat, v4


def _artifacts_dir(path: Path) -> Path:
    d = path.parent / "artifacts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def nb_load(path: Path):
    nbformat, _ = _nb()
    return nbformat.read(path, as_version=4)


def nb_save(doc, path: Path) -> None:
    nbformat, _ = _nb()
    nbformat.write(doc, path)


def nb_init(path: Path, title: str) -> None:
    nbformat, v4 = _nb()
    path.parent.mkdir(parents=True, exist_ok=True)
    _artifacts_dir(path)
    doc = v4.new_notebook()
    doc.cells.append(v4.new_markdown_cell(f"# {title}"))
    nb_save(doc, path)


def nb_add_markdown(path: Path, text: str) -> None:
    _, v4 = _nb()
    doc = nb_load(path)
    doc.cells.append(v4.new_markdown_cell(text))
    nb_save(doc, path)


def nb_add_code(path: Path, source: str) -> None:
    _, v4 = _nb()
    doc = nb_load(path)
    doc.cells.append(v4.new_code_cell(source))
    nb_save(doc, path)


def _code_indices(doc) -> list[int]:
    return [i for i, c in enumerate(doc.cells) if c["cell_type"] == "code"]


def nb_replace_last(path: Path, source: str) -> None:
    _, v4 = _nb()
    doc = nb_load(path)
    idxs = _code_indices(doc)
    if not idxs:
        raise ValueError("no code cells to replace")
    doc.cells[idxs[-1]] = v4.new_code_cell(source)
    nb_save(doc, path)


def nb_delete_last(path: Path) -> None:
    doc = nb_load(path)
    idxs = _code_indices(doc)
    if not idxs:
        raise ValueError("no code cells to delete")
    del doc.cells[idxs[-1]]
    nb_save(doc, path)


def nb_show_source(path: Path) -> list[dict]:
    doc = nb_load(path)
    return [
        {"cell_type": c.get("cell_type", ""), "execution_count": c.get("execution_count"), "source": c.get("source", "")}
        for c in doc.cells
    ]


def _cell_text(cell) -> tuple[str, bool]:
    parts: list[str] = []
    had_error = False
    for out in cell.get("outputs", []):
        otype = out.get("output_type")
        if otype == "stream":
            parts.append(out.get("text", ""))
        elif otype in ("execute_result", "display_data"):
            parts.append(out.get("data", {}).get("text/plain", ""))
        elif otype == "error":
            had_error = True
            parts.append("\n".join(out.get("traceback", [])))
            parts.append(f"{out.get('ename', 'Error')}: {out.get('evalue', '')}")
    return "".join(parts), had_error


def nb_show_output(path: Path, cell_index=None) -> str:
    doc = nb_load(path)
    if cell_index is not None:
        text, _ = _cell_text(doc.cells[cell_index])
        return truncate(strip_ansi(text)) or "(no output)"
    parts = [_cell_text(c)[0] for c in doc.cells]
    return truncate(strip_ansi("".join(parts))) or "(no output)"


def _last_code_source(doc) -> str:
    idxs = _code_indices(doc)
    if not idxs:
        raise ValueError("notebook has no code cells")
    return doc.cells[idxs[-1]]["source"]


def _prior_code_sources(doc) -> list[str]:
    idxs = _code_indices(doc)
    return [doc.cells[i]["source"] for i in idxs[:-1]] if idxs else []


def _save_last_output(path: Path, text: str, had_error: bool) -> None:
    nbformat, v4 = _nb()
    doc = nb_load(path)
    idxs = _code_indices(doc)
    if not idxs:
        return
    cell = doc.cells[idxs[-1]]
    if had_error:
        cell["outputs"] = [
            v4.new_output("error", ename="CellError", evalue=text.splitlines()[0] if text else "", traceback=text.splitlines() or [""])
        ]
    else:
        cell["outputs"] = [v4.new_output("stream", name="stdout", text=text)]
    cell["execution_count"] = (cell.get("execution_count") or 0) + 1
    nb_save(doc, path)


# --- persistent kernel (jupyter_client) --------------------------------------


def _safe_kill(proc, sig) -> None:
    with contextlib.suppress(ProcessLookupError, OSError):
        proc.send_signal(sig)


class KernelSession:
    def __init__(self, path, proc, kc, connfile):
        self.path = path
        self.proc = proc
        self.kc = kc
        self._connfile = connfile

    @classmethod
    def cold_start(cls, path: Path, prior_code_cells: list[str]) -> "KernelSession":
        from jupyter_client import BlockingKernelClient, KernelManager

        km = KernelManager(kernel_name="python3")
        km.write_connection_file()
        conn_info = km.get_connection_info()
        connfile = km.connection_file
        # Capture the kernel's stderr to a real temp file (not a PIPE, which can
        # deadlock). A startup crash — missing ipykernel, a broken import, a bad
        # sitecustomize — otherwise surfaces only as a bare "Kernel died before
        # replying to kernel_info" with no cause.
        errlog = tempfile.TemporaryFile()
        proc = subprocess.Popen(
            [sys.executable, "-m", "ipykernel_launcher", "-f", connfile],
            stdout=subprocess.DEVNULL,
            stderr=errlog,
            start_new_session=True,
            cwd=str(_artifacts_dir(path)),
        )
        try:
            kc = BlockingKernelClient()
            kc.load_connection_info(conn_info)
            kc.start_channels()
            kc.wait_for_ready(timeout=_KERNEL_READY_TIMEOUT_S)
        except BaseException as exc:
            proc.kill()
            Path(connfile).unlink(missing_ok=True)
            tail = ""
            with contextlib.suppress(Exception):
                errlog.seek(0)
                tail = errlog.read().decode("utf-8", "replace").strip()[-1500:]
            errlog.close()
            if tail:
                raise RuntimeError(f"{type(exc).__name__}: {exc}\nKernel stderr:\n{tail}") from exc
            raise
        errlog.close()
        session = cls(path, proc, kc, connfile)
        for idx, src in enumerate(prior_code_cells):
            text, had_error = session._execute_raw(src, _CELL_TIMEOUT_S)
            if had_error:
                session.shutdown()
                raise RuntimeError(f"prior cell {idx} failed during replay: {truncate(strip_ansi(text))}")
        return session

    def execute(self, source: str, timeout: float) -> tuple[str, bool]:
        text, had_error = self._execute_raw(source, timeout)
        return truncate(strip_ansi(text)), had_error

    def _execute_raw(self, source: str, timeout: float) -> tuple[str, bool]:
        msg_id = self.kc.execute(source)
        parts: list[str] = []
        had_error = False
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                parts.append(f"\n[kernel] cell exceeded {timeout}s timeout")
                had_error = True
                break
            try:
                msg = self.kc.get_iopub_msg(timeout=remaining)
            except _queue.Empty:
                continue
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            mtype = msg["msg_type"]
            content = msg["content"]
            if mtype == "status":
                if content.get("execution_state") == "idle":
                    break
            elif mtype == "stream":
                parts.append(content.get("text", ""))
            elif mtype in ("execute_result", "display_data"):
                parts.append(content.get("data", {}).get("text/plain", ""))
            elif mtype == "error":
                parts.append(f"{content.get('ename', 'Error')}: {content.get('evalue', '')}\n" + "\n".join(content.get("traceback", [])))
                had_error = True
        return "".join(parts), had_error

    def shutdown(self) -> None:
        graceful_ok = False
        if self.proc.poll() is None:
            errors: list[BaseException] = []

            def _graceful():
                try:
                    self.kc.shutdown()
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            t = threading.Thread(target=_graceful, daemon=True)
            t.start()
            t.join(_GRACEFUL_SHUTDOWN_TIMEOUT_S)
            graceful_ok = (not t.is_alive()) and not errors
        with contextlib.suppress(Exception):
            self.kc.stop_channels()
        if self.proc.poll() is None:
            if not graceful_ok:
                _safe_kill(self.proc, signal.SIGTERM)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    self.proc.wait(timeout=0.3)
            if self.proc.poll() is None:
                _safe_kill(self.proc, signal.SIGKILL)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    self.proc.wait(timeout=1.0)
        Path(self._connfile).unlink(missing_ok=True)


_POOL: dict[str, KernelSession] = {}


def _drop(path_str: str) -> None:
    session = _POOL.pop(path_str, None)
    if session is not None:
        with contextlib.suppress(Exception):
            session.shutdown()


def run_all_transient(path: Path, timeout: float) -> tuple[str, bool]:
    import nbformat
    from nbclient import NotebookClient
    from nbclient.exceptions import CellExecutionError, CellTimeoutError, DeadKernelError

    doc = nbformat.read(path, as_version=4)
    client = NotebookClient(doc, timeout=timeout, kernel_name="python3", resources={"metadata": {"path": str(_artifacts_dir(path))}})
    parts: list[str] = []
    had_error = False
    client.reset_execution_trackers()
    with client.setup_kernel():
        for idx, cell in enumerate(doc.cells):
            if cell["cell_type"] != "code":
                continue
            try:
                client.execute_cell(cell, cell_index=idx)
            except (CellExecutionError, CellTimeoutError, DeadKernelError) as exc:
                parts.append(f"cell {idx} {type(exc).__name__}: {exc}")
                had_error = True
                break
            text, _ = _cell_text(cell)
            if text:
                parts.append(text)
    if not had_error:
        nbformat.write(doc, path)
    return truncate(strip_ansi("".join(parts))), had_error


# --- RPC handlers ------------------------------------------------------------


def _m_nb_init(p):
    nb_init(Path(p["path"]), p.get("title", "Notebook"))
    return {"ok": True}


def _m_nb_add_markdown(p):
    nb_add_markdown(Path(p["path"]), p["text"])
    return {"ok": True}


def _m_nb_add_code(p):
    nb_add_code(Path(p["path"]), p["source"])
    return {"ok": True}


def _m_nb_replace_last(p):
    nb_replace_last(Path(p["path"]), p["source"])
    _drop(p["path"])
    return {"ok": True}


def _m_nb_delete_last(p):
    nb_delete_last(Path(p["path"]))
    _drop(p["path"])
    return {"ok": True}


def _m_nb_show_source(p):
    return {"cells": nb_show_source(Path(p["path"]))}


def _m_nb_show_output(p):
    return {"output": nb_show_output(Path(p["path"]), p.get("cell_index"))}


def _m_nb_run_last(p):
    path = Path(p["path"])
    timeout = float(p.get("timeout", _CELL_TIMEOUT_S))
    doc = nb_load(path)
    source = _last_code_source(doc)
    session = _POOL.get(p["path"])
    if session is None:
        session = KernelSession.cold_start(path, _prior_code_sources(doc))
        _POOL[p["path"]] = session
    try:
        text, had_error = session.execute(source, timeout)
    except Exception as exc:
        _drop(p["path"])
        return {"output": f"kernel died: {type(exc).__name__}: {exc}", "had_error": True}
    with contextlib.suppress(Exception):
        _save_last_output(path, text, had_error)
    return {"output": text or "(no output)", "had_error": had_error, "artifacts": _list_artifacts(path)}


def _m_nb_run_all(p):
    path = Path(p["path"])
    timeout = float(p.get("timeout", _CELL_TIMEOUT_S))
    text, had_error = run_all_transient(path, timeout)
    return {"output": text or "(no output)", "had_error": had_error, "artifacts": _list_artifacts(path)}


def _m_nb_kernel_stop(p):
    _drop(p["path"])
    return {"ok": True}


def _list_artifacts(path: Path) -> list[str]:
    d = path.parent / "artifacts"
    if not d.is_dir():
        return []
    return sorted(f.name for f in d.iterdir() if f.is_file() and not f.name.startswith("."))


def _m_nb_artifacts(p):
    return {"artifacts": _list_artifacts(Path(p["path"]))}


# --- context ingest: full extraction + deep data profile -------------------


class _HTMLToText:
    @staticmethod
    def convert(html: str) -> str:
        from html.parser import HTMLParser

        class _P(HTMLParser):
            def __init__(self):
                super().__init__()
                self.parts = []
                self._skip = 0

            def handle_starttag(self, tag, attrs):
                if tag in ("script", "style", "head"):
                    self._skip += 1
                if tag in ("br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "table"):
                    self.parts.append("\n")

            def handle_endtag(self, tag):
                if tag in ("script", "style", "head") and self._skip:
                    self._skip -= 1
                if tag in ("td", "th"):
                    self.parts.append("\t")

            def handle_data(self, data):
                if not self._skip and data.strip():
                    self.parts.append(data)

        p = _P()
        p.feed(html)
        text = "".join(p.parts)
        # collapse runs of blank lines
        lines = [ln.rstrip() for ln in text.splitlines()]
        out, blanks = [], 0
        for ln in lines:
            if ln.strip():
                out.append(ln)
                blanks = 0
            else:
                blanks += 1
                if blanks <= 1:
                    out.append("")
        return "\n".join(out).strip()


def _extract_text(path: Path) -> str:
    suf = path.suffix.lower()
    if suf in (".md", ".txt", ".rst", ".json", ".yaml", ".yml"):
        return path.read_text(errors="replace")
    if suf in (".html", ".htm"):
        return _HTMLToText.convert(path.read_text(errors="replace"))
    if suf == ".pdf":
        try:
            from pypdf import PdfReader

            reader = PdfReader(str(path))
            return "\n\n".join((pg.extract_text() or "") for pg in reader.pages)
        except Exception as exc:  # noqa: BLE001
            return f"[pdf extraction failed: {type(exc).__name__}: {exc}]"
    return f"[binary or unsupported file type {suf}; {path.stat().st_size} bytes]"


def _profile_data_file(path: Path) -> str:
    import pandas as pd

    suf = path.suffix.lower()
    try:
        if suf in (".parquet", ".pq"):
            df = pd.read_parquet(path)
            n_rows = len(df)
        elif suf in (".csv", ".tsv", ".txt"):
            sep = "\t" if suf == ".tsv" else ","
            # full row count (cheap line scan), deep profile on a large sample
            with open(path, "rb") as fh:
                n_rows = max(0, sum(1 for _ in fh) - 1)
            df = pd.read_csv(path, sep=sep, nrows=100_000, low_memory=False)
        elif suf in (".xlsx", ".xls"):
            df = pd.read_excel(path)
            n_rows = len(df)
        else:
            return f"### {path.name}\n[unsupported data type {suf}]\n"
    except Exception as exc:  # noqa: BLE001
        return f"### {path.name}\n[profile failed: {type(exc).__name__}: {exc}]\n"

    sampled = len(df)
    lines = [f"### {path.name}", f"- rows: {n_rows:,} (profiled on {sampled:,}-row sample)", f"- columns: {df.shape[1]}", "", "| column | dtype | null% | n_unique | sample values |", "|---|---|---:|---:|---|"]
    for col in df.columns:
        s = df[col]
        nullpct = round(100 * s.isna().mean(), 1)
        nuniq = int(s.nunique(dropna=True))
        vals = ", ".join(str(v)[:24] for v in s.dropna().unique()[:3])
        lines.append(f"| {col} | {s.dtype} | {nullpct} | {nuniq} | {vals.replace(chr(124), '/')} |")
    # numeric summary
    num = df.select_dtypes("number")
    if num.shape[1]:
        lines.append("")
        lines.append("Numeric summary (sample):")
        lines.append("```")
        lines.append(num.describe().T[["mean", "std", "min", "max"]].round(4).to_string())
        lines.append("```")
    lines.append("")
    return "\n".join(lines)


def _read_table(path: Path):
    import pandas as pd

    suf = path.suffix.lower()
    if suf in (".parquet", ".pq"):
        return pd.read_parquet(path)
    if suf in (".csv", ".txt"):
        return pd.read_csv(path, low_memory=False)
    if suf == ".tsv":
        return pd.read_csv(path, sep="\t", low_memory=False)
    if suf in (".xlsx", ".xls"):
        return pd.read_excel(path)
    raise ValueError(f"unsupported data type {suf}")


# Fixed metric registry: name -> (direction, needs_proba). Probabilistic
# metrics (roc_auc, pr_auc, log_loss) consume class-1 probabilities; the rest
# consume hard predictions. The sklearn call lives in _apply_metric.
_METRICS = {
    "roc_auc": ("maximize", True),
    "pr_auc": ("maximize", True),
    "log_loss": ("minimize", True),
    "accuracy": ("maximize", False),
    "f1": ("maximize", False),
    "f1_macro": ("maximize", False),
    "mae": ("minimize", False),
    "rmse": ("minimize", False),
    "mse": ("minimize", False),
    "r2": ("maximize", False),
}


def _apply_metric(name, y_true, y_pred):
    import numpy as np
    from sklearn import metrics as M

    yt = np.asarray(y_true)
    yp = np.asarray(y_pred)
    if name == "roc_auc":
        return float(M.roc_auc_score(yt, yp))
    if name == "pr_auc":
        return float(M.average_precision_score(yt, yp))
    if name == "log_loss":
        return float(M.log_loss(yt, yp))
    if name == "accuracy":
        return float(M.accuracy_score(yt, yp))
    if name == "f1":
        return float(M.f1_score(yt, yp))
    if name == "f1_macro":
        return float(M.f1_score(yt, yp, average="macro"))
    if name == "mae":
        return float(M.mean_absolute_error(yt, yp))
    if name == "rmse":
        return float(np.sqrt(M.mean_squared_error(yt, yp)))
    if name == "mse":
        return float(M.mean_squared_error(yt, yp))
    if name == "r2":
        return float(M.r2_score(yt, yp))
    raise ValueError(f"unknown metric {name}")


def _m_context_ingest(p):
    root = Path(p.get("root", "."))
    ctx_dir = root / "context"
    raw_dir = root / "data" / "raw"
    out = root / "output" / "context"
    out.mkdir(parents=True, exist_ok=True)

    parts = ["# Context ingest", "", "Full extraction of every context file and a deep profile of every raw dataset. Read this before writing CONTEXT.md — do not rely on file heads.", ""]

    ctx_files = sorted(f for f in ctx_dir.iterdir() if f.is_file() and not f.name.startswith(".") and f.name != "CONTEXT.md") if ctx_dir.is_dir() else []
    parts.append("## Context documents\n")
    for f in ctx_files:
        text = _extract_text(f)
        parts.append(f"### {f.name}\n")
        parts.append("```")
        parts.append(text.strip() or "(empty)")
        parts.append("```")
        parts.append("")

    raw_files = sorted(f for f in raw_dir.rglob("*") if f.is_file() and not f.name.startswith(".")) if raw_dir.is_dir() else []
    parts.append("## Raw datasets\n")
    for f in raw_files:
        parts.append(_profile_data_file(f))

    dest = out / "ingest.md"
    dest.write_text("\n".join(parts))
    return {"path": str(dest), "context_files": [f.name for f in ctx_files], "data_files": [f.name for f in raw_files]}


# Standalone, reproducible scorer written into every protocol folder. Mirrors
# _apply_metric so the protocol is verifiable without the broker (and matches
# the AIUSEvolve ProtocolFolder convention).
_SCORER_PY = '''#!/usr/bin/env python
"""Aius validation scorer. Scores a model's per-fold predictions against the
frozen ground truth with the protocol's metric — the SAME way for every model.

Usage:  python scorer.py predictions/<model>.json
predictions/<model>.json: {"0": [...fold-0 test preds...], "1": [...], ...}
aligned with the test_idx order in folds/fold_i.json.
"""
import json, sys
from pathlib import Path
import numpy as np
from sklearn import metrics as M

HERE = Path(__file__).resolve().parent


def apply_metric(name, yt, yp):
    yt = np.asarray(yt); yp = np.asarray(yp)
    return {
        "roc_auc": lambda: M.roc_auc_score(yt, yp),
        "pr_auc": lambda: M.average_precision_score(yt, yp),
        "log_loss": lambda: M.log_loss(yt, yp),
        "accuracy": lambda: M.accuracy_score(yt, yp),
        "f1": lambda: M.f1_score(yt, yp),
        "f1_macro": lambda: M.f1_score(yt, yp, average="macro"),
        "mae": lambda: M.mean_absolute_error(yt, yp),
        "rmse": lambda: np.sqrt(M.mean_squared_error(yt, yp)),
        "mse": lambda: M.mean_squared_error(yt, yp),
        "r2": lambda: M.r2_score(yt, yp),
    }[name]()


def main():
    preds = json.loads(Path(sys.argv[1]).read_text())
    metric = json.loads((HERE / "metric.json").read_text())["name"]
    cv = json.loads((HERE / "cv_plan.json").read_text())
    scores = []
    for i in range(cv["n_folds"]):
        yt = json.loads((HERE / "ground_truth" / ("fold_%d.json" % i)).read_text())["y_true"]
        yp = preds.get(str(i))
        if yp is None or len(yp) != len(yt):
            raise SystemExit("fold %d: prediction missing or length mismatch" % i)
        scores.append(float(apply_metric(metric, yt, yp)))
    print(json.dumps({"metric": metric, "mean": float(np.mean(scores)),
                      "std": float(np.std(scores)), "folds": scores}, indent=2))


if __name__ == "__main__":
    main()
'''


def _protocol_description(slug, cv, metric, direction, needs_proba):
    lines = [
        f"# Validation protocol — {slug}",
        "",
        "Every model is scored **identically** through this protocol so comparisons are fair. "
        "Do NOT invent your own split or metric: train on each fold's `train_idx`, predict on its "
        "`test_idx`, write the predictions, and score with `validation_score` (or `python scorer.py`). "
        "The reconstructed baseline is just another entry on the leaderboard.",
        "",
        f"- **Metric:** `{metric}` ({direction})" + (" — needs class-1 probabilities" if needs_proba else " — needs hard predictions"),
        f"- **Strategy:** {cv['strategy']}, {cv['n_folds']} folds, seed {cv['seed']}",
        f"- **Task:** {cv['task']}",
        f"- **Target:** `{cv['target']}`",
        f"- **Data:** `{cv['data_path']}` ({cv['row_count']:,} rows)",
        "",
        "## Folds",
        "",
        "| fold | train | test |",
        "|---:|---:|---:|",
    ]
    for f in cv["folds"]:
        lines.append(f"| {f['fold']} | {f['train']:,} | {f['test']:,} |")
    lines += [
        "",
        "## Files",
        "",
        "- `cv_plan.json` — strategy, folds, seed",
        "- `metric.json` — metric name + direction",
        "- `folds/fold_i.json` — `train_idx` / `test_idx` (row positions into the data file)",
        "- `ground_truth/fold_i.json` — held-out `y_true` per fold (scorer input)",
        "- `predictions/<model>.json` — your per-fold predictions `{\"0\": [...], ...}`",
        "- `leaderboard.json` — every scored model, ranked",
        "- `scorer.py` — standalone reproducible scorer",
        "",
    ]
    return "\n".join(lines)


def _m_protocol_make(p):
    import numpy as np

    root = Path(p["root"])
    slug = p["goal_slug"]
    target = p["target"]
    task = p.get("task", "classification")
    metric = p["metric"]
    n_folds = int(p.get("n_folds", 5))
    seed = int(p.get("seed", 42))
    group_col = p.get("group_col")
    time_col = p.get("time_col")
    if metric not in _METRICS:
        return {"error": f"unknown metric '{metric}'; choose from {sorted(_METRICS)}"}
    source = root / p["data_path"]
    if not source.exists():
        return {"error": f"data file not found: {p['data_path']} (resolve under data/processed/ or data/raw/)"}
    df = _read_table(source).reset_index(drop=True)
    if target not in df.columns:
        return {"error": f"target '{target}' not in columns: {list(df.columns)[:40]}"}
    y = df[target]
    idx = np.arange(len(df))

    if time_col:
        if time_col not in df.columns:
            return {"error": f"time_col '{time_col}' not in columns"}
        from sklearn.model_selection import TimeSeriesSplit

        order = df[time_col].argsort(kind="stable").to_numpy()
        splits = [(order[tr], order[te]) for tr, te in TimeSeriesSplit(n_splits=n_folds).split(order)]
        strategy = f"time_series(order_by={time_col})"
    elif group_col:
        if group_col not in df.columns:
            return {"error": f"group_col '{group_col}' not in columns"}
        from sklearn.model_selection import GroupKFold

        splits = list(GroupKFold(n_splits=n_folds).split(idx, y, groups=df[group_col]))
        strategy = f"group_kfold(group={group_col})"
    elif task == "classification":
        from sklearn.model_selection import StratifiedKFold

        splits = list(StratifiedKFold(n_splits=n_folds, shuffle=True, random_state=seed).split(idx, y))
        strategy = "stratified_kfold"
    else:
        from sklearn.model_selection import KFold

        splits = list(KFold(n_splits=n_folds, shuffle=True, random_state=seed).split(idx))
        strategy = "kfold"

    out = root / "output" / "validation" / slug
    for sub in ("folds", "ground_truth", "predictions"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    fold_sizes = []
    for i, (tr, te) in enumerate(splits):
        tr = np.asarray(tr)
        te = np.asarray(te)
        (out / "folds" / f"fold_{i}.json").write_text(json.dumps({"train_idx": tr.tolist(), "test_idx": te.tolist()}))
        (out / "ground_truth" / f"fold_{i}.json").write_text(json.dumps({"y_true": y.iloc[te].tolist()}))
        fold_sizes.append({"fold": i, "train": int(len(tr)), "test": int(len(te))})

    direction, needs_proba = _METRICS[metric]
    (out / "metric.json").write_text(json.dumps({"name": metric, "direction": direction, "needs_proba": needs_proba}, indent=2))
    cv_plan = {
        "strategy": strategy,
        "n_folds": n_folds,
        "seed": seed,
        "task": task,
        "target": target,
        "group_col": group_col,
        "time_col": time_col,
        "row_count": int(len(df)),
        "data_path": p["data_path"],
        "folds": fold_sizes,
    }
    (out / "cv_plan.json").write_text(json.dumps(cv_plan, indent=2))
    (out / "scorer.py").write_text(_SCORER_PY)
    (out / "description.md").write_text(_protocol_description(slug, cv_plan, metric, direction, needs_proba))
    return {
        "path": str(out),
        "strategy": strategy,
        "n_folds": n_folds,
        "metric": metric,
        "direction": direction,
        "needs_proba": needs_proba,
        "row_count": int(len(df)),
        "folds": fold_sizes,
    }


def _m_protocol_score(p):
    import numpy as np

    root = Path(p["root"])
    slug = p["goal_slug"]
    model = p["model_name"]
    out = root / "output" / "validation" / slug
    if not (out / "metric.json").exists():
        return {"error": f"no validation protocol at output/validation/{slug}; call protocol_make first"}
    metric = json.loads((out / "metric.json").read_text())
    cv = json.loads((out / "cv_plan.json").read_text())
    preds_path = out / "predictions" / f"{model}.json"
    if p.get("predictions") is not None:
        preds = p["predictions"]
        preds_path.write_text(json.dumps(preds))
    elif preds_path.exists():
        preds = json.loads(preds_path.read_text())
    else:
        return {"error": f"no predictions for '{model}'; write {preds_path} or pass predictions"}

    scores = []
    for i in range(cv["n_folds"]):
        yt = json.loads((out / "ground_truth" / f"fold_{i}.json").read_text())["y_true"]
        yp = preds.get(str(i)) if isinstance(preds, dict) else None
        if yp is None or len(yp) != len(yt):
            return {"error": f"fold {i}: prediction missing or length mismatch (expected {len(yt)})"}
        scores.append(_apply_metric(metric["name"], yt, yp))

    mean = float(np.mean(scores))
    std = float(np.std(scores))
    lb_path = out / "leaderboard.json"
    lb = json.loads(lb_path.read_text()) if lb_path.exists() else {"metric": metric["name"], "direction": metric["direction"], "entries": []}
    lb["entries"] = [e for e in lb["entries"] if e["model"] != model]
    lb["entries"].append({"model": model, "mean": mean, "std": std, "folds": scores})
    lb["entries"].sort(key=lambda e: e["mean"], reverse=(metric["direction"] == "maximize"))
    lb_path.write_text(json.dumps(lb, indent=2))
    rank = next(j for j, e in enumerate(lb["entries"]) if e["model"] == model) + 1
    return {"model": model, "mean": mean, "std": std, "folds": scores, "rank": rank, "n_models": len(lb["entries"]), "leaderboard": lb["entries"]}


def _m_info(_p):
    return {"status": "ready", "kernels": len(_POOL)}


def _teardown_all() -> None:
    for path_str in list(_POOL.keys()):
        _drop(path_str)


def _m_shutdown(_p):
    _teardown_all()
    return {"shutdown": True}


_METHODS = {
    "nb_init": _m_nb_init,
    "nb_add_markdown": _m_nb_add_markdown,
    "nb_add_code": _m_nb_add_code,
    "nb_replace_last": _m_nb_replace_last,
    "nb_delete_last": _m_nb_delete_last,
    "nb_show_source": _m_nb_show_source,
    "nb_show_output": _m_nb_show_output,
    "nb_run_last": _m_nb_run_last,
    "nb_run_all": _m_nb_run_all,
    "nb_kernel_stop": _m_nb_kernel_stop,
    "nb_artifacts": _m_nb_artifacts,
    "context_ingest": _m_context_ingest,
    "protocol_make": _m_protocol_make,
    "protocol_score": _m_protocol_score,
    "info": _m_info,
    "shutdown": _m_shutdown,
}


def _emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    # Kernels are spawned in their own session (start_new_session=True) so a
    # Ctrl+C mid-cell doesn't propagate to them. The flip side is they'd orphan
    # if the broker dies — so tear the pool down on EVERY exit path: explicit
    # shutdown RPC, SIGTERM (worker/TUI teardown or pause-kill), stdin EOF
    # (parent gone), and interpreter exit.
    import atexit

    atexit.register(_teardown_all)

    def _sigterm(_signum, _frame):
        _teardown_all()
        os._exit(0)

    signal.signal(signal.SIGINT, signal.SIG_IGN)
    with contextlib.suppress(ValueError):
        signal.signal(signal.SIGTERM, _sigterm)
        signal.signal(signal.SIGHUP, _sigterm)

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"parse error: {exc}"}})
                continue
            rid = request.get("id")
            method = request.get("method")
            params = request.get("params") or {}
            handler = _METHODS.get(method)
            if handler is None:
                _emit({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown method: {method}"}})
                continue
            try:
                result = handler(params)
            except Exception as exc:
                _emit({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": f"{type(exc).__name__}: {exc}"}})
                continue
            _emit({"jsonrpc": "2.0", "id": rid, "result": result})
            if method == "shutdown":
                return
    finally:
        # stdin closed (parent gone) or any fall-through: don't leave orphans.
        _teardown_all()


if __name__ == "__main__":
    main()
