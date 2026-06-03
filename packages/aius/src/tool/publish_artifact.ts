import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./publish_artifact.txt"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  slug: Schema.String.annotate({ description: "Notebook that produced the artifact" }),
  artifact: Schema.String.annotate({ description: "Filename inside the notebook's artifacts/ dir" }),
  destination: Schema.String.annotate({ description: "Path under output/ to publish into (e.g. discovery/01-x/evidence)" }),
})

const underOutput = (root: string, target: string) => {
  const rel = path.relative(path.join(root, "output"), target)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

export const PublishArtifactTool = Tool.define(
  "publish_artifact",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { slug: string; artifact: string; destination: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const fs = yield* Effect.promise(() => import("fs/promises"))

          const base = path.basename(params.artifact)
          const src = path.join(ins.directory, "output", "notebooks", params.slug, "artifacts", base)
          // strip any leading "output/" the agent may include, then resolve under output/
          const destRel = params.destination.replace(/^\/+/, "").replace(/^output\/+/, "")
          const destDir = path.resolve(ins.directory, "output", destRel)

          if (!underOutput(ins.directory, destDir)) {
            return {
              title: "publish_artifact: rejected",
              metadata: { ok: false } as Record<string, unknown>,
              output: `Destination must be under output/. Got "${params.destination}".`,
            }
          }
          const exists = yield* Effect.promise(() => Bun.file(src).exists())
          if (!exists) {
            return {
              title: "publish_artifact: missing",
              metadata: { ok: false } as Record<string, unknown>,
              output: `No artifact "${base}" in output/notebooks/${params.slug}/artifacts/.`,
            }
          }

          yield* Effect.promise(() => fs.mkdir(destDir, { recursive: true }))
          const dest = path.join(destDir, base)
          yield* Effect.promise(() => fs.copyFile(src, dest))

          const rel = path.relative(ins.directory, dest)
          return {
            title: `publish_artifact: ${base}`,
            metadata: { ok: true, path: rel } as Record<string, unknown>,
            output: `Published \`${base}\` to \`${rel}\`.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as PublishArtifact from "./publish_artifact"
