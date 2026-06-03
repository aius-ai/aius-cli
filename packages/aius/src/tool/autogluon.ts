import { $ } from "bun"
import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Goals } from "@/ds/goals"
import { resolveUv } from "@/util/uv"
import { Question } from "../question"
import RUNNER_SOURCE from "../python/autogluon_runner.py" with { type: "text" }
import DESCRIPTION from "./autogluon.txt"
import * as Tool from "./tool"

const VENDOR_DIR = path.join(".aius", "vendor", "autogluon")
const MAX_SECONDS = 4 * 60 * 60 // hard ceiling: 4h
const MIN_SECONDS = 300
const INSTALL_TIMEOUT_MS = 45 * 60 * 1000 // one-time ~2GB install
const RUN_BUFFER_MS = 15 * 60 * 1000 // training overhead on top of the budget

export const Parameters = Schema.Struct({
  goal_id: Schema.String.annotate({ description: "Goal id from .aius/goals.json. Its validation_protocol must already exist." }),
  time_limit_seconds: Schema.optional(Schema.Number).annotate({
    description: "Total training budget across ALL folds, capped at 14400 (4h). Default 14400.",
  }),
  presets: Schema.optional(Schema.String).annotate({
    description: "AutoGluon preset. Default 'extreme_quality' (AutoGluon 1.5 Extreme).",
  }),
})

export const AutoGluonTool = Tool.define(
  "autogluon",
  Effect.gen(function* () {
    const question = yield* Question.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const seconds = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, params.time_limit_seconds ?? MAX_SECONDS))
          const presets = params.presets ?? "extreme_quality"
          const hours = (seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)

          // catch INSIDE the promise — a missing goals.json rejects, and
          // Effect.promise would turn that into an uncatchable defect.
          const goals = yield* Effect.promise(() => Goals.load(ins.directory).catch(() => null))
          const goal = goals?.goals.find((g) => g.id === params.goal_id)
          if (!goal) {
            return badResult("unknown goal", { goal_id: params.goal_id }, `No goal with id "${params.goal_id}" in .aius/goals.json.`)
          }

          // The protocol is the scoring contract; AutoGluon trains against its
          // frozen folds. Refuse to run without it.
          const vdir = path.join(ins.directory, "output", "validation", goal.slug)
          if (!(yield* Effect.promise(() => Bun.file(path.join(vdir, "cv_plan.json")).exists()))) {
            return badResult(
              "no validation protocol",
              { goal_id: params.goal_id },
              `No validation protocol at output/validation/${goal.slug}. Call validation_protocol first so AutoGluon trains on the same folds as every other model.`,
            )
          }

          // RED heavy-work gate — the user must deliberately opt in.
          const choice = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  question: `AutoGluon 1.5 Extreme will train for up to ${hours}h on this machine (CPU-only, no GPU). The session is busy the whole time. Run it for "${goal.slug}"?`,
                  header: "HEAVY WORK",
                  danger: true,
                  custom: false,
                  options: [
                    { label: "Cancel", description: "Don't run AutoGluon — pick a lighter path (B simple combination).", recommended: true },
                    { label: `Run for up to ${hours}h`, description: "Start the heavy AutoGluon search now." },
                  ],
                },
              ],
            })
            .pipe(Effect.catch(() => Effect.succeed([[]] as ReadonlyArray<Question.Answer>)))
          const picked = choice[0]?.[0]
          if (picked !== `Run for up to ${hours}h`) {
            return badResult("cancelled", { goal_id: params.goal_id, cancelled: true }, "AutoGluon run cancelled. Use path B (simple combination) instead, or re-run when you're ready to commit the machine.")
          }

          const uv = yield* Effect.promise(() => resolveUv())
          if (!uv) {
            return badResult(
              "uv missing",
              { missing: "uv" },
              "AutoGluon needs `uv` for its isolated env. It ships bundled with Aius — if you're running from source, install uv (`brew install uv`) and retry.",
            )
          }

          const vendor = path.join(ins.directory, VENDOR_DIR)
          const py = yield* Effect.promise(() => ensureEnv(vendor, uv))
          if (!py) {
            return badResult(
              "install failed",
              { goal_id: params.goal_id },
              `Could not build the AutoGluon env in ${VENDOR_DIR}. Check network/disk (the install is ~2GB) and retry.`,
            )
          }
          const runner = path.join(vendor, "autogluon_runner.py")
          yield* Effect.promise(() => Bun.write(runner, RUNNER_SOURCE))

          const command = $`${py} ${runner} ${ins.directory} ${goal.slug} ${seconds} ${presets}`.cwd(ins.directory).nothrow()
          const timeout = new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), seconds * 1000 + RUN_BUFFER_MS))
          const winner = yield* Effect.promise(() =>
            Promise.race([command.quiet().then((r) => ({ result: r, timedOut: false as const })), timeout]),
          )

          if ("timedOut" in winner && winner.timedOut) {
            return badResult(
              `timed out past ${hours}h`,
              { goal_id: params.goal_id, timedOut: true },
              `AutoGluon exceeded its ${hours}h budget + overhead. Any folds it finished are in output/validation/${goal.slug}/predictions/; re-run with a smaller time_limit_seconds or fewer folds.`,
            )
          }

          const result = "result" in winner ? winner.result : undefined
          const exitCode = result?.exitCode ?? -1
          const predExists = yield* Effect.promise(() => Bun.file(path.join(vdir, "predictions", "autogluon.json")).exists())
          if (exitCode !== 0 || !predExists) {
            return badResult(
              `failed (exit ${exitCode})`,
              { goal_id: params.goal_id, exitCode },
              `AutoGluon exited ${exitCode}${predExists ? "" : " with no predictions written"}. Inspect the output; the simple-combination path (B) is a robust fallback.`,
            )
          }

          return {
            title: `autogluon: ${goal.slug} trained`,
            metadata: { ok: true, goal_id: params.goal_id, presets, seconds } as Record<string, unknown>,
            output: [
              `AutoGluon (${presets}) trained on every fold of the validation protocol for "${goal.slug}".`,
              `Predictions written to output/validation/${goal.slug}/predictions/autogluon.json.`,
              "",
              `Now call validation_score(goal_id="${params.goal_id}", model_name="autogluon") to put it on the leaderboard next to the baseline and the simple models.`,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const badResult = (title: string, metadata: Record<string, unknown>, output: string) => ({
  title: `autogluon: ${title}`,
  metadata: { ok: false, ...metadata } as Record<string, unknown>,
  output,
})

// Build the vendored AutoGluon env once (lazy). Marker file so the ~2GB install
// only happens on the first confirmed run; cached after.
const ensureEnv = async (vendor: string, uv: string): Promise<string | null> => {
  const py = path.join(vendor, ".venv", "bin", "python")
  if (await Bun.file(path.join(vendor, ".aius-installed")).exists()) return py
  if ((await $`${uv} venv ${path.join(vendor, ".venv")}`.quiet().nothrow()).exitCode !== 0) return null
  // autogluon.tabular[all] is the tabular subset (no multimodal/timeseries).
  // CPU torch is the default on macOS; num_gpus=0 at fit keeps it CPU everywhere.
  if ((await $`${uv} pip install --python ${py} autogluon.tabular[all]`.quiet().nothrow()).exitCode !== 0) return null
  await Bun.write(path.join(vendor, ".aius-installed"), new Date().toISOString())
  return py
}

export * as AutoGluon from "./autogluon"
