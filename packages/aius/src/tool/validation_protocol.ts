import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Notebook } from "@/python/notebook"
import { Goals } from "@/ds/goals"
import DESCRIPTION from "./validation_protocol.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  goal_id: Schema.String.annotate({ description: "Goal id from .aius/goals.json this protocol validates." }),
  data_path: Schema.String.annotate({
    description: "Path (relative to the project root) of the model-ready dataset, e.g. data/processed/03-model-ready.parquet. Parquet/CSV/TSV/Excel.",
  }),
  target: Schema.String.annotate({ description: "Target column name." }),
  metric: Schema.String.annotate({
    description:
      "Scoring metric, fixed registry: roc_auc | pr_auc | log_loss | accuracy | f1 | f1_macro (classification) · mae | rmse | mse | r2 (regression). Probabilistic metrics (roc_auc/pr_auc/log_loss) score class-1 probabilities.",
  }),
  task: Schema.optional(Schema.Literals(["classification", "regression"])).annotate({
    description: "Defaults to classification. Picks StratifiedKFold vs KFold.",
  }),
  n_folds: Schema.optional(Schema.Number).annotate({ description: "Default 5." }),
  seed: Schema.optional(Schema.Number).annotate({ description: "Default 42." }),
  group_col: Schema.optional(Schema.String).annotate({
    description: "Optional grouping column → GroupKFold (no row leaks across folds for the same group).",
  }),
  time_col: Schema.optional(Schema.String).annotate({
    description: "Optional time column → TimeSeriesSplit (train on past, test on future). Mutually exclusive with group_col.",
  }),
})

export const ValidationProtocolTool = Tool.define(
  "validation_protocol",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const goalsFile = yield* Effect.promise(() => Goals.load(ins.directory)).pipe(
            Effect.catch(() => Effect.succeed(null as Goals.GoalsFile | null)),
          )
          const goal = goalsFile?.goals.find((g) => g.id === params.goal_id)
          if (!goal) {
            return {
              title: "validation_protocol: unknown goal",
              metadata: { ok: false, goal_id: params.goal_id } as Record<string, unknown>,
              output: `No goal with id "${params.goal_id}" in .aius/goals.json. Available: ${(goalsFile?.goals ?? []).map((g) => g.id).join(", ") || "(none)"}.`,
            }
          }

          const r = yield* nb.protocolMake({
            root: ins.directory,
            goal_slug: goal.slug,
            data_path: params.data_path,
            target: params.target,
            metric: params.metric,
            task: params.task,
            n_folds: params.n_folds,
            seed: params.seed,
            group_col: params.group_col,
            time_col: params.time_col,
          })

          if (r.error || !r.path) {
            return {
              title: "validation_protocol: failed",
              metadata: { ok: false, goal_id: params.goal_id, error: r.error } as Record<string, unknown>,
              output: r.error ?? "protocol_make returned no path.",
            }
          }

          const rel = path.relative(ins.directory, r.path)
          return {
            title: `validation_protocol: ${goal.slug} (${r.metric}, ${r.n_folds} folds)`,
            metadata: {
              ok: true,
              path: rel,
              strategy: r.strategy,
              metric: r.metric,
              direction: r.direction,
              needs_proba: r.needs_proba,
              n_folds: r.n_folds,
              row_count: r.row_count,
            } as Record<string, unknown>,
            output: [
              `Froze the validation protocol at \`${rel}\`.`,
              `${r.strategy}, ${r.n_folds} folds, metric \`${r.metric}\` (${r.direction})${r.needs_proba ? " — score class-1 probabilities" : " — score hard predictions"}, ${r.row_count?.toLocaleString()} rows.`,
              "",
              "Every model is now scored the SAME way. For each model:",
              `  1. For each fold i, read \`${rel}/folds/fold_i.json\` (train_idx / test_idx into ${params.data_path}).`,
              "  2. Train on train_idx, predict on test_idx (in that exact order).",
              `  3. Write predictions to \`${rel}/predictions/<model>.json\` as {"0": [...], "1": [...], ...}.`,
              "  4. Call validation_score(goal_id, model_name=<model>).",
              "",
              "Reconstruct the reported baseline first and score it as `baseline` — then every other model is compared fairly against it.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ValidationProtocol from "./validation_protocol"
