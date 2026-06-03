import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Notebook } from "@/python/notebook"
import DESCRIPTION from "./context_ingest.txt"
import * as Tool from "./tool"

const Parameters = Schema.Struct({})

export const ContextIngestTool = Tool.define(
  "context_ingest",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const r = yield* nb.contextIngest(ins.directory)
          const rel = path.relative(ins.directory, r.path)
          return {
            title: `context_ingest: ${r.context_files.length} docs, ${r.data_files.length} datasets`,
            metadata: { path: rel, context_files: r.context_files, data_files: r.data_files } as Record<string, unknown>,
            output: [
              `Ingested into \`${rel}\`.`,
              `Context documents: ${r.context_files.join(", ") || "(none)"}`,
              `Raw datasets: ${r.data_files.join(", ") || "(none)"}`,
              "",
              `Now READ \`${rel}\` in full before writing CONTEXT.md — it has the complete document text (incl. any baselines) and a deep data profile.`,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ContextIngest from "./context_ingest"
