import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@aius-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@aius-ai/core/filesystem"
import { ToolRegistry } from "@/tool/registry"
import { AgentSeed } from "@/agent-seed/collect"
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

describe("agent-seed.collect", () => {
  it.instance("collectTools returns OpenAI function specs for the default agent", () =>
    Effect.gen(function* () {
      const tools = yield* AgentSeed.collectTools(AgentSeed.AGENT_NAME)
      expect(tools.length).toBeGreaterThan(0)
      for (const t of tools) {
        const parsed = JSON.parse(t.schema_json)
        expect(parsed.type).toBe("function")
        expect(parsed.function.name).toBe(t.name)
        expect(parsed.function).toHaveProperty("parameters")
      }
      expect(tools.map((t) => t.name)).toContain("notebook_create")
      // the InvalidTool placeholder must never be advertised to the model
      expect(tools.map((t) => t.name)).not.toContain("invalid")
    }),
  )

  it.effect("readAgentPrompt returns the aius.txt body", () =>
    Effect.gen(function* () {
      const text = yield* AgentSeed.readAgentPrompt()
      expect(text).toContain("You are Aius")
    }),
  )
})
