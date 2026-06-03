import { $ } from "bun"
import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Goals } from "@/ds/goals"
import { Auth } from "@/auth"
import { resolveUv } from "@/util/uv"
import DESCRIPTION from "./aiusfe.txt"
import * as Tool from "./tool"

const REPO = "https://github.com/MrFishPL/AiusFE"
const VENDOR_DIR = path.join(".aius", "vendor", "aiusfe")

export const Parameters = Schema.Struct({
  goal_id: Schema.String.annotate({
    description: "The goal id this run targets. Must match a goal in .aius/goals.json with tooling.intent='explainability'.",
  }),
  spec_text: Schema.String.annotate({
    description:
      "The full text of the AiusFE problem specification (the contents of a spec_*.txt file). Include the <Task> block, the evaluate() body, and a starter modify_features() body. AiusFE fills [FEATURES] / [EXAMPLES] from the dataset.",
  }),
  problem_name: Schema.String.annotate({ description: "Short slug used by AiusFE for log/output naming." }),
  api_model: Schema.optional(Schema.String).annotate({
    description: "AiusFE model identifier. Defaults to 'gpt-oss-groq'.",
  }),
  max_seconds: Schema.optional(Schema.Number).annotate({
    description: "Wall-clock cap on the run. Defaults to 1200 (20 minutes).",
  }),
})

const cloneIfMissing = async (vendor: string): Promise<{ cloned: boolean; sha: string }> => {
  const exists = await Bun.file(path.join(vendor, "pyproject.toml")).exists()
  if (!exists) {
    await $`git clone --depth 1 ${REPO} ${vendor}`.quiet().nothrow()
  }
  const sha = (await $`git rev-parse --short HEAD`.cwd(vendor).quiet().nothrow()).text().trim()
  return { cloned: !exists, sha }
}

const ensureSynced = async (vendor: string, uv: string): Promise<void> => {
  const marker = path.join(vendor, ".aius-uv-synced")
  if (await Bun.file(marker).exists()) return
  await $`${uv} sync`.cwd(vendor).quiet().nothrow()
  await Bun.write(marker, new Date().toISOString())
}

const writeSpec = async (vendor: string, slug: string, text: string): Promise<string> => {
  const dest = path.join(vendor, "specs", `aius-${slug}.txt`)
  await Bun.write(dest, text)
  return dest
}

const collectTopSamples = async (vendor: string, slug: string, limit = 3): Promise<{ source: string; entries: unknown[] }> => {
  const dir = path.join(vendor, "logs", slug, "samples")
  if (!(await Bun.file(dir).exists())) {
    const trySplit1 = path.join(vendor, "logs", `${slug}_split_1`, "samples")
    if (await Bun.file(trySplit1).exists()) return collectFromDir(trySplit1, limit)
    return { source: dir, entries: [] }
  }
  return collectFromDir(dir, limit)
}

const collectFromDir = async (dir: string, limit: number) => {
  const entries: unknown[] = []
  try {
    const fs = await import("fs/promises")
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).toSorted().slice(-limit * 2)
    for (const f of files) {
      const obj = await Bun.file(path.join(dir, f)).json().catch(() => null)
      if (obj) entries.push(obj)
    }
  } catch {
    return { source: dir, entries: [] }
  }
  return { source: dir, entries: entries.slice(-limit) }
}

const writeFeaturesArtifact = async (
  projectRoot: string,
  goal: Goals.Goal,
  payload: { source: string; entries: unknown[]; spec_path: string; log_path: string; sha: string; api_model: string },
): Promise<string> => {
  const dest = path.join(projectRoot, "output", "notebooks", goal.slug, "aiusfe-features.json")
  const body = {
    goal_id: goal.id,
    goal_slug: goal.slug,
    aiusfe_sha: payload.sha,
    api_model: payload.api_model,
    spec_path: payload.spec_path,
    log_path: payload.log_path,
    candidates: payload.entries,
    generated_at: new Date().toISOString(),
  }
  await Bun.write(dest, JSON.stringify(body, null, 2) + "\n")
  return dest
}

const fetchOpenRouterKey = async (): Promise<string | undefined> => {
  return Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const all = yield* auth.all()
      const entry = all["openrouter"]
      if (!entry) return undefined
      if (entry.type === "api") return entry.key
      return undefined
    }).pipe(Effect.provide(Auth.defaultLayer)),
  ).catch(() => undefined)
}

