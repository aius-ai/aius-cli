import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@aius-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@aius-ai/core/filesystem"
import { ToolRegistry } from "@/tool/registry"
import { AGENT_NAME } from "@/agent-seed/collect"
import { runSeed } from "@/agent-seed/seed"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Notebook } from "@/python/notebook"

const node = CrossSpawnSpawner.defaultLayer
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".aius")])),
})

const registryLayer = ToolRegistry.layer
  .pipe(
    Layer.provide(configLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Layer.mergeAll(SessionStatus.defaultLayer, BackgroundJob.defaultLayer)),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Layer.mergeAll(Git.defaultLayer, RepositoryCache.defaultLayer)),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(node),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
  )
  .pipe(Layer.provide(Notebook.defaultLayer), Layer.provide(RuntimeFlags.layer({})))

const it = testEffect(Layer.mergeAll(registryLayer, node, Agent.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

// Fake admin server that records every upsert and resolves the agent with a
// tool count equal to the number of /v1/admin/tools POSTs it received.
function fakeAdmin() {
  const promptUpserts: any[] = []
  const toolUpserts: any[] = []
  const agentUpserts: any[] = []

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/v1/admin/prompts") {
        promptUpserts.push(await req.json())
        return Response.json({ ok: true })
      }
      if (req.method === "POST" && url.pathname === "/v1/admin/tools") {
        toolUpserts.push(await req.json())
        return Response.json({ ok: true })
      }
      if (req.method === "POST" && url.pathname === "/v1/admin/agents") {
        agentUpserts.push(await req.json())
        return Response.json({ ok: true })
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/admin/agents/")) {
        return Response.json({
          name: AGENT_NAME,
          system_prompt: promptUpserts.at(-1)?.text ?? null,
          tools: toolUpserts.map((t) => ({ name: t.name })),
        })
      }
      return new Response("not found", { status: 404 })
    },
  })

  return {
    base: server.url.toString().replace(/\/$/, ""),
    promptUpserts,
    toolUpserts,
    agentUpserts,
    stop: () => server.stop(true),
  }
}

describe("agent-seed.seed", () => {
  it.instance("runSeed upserts prompt/tools/agent and verifies the resolved tool count", () =>
    Effect.gen(function* () {
      const admin = fakeAdmin()
      const result = yield* Effect.acquireUseRelease(
        Effect.succeed(admin),
        (a) => runSeed({ base: a.base, token: "test-token" }),
        (a) => Effect.promise(() => a.stop()),
      )

      // prompt upsert used name "build"
      expect(admin.promptUpserts).toHaveLength(1)
      expect(admin.promptUpserts[0].name).toBe("build")

      // agent upsert tool_names length equals the number of tool POSTs
      expect(admin.agentUpserts).toHaveLength(1)
      expect(admin.agentUpserts[0].tool_names.length).toBe(admin.toolUpserts.length)

      // runSeed returns verifiedToolCount equal to that count
      expect(result.verifiedToolCount).toBe(admin.toolUpserts.length)
      expect(result.verifiedToolCount).toBeGreaterThan(0)
    }),
  )

  // Regression for Fix 4: seed-agent.ts strips a trailing `/v1` from the base
  // (the default + AIUS_API_URL include it) before the admin client prepends
  // `/v1/admin/...`, so the POST lands on a single `/v1`, not `.../v1/v1/...`.
  it.instance("seed base ending in /v1 posts to a single /v1/admin path", () =>
    Effect.gen(function* () {
      const admin = fakeAdmin()
      const base = `${admin.base}/v1`.replace(/\/v1\/?$/, "")
      yield* Effect.acquireUseRelease(
        Effect.succeed(admin),
        () => runSeed({ base, token: "test-token" }),
        (a) => Effect.promise(() => a.stop()),
      )

      expect(admin.promptUpserts).toHaveLength(1)
    }),
  )
})
