#!/usr/bin/env python
"""AutoGluon runner for the Aius validation protocol.

Runs inside the vendored AutoGluon env (.aius/vendor/autogluon/), NOT the
locked project venv. Trains AutoGluon TabularPredictor on each frozen fold of
output/validation/<slug>/ and writes per-fold predictions to
predictions/autogluon.json in the protocol's format, so the agent can score it
with validation_score exactly like every other model.

Usage:
  python autogluon_runner.py <project_root> <goal_slug> <total_time_seconds> <presets>

Constraints (per the product spec): CPU-only (num_gpus=0), no TabM model,
AutoGluon 1.5 "extreme" preset by default. The total time budget is split
evenly across folds.
"""
import json
import sys
from pathlib import Path

import pandas as pd
from autogluon.tabular import TabularPredictor


def read_table(path: Path):
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


# AutoGluon eval_metric names that line up with the protocol's metric registry.
_AG_METRIC = {
    "roc_auc": "roc_auc",
    "pr_auc": "average_precision",
    "log_loss": "log_loss",
    "accuracy": "accuracy",
    "f1": "f1",
    "f1_macro": "f1_macro",
    "mae": "mean_absolute_error",
    "rmse": "root_mean_squared_error",
    "mse": "mean_squared_error",
    "r2": "r2",
}


def main():
    root = Path(sys.argv[1])
    slug = sys.argv[2]
    total_time = int(sys.argv[3])
    presets = sys.argv[4] if len(sys.argv) > 4 else "extreme_quality"

    vdir = root / "output" / "validation" / slug
    cv = json.loads((vdir / "cv_plan.json").read_text())
    metric = json.loads((vdir / "metric.json").read_text())
    df = read_table(root / cv["data_path"]).reset_index(drop=True)
    target = cv["target"]
    n = cv["n_folds"]
    per_fold_time = max(60, total_time // max(1, n))

    # binary vs multiclass vs regression
    if cv["task"] == "regression":
        problem_type = "regression"
    else:
        problem_type = "binary" if df[target].nunique(dropna=True) <= 2 else "multiclass"

    eval_metric = _AG_METRIC.get(metric["name"])
    preds = {}
    for i in range(n):
        fold = json.loads((vdir / "folds" / f"fold_{i}.json").read_text())
        train_df = df.iloc[fold["train_idx"]].reset_index(drop=True)
        test_df = df.iloc[fold["test_idx"]].reset_index(drop=True)

        predictor = TabularPredictor(
            label=target,
            problem_type=problem_type,
            eval_metric=eval_metric,
            path=str(vdir / "autogluon" / f"fold_{i}"),
            verbosity=1,
        )
        # CPU-only, no TabM. excluded_model_types removes the TabM neural model
        # so a GPU-less box isn't penalised waiting on it.
        predictor.fit(
            train_df,
            presets=presets,
            time_limit=per_fold_time,
            num_gpus=0,
            excluded_model_types=["TABM"],
        )

        if metric["needs_proba"]:
            proba = predictor.predict_proba(test_df)
            if problem_type == "binary":
                # positive class column (AutoGluon orders columns by class label)
                pos = predictor.positive_class
                preds[str(i)] = proba[pos].tolist()
            else:
                # multiclass: full probability matrix (rows × classes)
                preds[str(i)] = proba.values.tolist()
        else:
            preds[str(i)] = predictor.predict(test_df).tolist()

    (vdir / "predictions" / "autogluon.json").write_text(json.dumps(preds))
    print(json.dumps({"folds": n, "per_fold_time": per_fold_time, "problem_type": problem_type, "presets": presets}))


if __name__ == "__main__":
    main()
