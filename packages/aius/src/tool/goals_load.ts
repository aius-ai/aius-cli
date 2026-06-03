import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Goals } from "@/ds/goals"
import DESCRIPTION from "./goals_load.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

export const GoalsLoadTool = Tool.define(
  "goals_load",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const present = yield* Effect.promise(() => Goals.exists(ins.directory))
          if (!present) {
            return {
              title: "goals_load: missing",
              metadata: { ok: false, present: false } as Record<string, unknown>,
              output: ".aius/goals.json does not exist yet. Generate it via goals_write during the goal_extract stage.",
            }
          }
          const file = yield* Effect.promise(() => Goals.load(ins.directory))
          const errs = Goals.validate(file)
          return {
            title: `goals_load: ${file.goals.length} goal${file.goals.length === 1 ? "" : "s"}`,
            metadata: {
              ok: errs.length === 0,
              present: true,
              count: file.goals.length,
              ids: file.goals.map((g) => g.id),
              validationErrors: errs.length,
              generated_at: file.generated_at,
              reviewed_at: file.reviewed_at,
            } as Record<string, unknown>,
            output: [
              "```json",
              JSON.stringify(file, null, 2),
              "```",
              errs.length > 0
                ? "\nValidation issues:\n" + Goals.explainValidation(errs)
                : "\nAll goals validate.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as GoalsLoad from "./goals_load"
