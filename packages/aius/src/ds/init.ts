import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { State } from "./state"
import { resolveUv } from "@/util/uv"

export const CANONICAL_DIRS = ["context", "data", "output", ".aius", ".venv", ".git"] as const
export const CANONICAL_FILES = [
  ".gitignore",
  ".python-version",
  "README.md",
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
] as const

const GITIGNORE_LINES = [
  ".venv/",
  ".aius/state/",
  ".aius/kernels/",
  ".aius/vendor/",
  // Keep heavy data and binaries OUT of git — the history tracks the agent's
  // textual decisions (CONTEXT.md, observations, run.py, dashboards, goals.json),
  // not gigabytes of raw CSV/parquet or model blobs. Tracking the datasets made
  // `git add` at init/auto-commit hash gigabytes and stall the boot.
  "data/raw/",
  "data/processed/",
  "*.parquet",
  "*.pkl",
  "*.joblib",
  "*.npy",
  "*.npz",
  "__pycache__/",
  "*.pyc",
  ".ipynb_checkpoints/",
] as const

export type Status =
  | { kind: "ok"; created: boolean }
  | { kind: "missing-required"; which: ("context" | "data")[] }
  | { kind: "non-canonical-present"; entries: string[] }
  | { kind: "venv-failed"; reason: string }
  | { kind: "cancelled" }

export type InitOptions = {
  projectRoot: string
  confirmNonCanonical?: () => Promise<boolean>
  setupVenv?: boolean
  // Called with a human line for each slow boot step (venv create, library
  // install) so the CLI can reassure the user before the TUI takes the screen.
  // Only fires when there's actually slow work — a healthy boot stays silent.
  onProgress?: (message: string) => void
}

const exists = (p: string) => Bun.file(p).exists().catch(() => false)
// exists() above is file-only (Bun.file). `present` is true for files OR dirs.
const present = (p: string) => fs.stat(p).then(() => true, () => false)

