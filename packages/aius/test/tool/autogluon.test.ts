import { CrossSpawnSpawner } from "@aius-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import { AutoGluonTool } from "@/tool/autogluon"
import { Tool } from "@/tool/tool"
import { Agent } from "@/agent/agent"
import * as Truncate from "@/tool/truncate"
import { Question } from "@/question"
import { Goals } from "@/ds/goals"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SessionID, MessageID } from "@/session/schema"

const it = testEffect(Layer.mergeAll(Question.defaultLayer, Agent.defaultLayer, Truncate.defaultLayer, CrossSpawnSpawner.defaultLayer))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_ag"),
  messageID: MessageID.make("msg_ag"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const goal = (over: Partial<Goals.Goal> = {}): Goals.Goal => ({
  id: "g1",
  slug: "demo",
  type: "modeling",
  title: "Demo",
  outcome: "A model.",
  success_criteria: [{ metric: "roc_auc", target: ">= 0.8", rationale: "brief" }],
  data: { source: "data/processed/model.parquet", target: "y" },
  tooling: { intent: "result", primary: "lightgbm" },
  deliverables: ["notebook"],
  ...over,
})

afterEach(async () => {
  await disposeAllInstances()
})

// These guards return BEFORE the red gate / the AutoGluon install, so they run
// without uv, without a 2GB install, and without simulating a confirmation.
describe("autogluon tool guards", () => {
  it.live("rejects an unknown goal", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        void dir
        const def = yield* (yield* AutoGluonTool).init()
        const res = yield* def.execute({ goal_id: "nope" }, ctx)
        expect((res.metadata as { ok: boolean }).ok).toBe(false)
        expect(res.output).toContain("No goal")
      }),
    ),
  )

  it.live("refuses to run without a validation protocol", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Goals.save(dir, { schema_version: 1, goals: [goal()], generated_at: "2026-05-29T00:00:00Z" }),
        )
        const def = yield* (yield* AutoGluonTool).init()
        const res = yield* def.execute({ goal_id: "g1" }, ctx)
        expect((res.metadata as { ok: boolean }).ok).toBe(false)
        expect(res.output).toContain("validation_protocol")
      }),
    ),
  )
})
