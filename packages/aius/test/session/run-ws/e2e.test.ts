import { NodeFileSystem } from "@effect/platform-node"
import { afterAll, beforeAll, expect } from "bun:test"
import { tool } from "ai"
import { Effect, Layer } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../../src/agent/agent"
import { Agent as AgentSvc } from "../../../src/agent/agent"
import { Bus } from "../../../src/bus"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Permission } from "../../../src/permission"
import { Plugin } from "../../../src/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import { Session } from "@/session/session"
import { Auth } from "@/auth"
import { LLM } from "../../../src/session/llm"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionProcessor } from "../../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { SessionStatus } from "../../../src/session/status"
import { SessionSummary } from "../../../src/session/summary"
import { Snapshot } from "../../../src/snapshot"
import * as Log from "@aius-ai/core/util/log"
import { CrossSpawnSpawner } from "@aius-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

void Log.init({ print: false })

// Fake backend run-loop socket. Drives a single turn:
//   start        -> ready + tool_call(read)
//   tool_result  -> assistant_message("all done") + run_completed
// The ONLY fakes in this test are this server and the "read" tool body; every
// other layer (RunWsClient, toLLMEvents, processor handleEvent, store) is real.
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw))
        if (m.type === "start") {
          ws.send(JSON.stringify({ type: "ready", session_id: "s1", run_id: "r1", step_run_id: "p1" }))
          // Title generation is backend-owned: when the client asks, push a title
          // frame the processor persists via Session.setTitle.
          if (m.generate_title)
            ws.send(JSON.stringify({ type: "title", title: "Refactoring user service" }))
          ws.send(JSON.stringify({ type: "tool_call", tool_call_id: "c1", name: "read", arguments: { path: "a.txt" } }))
        }
        if (m.type === "tool_result") {
          expect(m.tool_call_id).toBe("c1")
          ws.send(JSON.stringify({ type: "assistant_message", message: { role: "assistant", content: "all done" } }))
          ws.send(JSON.stringify({ type: "run_completed", status: "completed" }))
        }
      },
    },
  })
  // The run-loop WS URL is resolved lazily from AIUS_API_URL at call time, so
  // pointing it at the fake server here (before process() runs) takes effect.
  process.env["AIUS_API_URL"] = `http://localhost:${server.port}/v1`
  process.env["AIUS_API_KEY"] = "test-key"
})

afterAll(() => {
  server.stop(true)
  delete process.env["AIUS_API_URL"]
  delete process.env["AIUS_API_KEY"]
})

const ref = {
  providerID: ProviderID.make("openrouter"),
  modelID: ModelID.make("openai/gpt-4o"),
}

// A minimal valid openrouter Provider.Model. The WS path lowers the StreamInput
// through LLMNative.request, which only supports the "@openrouter/ai-sdk-provider"
// package; the test-config providers use "@ai-sdk/openai-compatible", so we build
// a real openrouter model directly rather than depend on provider/config
// resolution (which is independently broken on the proxy branch).
const model = (): Provider.Model => ({
  id: ref.modelID,
  providerID: ref.providerID,
  api: { id: "openai/gpt-4o", url: "", npm: "@openrouter/ai-sdk-provider" },
  name: "GPT-4o",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100000, output: 10000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
})

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  Provider.defaultLayer,
  status,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)

it.live("session.processor drives a full WS turn: renders text + records tools", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service

      const mdl = model()
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "hi")
      const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
      })

      const value = yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies MessageV2.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "hi" }],
        tools: {
          read: tool({
            description: "Read a file",
            inputSchema: z.object({ path: z.string() }),
            execute: async (input) => ({
              title: `Read ${input.path}`,
              output: `contents of ${input.path}`,
              metadata: {},
            }),
          }),
        },
      } satisfies LLM.StreamInput)

      const parts = MessageV2.parts(msg.id)
      const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")
      const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

      expect(value).toBe("continue")
      expect(text?.text).toBe("all done")
      expect(call?.tool).toBe("read")
      expect(call?.callID).toBe("c1")
      expect(call?.state.status).toBe("completed")
      if (call?.state.status !== "completed") return
      expect(call.state.input).toEqual({ path: "a.txt" })
      expect(call.state.output).toBe("contents of a.txt")
      // Locks in Fix 3: the rich executor object reaches the render path, so the
      // tool's own `title` survives instead of falling back to the tool name.
      expect(call.state.title).toBe("Read a.txt")
    }),
  ),
)

it.live("session.processor persists a backend title frame to the session", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service

      const mdl = model()
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "refactor user service")
      const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

      yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies MessageV2.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "refactor user service" }],
        // Drives the fake server to emit a `title` frame.
        generateTitle: true,
        tools: {
          read: tool({
            description: "Read a file",
            inputSchema: z.object({ path: z.string() }),
            execute: async (input) => ({ title: `Read ${input.path}`, output: `contents of ${input.path}`, metadata: {} }),
          }),
        },
      } satisfies LLM.StreamInput)

      expect((yield* session.get(chat.id)).title).toBe("Refactoring user service")
    }),
  ),
)