export const AiusFETool = Tool.define(
  "aiusfe",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const apiModel = params.api_model ?? "gpt-oss-groq"
          const maxSeconds = params.max_seconds ?? 1200
          const goals = yield* Effect.promise(() => Goals.load(ins.directory)).pipe(
            Effect.catch(() => Effect.succeed(null as Goals.GoalsFile | null)),
          )
          const goal = goals?.goals.find((g) => g.id === params.goal_id)
          if (!goal) {
            return {
              title: "aiusfe: unknown goal",
              metadata: { ok: false, goal_id: params.goal_id } as Record<string, unknown>,
              output: `No goal with id "${params.goal_id}" in .aius/goals.json.`,
            }
          }

          const uv = yield* Effect.promise(() => resolveUv())
          if (!uv) {
            return {
              title: "aiusfe: uv missing",
              metadata: { ok: false, missing: "uv" } as Record<string, unknown>,
              output:
                "AiusFE requires `uv`. It ships bundled with Aius — if you're running from source, install it (`brew install uv`) and retry.",
            }
          }

          const vendor = path.join(ins.directory, VENDOR_DIR)
          const { cloned, sha } = yield* Effect.promise(() => cloneIfMissing(vendor))
          yield* Effect.promise(() => ensureSynced(vendor, uv))

          const specPath = yield* Effect.promise(() => writeSpec(vendor, params.problem_name, params.spec_text))
          const logPath = path.join(vendor, "logs", params.problem_name)

          const apiKey = yield* Effect.promise(() => fetchOpenRouterKey())
          if (!apiKey) {
            return {
              title: "aiusfe: missing OPENROUTER_API_KEY",
              metadata: { ok: false, missing: "openrouter_api_key" } as Record<string, unknown>,
              output: "AiusFE needs the OpenRouter API key. Configure it via `aius` first.",
            }
          }

          const command = $`${uv} run --project ${vendor} python main.py --api_model ${apiModel} --problem_name ${params.problem_name} --spec_path ${specPath} --log_path ${logPath}`
            .cwd(vendor)
            .env({ ...process.env, OPENROUTER_API_KEY: apiKey, AIUSFE_VERBOSE: "1" })
            .nothrow()

          const timeout = new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), maxSeconds * 1_000))
          const winner = yield* Effect.promise(() => Promise.race([command.quiet().then((r) => ({ result: r, timedOut: false as const })), timeout]))

          if ("timedOut" in winner && winner.timedOut) {
            return {
              title: `aiusfe: timed out at ${maxSeconds}s`,
              metadata: { ok: false, timedOut: true, goal: goal.id } as Record<string, unknown>,
              output: `AiusFE exceeded ${maxSeconds}s. Check ${path.relative(ins.directory, logPath)} for partial samples and retry with a smaller dataset or fewer iterations.`,
            }
          }

          const samples = yield* Effect.promise(() => collectTopSamples(vendor, params.problem_name))
          const artifact = yield* Effect.promise(() => writeFeaturesArtifact(ins.directory, goal, {
            source: samples.source,
            entries: samples.entries,
            spec_path: specPath,
            log_path: logPath,
            sha,
            api_model: apiModel,
          }))

          const result = "result" in winner ? winner.result : undefined
          const exitCode = result?.exitCode ?? -1

          return {
            title: `aiusfe: ${goal.slug}`,
            metadata: {
              ok: exitCode === 0,
              cloned,
              sha,
              exitCode,
              candidates: samples.entries.length,
              artifact: path.relative(ins.directory, artifact),
            } as Record<string, unknown>,
            output: [
              cloned ? "Cloned AiusFE on first call." : "Reusing previously vendored AiusFE.",
              `Spec written to ${path.relative(ins.directory, specPath)}.`,
              `Logs at ${path.relative(ins.directory, logPath)}.`,
              `Top ${samples.entries.length} candidate${samples.entries.length === 1 ? "" : "s"} written to ${path.relative(ins.directory, artifact)}.`,
              exitCode === 0
                ? `AiusFE exited cleanly. In your notebook (output/notebooks/${goal.slug}/notebook.ipynb) rebuild these features, train on the validation_protocol folds, write predictions to output/validation/${goal.slug}/predictions/aiusfe.json, and call validation_score(model_name="aiusfe").`
                : `AiusFE exited with code ${exitCode}. Inspect the log for the failure reason.`,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as AiusFE from "./aiusfe"
