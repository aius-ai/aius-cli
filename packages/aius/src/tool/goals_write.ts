import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Goals } from "@/ds/goals"
import { State } from "@/ds/state"
import DESCRIPTION from "./goals_write.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  goals: Schema.Array(Goals.Goal).annotate({
    description: "Array of goal objects. See the tool description for the schema.",
  }),
})

export const GoalsWriteTool = Tool.define(
  "goals_write",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { goals: readonly Goals.Goal[] }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const file: Goals.GoalsFile = {
            schema_version: 1,
            goals: [...params.goals],
            generated_at: new Date().toISOString(),
          }
          const errs = Goals.validate(file)
          if (errs.length > 0) {
            return {
              title: "goals_write: validation failed",
              metadata: { ok: false, errors: errs.length, count: 0, ids: [] as string[], advanced: false },
              output:
                "Validation failed. Fix these and retry:\n" + Goals.explainValidation(errs),
            }
          }
          yield* Effect.promise(() => Goals.save(ins.directory, file))

          // Writing goals.json IS the deliverable of goal_extract, so completing
          // it moves the pipeline into the goal_review hard gate automatically.
          // This is what makes the TUI surface the Continue / Chat-about-it gate
          // buttons — without it the stage stays on goal_extract and the user
          // just sees a prompt input.
          const advanced = yield* Effect.promise(() =>
            State.exists(ins.directory)
              .then(async (present) => {
                if (!present) return false
                const state = await State.load(ins.directory).catch(() => undefined)
                if (state?.current_stage !== "goal_extract") return false
                await State.advance(ins.directory)
                return true
              })
              .catch(() => false),
          )

          return {
            title: `goals_write: ${file.goals.length} goal${file.goals.length === 1 ? "" : "s"}`,
            metadata: { ok: true, errors: 0, count: file.goals.length, ids: file.goals.map((g) => g.id), advanced },
            output: [
              `Wrote .aius/goals.json (+ readable output/GOALS.md) with ${file.goals.length} goal${file.goals.length === 1 ? "" : "s"}:`,
              ...file.goals.map((g) => `  • ${g.id} (${g.slug}) — ${g.title} [${g.tooling.intent}]`),
              "",
              advanced
                ? "Pipeline advanced to the goal_review hard gate. The user now sees Continue / Chat-about-it; do not call advance_stage — wait for their signal. They review output/GOALS.md."
                : "Surface the goal_review gate to the user; they review output/GOALS.md and continue when ready.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as GoalsWrite from "./goals_write"
