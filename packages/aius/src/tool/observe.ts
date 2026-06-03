import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./observe.txt"
import * as Tool from "./tool"

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SLUG_RE = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/

const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "Meaningful kebab-case observation name (e.g. class-imbalance-by-placement)" }),
  notebook_slug: Schema.String.annotate({ description: "Slug of the notebook that produced this observation" }),
  markdown: Schema.String.annotate({ description: "The observation writeup (markdown). What the evidence shows + why it matters." }),
  evidence: Schema.Array(Schema.String).annotate({ description: "Artifact filenames from the notebook's artifacts/ to include (>=1)" }),
})

export const ObserveTool = Tool.define(
  "observe",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { name: string; notebook_slug: string; markdown: string; evidence: readonly string[] }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const fs = yield* Effect.promise(() => import("fs/promises"))

          if (!NAME_RE.test(params.name)) {
            return reject(`invalid observation name "${params.name}" — use meaningful lowercase kebab-case (e.g. missing-history-flag)`)
          }
          if (!SLUG_RE.test(params.notebook_slug)) {
            return reject(`invalid notebook slug "${params.notebook_slug}"`)
          }
          if (!params.evidence || params.evidence.length === 0) {
            return reject("an observation needs at least one evidence figure — discovery is visual; produce figures in the notebook and list them")
          }

          const nbSrc = path.join(ins.directory, "output", "notebooks", params.notebook_slug, "notebook.ipynb")
          if (!(yield* Effect.promise(() => Bun.file(nbSrc).exists()))) {
            return reject(`notebook output/notebooks/${params.notebook_slug}/notebook.ipynb not found — create and run it first`)
          }

          const artifactsDir = path.join(ins.directory, "output", "notebooks", params.notebook_slug, "artifacts")
          const missing: string[] = []
          for (const e of params.evidence) {
            if (!(yield* Effect.promise(() => Bun.file(path.join(artifactsDir, path.basename(e))).exists()))) missing.push(e)
          }
          if (missing.length > 0) {
            return reject(`evidence not found in the notebook's artifacts/: ${missing.join(", ")}`)
          }

          const obsDir = path.join(ins.directory, "output", "discovery", params.name)
          const evidenceDir = path.join(obsDir, "evidence")
          yield* Effect.promise(() => fs.mkdir(evidenceDir, { recursive: true }))
          yield* Effect.promise(() => Bun.write(path.join(obsDir, "observation.md"), params.markdown.endsWith("\n") ? params.markdown : params.markdown + "\n"))
          yield* Effect.promise(() => fs.copyFile(nbSrc, path.join(obsDir, "notebook.ipynb")))
          for (const e of params.evidence) {
            const base = path.basename(e)
            yield* Effect.promise(() => fs.copyFile(path.join(artifactsDir, base), path.join(evidenceDir, base)))
          }

          const rel = path.relative(ins.directory, obsDir)
          return {
            title: `observe: ${params.name}`,
            metadata: { ok: true, path: rel, evidence: params.evidence.length } as Record<string, unknown>,
            output: `Recorded observation \`${rel}/\` — observation.md + notebook.ipynb + ${params.evidence.length} evidence figure${params.evidence.length === 1 ? "" : "s"}.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const reject = (msg: string) => ({ title: "observe: rejected", metadata: { ok: false } as Record<string, unknown>, output: msg })

export * as Observe from "./observe"
