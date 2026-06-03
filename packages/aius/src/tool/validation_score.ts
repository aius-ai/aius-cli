import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Notebook } from "@/python/notebook"
import { Goals } from "@/ds/goals"
import DESCRIPTION from "./validation_score.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  goal_id: Schema.String.annotate({ description: "Goal id from .aius/goals.json whose protocol to score against." }),
  model_name: Schema.String.annotate({
    description: "Short slug for this model on the leaderboard, e.g. baseline, lightgbm, autogluon, aiusfe. Re-scoring the same name overwrites its entry.",
  }),
  predictions: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.Number))).annotate({
    description:
      'Optional inline per-fold predictions {"0": [...], "1": [...]} aligned with each fold\'s test_idx order. PREFER writing them to output/validation/<slug>/predictions/<model>.json from your notebook and omitting this — large arrays do not belong in a tool call.',
  }),
})

export const ValidationScoreTool = Tool.define(
  "validation_score",
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
              title: "validation_score: unknown goal",
              metadata: { ok: false, goal_id: params.goal_id } as Record<string, unknown>,
              output: `No goal with id "${params.goal_id}" in .aius/goals.json.`,
            }
          }

          const r = yield* nb.protocolScore({
            root: ins.directory,
            goal_slug: goal.slug,
            model_name: params.model_name,
            predictions: params.predictions,
          })

          if (r.error || r.mean === undefined) {
            return {
              title: "validation_score: failed",
              metadata: { ok: false, goal_id: params.goal_id, model: params.model_name, error: r.error } as Record<string, unknown>,
              output: r.error ?? "protocol_score returned no score.",
            }
          }

          const board = (r.leaderboard ?? [])
            .map((e, i) => `  ${i + 1}. ${e.model} — ${e.mean.toFixed(4)} ± ${e.std.toFixed(4)}`)
            .join("\n")
          return {
            title: `validation_score: ${params.model_name} = ${r.mean.toFixed(4)} (rank ${r.rank}/${r.n_models})`,
            metadata: {
              ok: true,
              model: r.model,
              mean: r.mean,
              std: r.std,
              folds: r.folds,
              rank: r.rank,
              n_models: r.n_models,
            } as Record<string, unknown>,
            output: [
              `\`${params.model_name}\`: ${r.mean.toFixed(4)} ± ${r.std?.toFixed(4)} across folds — rank ${r.rank} of ${r.n_models}.`,
              "",
              "Leaderboard:",
              board,
              "",
              "Scored through the frozen protocol — comparable to every other entry on the same folds + metric.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ValidationScore from "./validation_score"
