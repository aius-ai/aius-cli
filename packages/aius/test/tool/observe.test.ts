import { CrossSpawnSpawner } from "@aius-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ObserveTool } from "@/tool/observe"
import { Tool } from "@/tool/tool"
import { Agent } from "@/agent/agent"
import * as Truncate from "@/tool/truncate"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SessionID, MessageID } from "@/session/schema"

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Truncate.defaultLayer, CrossSpawnSpawner.defaultLayer))

const ctx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_obs"),
  messageID: MessageID.make("msg_obs"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const seedNotebook = async (dir: string, slug: string, figures: string[]) => {
  const nbDir = path.join(dir, "output", "notebooks", slug)
  await fs.mkdir(path.join(nbDir, "artifacts"), { recursive: true })
  await Bun.write(path.join(nbDir, "notebook.ipynb"), JSON.stringify({ cells: [], nbformat: 4, nbformat_minor: 5, metadata: {} }))
  for (const f of figures) await Bun.write(path.join(nbDir, "artifacts", f), "PNGDATA")
}

describe("observe tool", () => {
  it.live("bundles observation.md + notebook + evidence into output/discovery/<name>/", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedNotebook(dir, "01-balance", ["balance.png", "table.png"]))
        const tool = yield* ObserveTool
        const def = yield* tool.init()
        const res = yield* def.execute(
          { name: "class-imbalance", notebook_slug: "01-balance", markdown: "## Finding\nimbalanced", evidence: ["balance.png", "table.png"] },
          { ...ctx, ask: () => Effect.void },
        )
        expect((res.metadata as any).ok).toBe(true)
        const obs = path.join(dir, "output", "discovery", "class-imbalance")
        expect(yield* Effect.promise(() => Bun.file(path.join(obs, "observation.md")).exists())).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(obs, "notebook.ipynb")).exists())).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(obs, "evidence", "balance.png")).exists())).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(obs, "evidence", "table.png")).exists())).toBe(true)
      }),
    ),
  )

  it.live("rejects an observation with no evidence figures", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedNotebook(dir, "02-x", []))
        const tool = yield* ObserveTool
        const def = yield* tool.init()
        const res = yield* def.execute(
          { name: "no-evidence", notebook_slug: "02-x", markdown: "x", evidence: [] },
          { ...ctx, ask: () => Effect.void },
        )
        expect((res.metadata as any).ok).toBe(false)
        expect(res.output).toContain("at least one evidence figure")
      }),
    ),
  )

  it.live("rejects a non-kebab name", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedNotebook(dir, "03-x", ["a.png"]))
        const tool = yield* ObserveTool
        const def = yield* tool.init()
        const res = yield* def.execute(
          { name: "Bad Name", notebook_slug: "03-x", markdown: "x", evidence: ["a.png"] },
          { ...ctx, ask: () => Effect.void },
        )
        expect((res.metadata as any).ok).toBe(false)
      }),
    ),
  )
})