const isDir = async (p: string) => {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

const dirIsNonEmpty = async (p: string) => {
  if (!(await isDir(p))) return false
  const entries = await fs.readdir(p).catch(() => [])
  return entries.length > 0
}

const listNonCanonical = async (root: string): Promise<string[]> => {
  const entries = await fs.readdir(root).catch(() => [])
  const canonical = new Set<string>([...CANONICAL_DIRS, ...CANONICAL_FILES])
  return entries.filter((e) => !canonical.has(e) && !e.startsWith(".DS_Store"))
}

const ensureGitignore = async (root: string) => {
  const file = path.join(root, ".gitignore")
  const existing = (await Bun.file(file).text().catch(() => "")) || ""
  const have = new Set(existing.split("\n").map((l) => l.trim()).filter(Boolean))
  const additions = GITIGNORE_LINES.filter((l) => !have.has(l))
  if (additions.length === 0) return
  const sep = existing && !existing.endsWith("\n") ? "\n" : ""
  const block = ["", "# aius", ...additions, ""].join("\n")
  await Bun.write(file, existing + sep + block)
}

const ensureGitRepo = async (root: string) => {
  if (await isDir(path.join(root, ".git"))) return
  await $`git init -q`.cwd(root).quiet().nothrow()
  await $`git config commit.gpgsign false`.cwd(root).quiet().nothrow()
}

const which = async (cmd: string): Promise<boolean> => {
  const result = await $`command -v ${cmd}`.quiet().nothrow()
  return result.exitCode === 0
}

// The FIXED library set every notebook runs against. The agent cannot install
// anything; this is the whole environment. Notebook runtime + DS stack.
export const LIBRARIES = [
  "jupyter-client>=8.6",
  "ipykernel>=6.29",
  "nbformat>=5.10",
  "nbclient>=0.10",
  "pandas",
  "numpy",
  "scipy",
  "scikit-learn",
  "lightgbm",
  "xgboost",
  "statsmodels",
  "matplotlib",
  "seaborn",
  "pyarrow",
  "shap",
  "joblib",
  "pypdf",
  "openpyxl",
] as const

const venvPython = (root: string) => {
  const unix = path.join(root, ".venv", "bin", "python")
  const win = path.join(root, ".venv", "Scripts", "python.exe")
  return { unix, win }
}

// Can this venv actually run the pipeline? Checks the notebook runtime
// (ipykernel + jupyter_client) and the DS core import cleanly. This is the real
// gate — a "libs-installed" marker that lies (venv lost ipykernel, or a bulk
// install half-failed) was exactly the "Kernel died before replying to
// kernel_info" bug. Cheap (~100ms) when healthy.
const runtimeHealthy = async (py: string): Promise<boolean> =>
  (await $`${py} -c ${"import ipykernel, jupyter_client, pandas, numpy, sklearn"}`.quiet().nothrow()).exitCode === 0

const installLibraries = async (
  root: string,
  onProgress?: (message: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const { unix } = venvPython(root)
  // Validate by capability, not a marker — and re-run if a previous install
  // left the venv unable to import the runtime.
  if (await runtimeHealthy(unix)) return { ok: true }

  onProgress?.("Installing the data-science libraries — first run, this can take a few minutes…")
  const uv = await resolveUv()
  const r = uv
    ? await $`${uv} pip install --python ${unix} ${LIBRARIES}`.cwd(root).quiet().nothrow()
    : await $`${unix} -m pip install ${LIBRARIES}`.cwd(root).quiet().nothrow()
  if (r.exitCode !== 0) {
    return { ok: false, reason: `library install failed (exit ${r.exitCode}): ${r.stderr.toString().trim().slice(-400) || "(no stderr)"}` }
  }
  // A zero exit isn't proof: verify the runtime really imports before declaring
  // success (e.g. the Python version may lack wheels for one of the libraries).
  if (!(await runtimeHealthy(unix))) {
    return {
      ok: false,
      reason: "library install finished but the venv still can't import ipykernel + the DS core. The Python version likely lacks wheels for one of the libraries — try a venv on Python 3.12.",
    }
  }
  await Bun.write(path.join(root, ".aius", "libs-installed"), new Date().toISOString())
  return { ok: true }
}

// Physically disable package installation in the venv. The environment is a
// fixed set; this is an enforced contract, not a prompt. After the libraries
// are in, we remove pip's entry points and drop a sitecustomize that makes
// `import pip` / `import ensurepip` raise — so `pip install`, `python -m pip`,
// `!pip install` in a notebook, and `python -m ensurepip` (re-bootstrapping pip)
// all fail. (uv-created venvs already ship without pip; this also covers
// `python -m venv` venvs and blocks ensurepip either way.)
const SITECUSTOMIZE = `# Aius: package installation is disabled — the environment is a fixed library set.
import sys
from importlib.abc import MetaPathFinder
class _AiusInstallBlock(MetaPathFinder):
    _blocked = ("pip", "ensurepip")
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in self._blocked:
            raise ImportError(
                "Aius: installing packages is disabled. The environment is a fixed, "
                "predefined library set; work within the available libraries."
            )
        return None
sys.meta_path.insert(0, _AiusInstallBlock())
`

export const hardenVenv = async (root: string): Promise<void> => {
  const fs = await import("fs/promises")
  const binDir = path.join(root, ".venv", "bin")
  const entries = await fs.readdir(binDir).catch(() => [] as string[])
  await Promise.all(
    entries.filter((e) => /^pip[0-9.]*$/.test(e)).map((e) => fs.rm(path.join(binDir, e), { force: true }).catch(() => {})),
  )
  const libDir = path.join(root, ".venv", "lib")
  const pyDirs = (await fs.readdir(libDir).catch(() => [] as string[])).filter((e) => e.startsWith("python"))
  for (const py of pyDirs) {
    const sp = path.join(libDir, py, "site-packages")
    const sps = await fs.readdir(sp).catch(() => [] as string[])
    await Promise.all(
      sps.filter((e) => /^pip([-.]|$)/.test(e)).map((e) => fs.rm(path.join(sp, e), { recursive: true, force: true }).catch(() => {})),
    )
    await Bun.write(path.join(sp, "sitecustomize.py"), SITECUSTOMIZE)
  }
}

const ensureVenv = async (
  root: string,
  onProgress?: (message: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const venv = path.join(root, ".venv")
  if (!(await isDir(venv))) {
    onProgress?.("Setting up the Python environment…")
    const uv = await resolveUv()
    if (uv) {
      // Pin a Python with mature DS/Jupyter wheels. Bleeding-edge interpreters
      // (e.g. the system default 3.14) routinely lack wheels for the heavier
      // libs, which makes the one-shot install fail and leaves the venv without
      // ipykernel. uv fetches 3.12 if it's not already present; fall back to
      // uv's default only if the pin can't be satisfied (e.g. offline).
      let r = await $`${uv} venv --python 3.12 .venv`.cwd(root).quiet().nothrow()
      if (r.exitCode !== 0) r = await $`${uv} venv .venv`.cwd(root).quiet().nothrow()
      if (!(r.exitCode === 0 && (await isDir(venv))))
        return { ok: false, reason: `uv venv failed (exit ${r.exitCode}): ${r.stderr.toString().trim() || "(no stderr)"}` }
    } else {
      const candidate = (await which("python3")) ? "python3" : (await which("python")) ? "python" : undefined
      if (!candidate) return { ok: false, reason: "no python interpreter found. Install uv (recommended) or python3, then retry." }
      const r = await $`${candidate} -m venv .venv`.cwd(root).quiet().nothrow()
      if (!(r.exitCode === 0 && (await isDir(venv))))
        return { ok: false, reason: `${candidate} -m venv failed (exit ${r.exitCode}): ${r.stderr.toString().trim() || "(no stderr)"}` }
    }
  }
  const installed = await installLibraries(root, onProgress)
  if (!installed.ok) return installed
  await hardenVenv(root)
  return { ok: true }
}

const migrateRawData = async (root: string) => {
  const data = path.join(root, "data")
  const raw = path.join(root, "data", "raw")
  const processed = path.join(root, "data", "processed")
  await fs.mkdir(processed, { recursive: true })
  if (await isDir(raw)) return
  await fs.mkdir(raw, { recursive: true })
  const entries = await fs.readdir(data).catch(() => [])
  await Promise.all(
    entries
      .filter((e) => e !== "raw" && e !== "processed" && !e.startsWith(".DS_Store"))
      .map((e) => fs.rename(path.join(data, e), path.join(raw, e))),
  )
}


const ensureOutputSkeleton = async (root: string) => {
  await Promise.all(
    ["output/discovery", "output/notebooks", "output/models", "output/dashboards", ".aius/kernels"].map((p) =>
      fs.mkdir(path.join(root, p), { recursive: true }),
    ),
  )
}

const check = async (root: string): Promise<Status | undefined> => {
  const missing: ("context" | "data")[] = []
  if (!(await dirIsNonEmpty(path.join(root, "context")))) missing.push("context")
  if (!(await dirIsNonEmpty(path.join(root, "data")))) missing.push("data")
  if (missing.length > 0) return { kind: "missing-required", which: missing }
  return undefined
}

export const run = async (opts: InitOptions): Promise<Status> => {
  const root = opts.projectRoot
  const existed = await State.exists(root)

  if (!existed) {
    const failure = await check(root)
    if (failure) return failure

    const nonCanonical = await listNonCanonical(root)
    if (nonCanonical.length > 0) {
      const confirm = opts.confirmNonCanonical ?? (async () => false)
      const ok = await confirm()
      if (!ok) return { kind: "non-canonical-present", entries: nonCanonical }
    }

    await fs.mkdir(path.join(root, ".aius"), { recursive: true })
    await ensureOutputSkeleton(root)
    await ensureGitignore(root)
    await ensureGitRepo(root)
  }

  // Validate (and repair) the Python runtime on EVERY boot, not just first init.
  // ensureVenv is fast when healthy (one import check) and reinstalls when the
  // venv lost ipykernel — otherwise a broken venv stays broken forever and every
  // notebook_run dies with "Kernel died before replying to kernel_info".
  if (opts.setupVenv !== false) {
    const venv = await ensureVenv(root, opts.onProgress)
    if (!venv.ok) return { kind: "venv-failed", reason: venv.reason }
  }

  if (existed) return { kind: "ok", created: false }

  await migrateRawData(root)

  await State.save(root, State.initial("context_build"))

  // Baseline commit: the scaffolded, pre-agent state. `reset` rolls the working
  // tree back to this to restore exactly what the user provided (and drop every
  // agent artifact — CONTEXT.md included) before stripping the scaffolding.
  // Inline identity so the baseline lands even when global git identity isn't set.
  await $`git add -A`.cwd(root).quiet().nothrow()
  await $`git -c user.email=aius@local -c user.name=Aius -c commit.gpgsign=false commit --no-verify --quiet -m ${"chore(aius): project baseline"}`
    .cwd(root)
    .quiet()
    .nothrow()
  // Tag the baseline so `reset` rolls back to THIS commit, not the repo root
  // (which differs when the user already had git history). A tag (not a file)
  // keeps the working tree clean.
  await $`git tag -f aius-baseline`.cwd(root).quiet().nothrow()

  return { kind: "ok", created: true }
}

// Full teardown for the resume-gate Reset: roll the working tree back to the
// baseline commit (restoring the user's original data/context, dropping every
// agent artifact), move data/raw/* back to data/, then remove the aius
// scaffolding (.venv, .git, .gitignore, .aius, output/, data/processed). The
// directory ends up as the bare inputs the user started with.
export const reset = async (
  projectRoot: string,
): Promise<{ moved: string[]; conflicts: string[]; removed: string[] }> => {
  const root = projectRoot
  // Snapshot the scaffolding that exists NOW: all of it is gone by the end
  // (some via `git clean`, the rest via the explicit wipe below), so this is the
  // accurate "removed" report — checking after the wipe would miss what git
  // already cleaned.
  const wipeRel = [".venv", ".git", ".gitignore", ".aius", "output", path.join("data", "processed")]
  const removed: string[] = []
  for (const rel of wipeRel) if (await present(path.join(root, rel))) removed.push(rel)

  if (await isDir(path.join(root, ".git"))) {
    // Prefer the aius-baseline tag (the pre-agent snapshot). Fall back to the
    // repo root commit only for older projects without the tag — root ≠ baseline
    // when the user already had git history.
    const hasTag = (await $`git rev-parse -q --verify refs/tags/aius-baseline`.cwd(root).quiet().nothrow()).exitCode === 0
    const base = hasTag
      ? "aius-baseline"
      : (await $`git rev-list --max-parents=0 HEAD`.cwd(root).quiet().nothrow()).text().trim().split("\n").pop()
    if (base) {
      // Drop CONTEXT.md (and anything else) the agent generated: if it isn't in
      // the baseline tree, the user didn't provide it, so it must not survive.
      // `git reset --hard` to the baseline already does this for tracked files,
      // but be explicit for the file the user called out.
      const userProvidedContext =
        (await $`git cat-file -e ${base}:context/CONTEXT.md`.cwd(root).quiet().nothrow()).exitCode === 0
      await $`git reset --hard ${base}`.cwd(root).quiet().nothrow()
      await $`git clean -fd`.cwd(root).quiet().nothrow()
      if (!userProvidedContext) await fs.rm(path.join(root, "context", "CONTEXT.md"), { force: true }).catch(() => {})
    }
  }

  // Undo the init migration: move data/raw/* back to data/, the original
  // location the user put them in. Leave (never overwrite or delete) any entry
  // whose name is already taken in data/ — only drop data/raw/ once it's empty.
  const dataDir = path.join(root, "data")
  const rawDir = path.join(dataDir, "raw")
  const moved: string[] = []
  const conflicts: string[] = []
  if (await isDir(rawDir)) {
    for (const e of await fs.readdir(rawDir).catch(() => [] as string[])) {
      if (e === ".DS_Store") {
        await fs.rm(path.join(rawDir, e), { force: true }).catch(() => {})
        continue
      }
      const dst = path.join(dataDir, e)
      if (await present(dst)) {
        conflicts.push(e)
        continue
      }
      await fs.rename(path.join(rawDir, e), dst).catch(() => {})
      moved.push(e)
    }
    const leftover = await fs.readdir(rawDir).catch(() => [] as string[])
    if (leftover.length === 0) await fs.rm(rawDir, { recursive: true, force: true }).catch(() => {})
  }

  for (const rel of wipeRel) await fs.rm(path.join(root, rel), { recursive: true, force: true }).catch(() => {})
  return { moved, conflicts, removed }
}

export const explain = (status: Status): string => {
  switch (status.kind) {
    case "ok":
      return status.created ? "Initialized project." : "Project already initialized."
    case "missing-required":
      return [
        `Aius needs ${status.which.map((w) => `\`${w}/\``).join(" and ")} to start.`,
        status.which.includes("context") ? "  • Drop your project brief in `context/`." : "",
        status.which.includes("data") ? "  • Drop your dataset in `data/`." : "",
      ]
        .filter(Boolean)
        .join("\n")
    case "non-canonical-present":
      return [
        "Non-canonical files at project root:",
        ...status.entries.map((e) => `  • ${e}`),
        "Aius expects only: context/, data/, output/, .aius/, .venv/, .git/.",
        "Re-run with --force to proceed anyway.",
      ].join("\n")
    case "venv-failed":
      return [
        "Failed to create .venv:",
        `  ${status.reason}`,
        "Aius needs a Python virtual environment to run the data pipeline.",
        "Install uv (https://docs.astral.sh/uv/) or make python3 available, then retry.",
      ].join("\n")
    case "cancelled":
      return "Initialization cancelled."
  }
}

export * as Init from "./init"
