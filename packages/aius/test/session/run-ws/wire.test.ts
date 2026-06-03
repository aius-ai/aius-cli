import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { RunWsWire } from "@/session/run-ws/wire"
import type { LLM } from "@/session/llm"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"

// OpenRouter is the only provider package the native request adapter lowers, and
// it is also the package the run loop proxies through, so the fixture model uses
// it to exercise the real lowering end to end.
const model: Provider.Model = {
  id: ModelID.make("openai/gpt-5-mini"),
  providerID: ProviderID.make("openrouter"),
  api: {
    id: "openai/gpt-5-mini",
    url: "https://openrouter.ai/api/v1",
    npm: "@openrouter/ai-sdk-provider",
  },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

// A conversation that already contains an assistant tool call and its result, so
// the wire conversion exercises the full system/user/assistant+tool_calls/tool
// lowering rather than a trivial single turn.
const messages: ModelMessage[] = [
  { role: "user", content: "list the files" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Running it now" },
      { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "call-1", toolName: "bash", output: { type: "text", value: "a.txt" } },
    ],
  },
]

const streamInput = {
  system: ["env context", "skill instructions"],
  messages,
  model,
} as unknown as LLM.StreamInput

describe("session.run-ws.wire", () => {
  test("lowers StreamInput to OpenAI chat-completions wire messages", async () => {
    const wire = await Effect.runPromise(RunWsWire.toWireMessages(streamInput))

    expect(wire[0].role).toBe("system")
    if (wire[0].role === "system") expect(wire[0].content).toContain("env context")

    const user = wire.find((message) => message.role === "user")
    expect(user).toBeDefined()
    if (user?.role === "user") expect(user.content).toContain("list the files")

    const assistant = wire.find((message) => message.role === "assistant")
    expect(assistant).toBeDefined()
    if (assistant?.role === "assistant") {
      expect(assistant.tool_calls).toBeDefined()
      expect(assistant.tool_calls?.length ?? 0).toBeGreaterThan(0)
      const call = assistant.tool_calls?.[0]
      expect(call?.type).toBe("function")
      expect(call?.id).toBe("call-1")
      expect(call?.function.name).toBe("bash")
      expect(call?.function.arguments).toContain("ls")
    }

    const toolMessage = wire.find((message) => message.role === "tool")
    expect(toolMessage).toBeDefined()
    if (toolMessage?.role === "tool") {
      expect(toolMessage.tool_call_id).toBe("call-1")
      expect(toolMessage.content).toContain("a.txt")
    }

    // Tools are intentionally omitted from the wire body: the backend injects the
    // seeded agent prompt and tool schemas by agent name.
    expect(wire.some((message) => message.role === "assistant" && "tools" in message)).toBe(false)
  })

  // Anthropic rejects a trailing assistant message ("does not support assistant
  // message prefill; conversation must end with a user message"). When a run
  // starts from a history ending on the agent's own summary, we DROP the trailing
  // assistant turn — NOT inject a synthetic "continue", which would forge the
  // human-approval signal the DS review gates check for.
  test("drops a trailing assistant message (no forged continue)", async () => {
    const trailingAssistant = {
      system: ["env"],
      model,
      messages: [
        { role: "user", content: "write the context doc" },
        { role: "assistant", content: "context/CONTEXT.md is ready. Key findings: …" },
      ] satisfies ModelMessage[],
    } as unknown as LLM.StreamInput

    const wire = await Effect.runPromise(RunWsWire.toWireMessages(trailingAssistant))
    const last = wire[wire.length - 1]
    expect(last.role).toBe("user")
    if (last.role === "user") expect(last.content).toContain("write the context doc")
    // no synthetic "Continue." was injected
    expect(wire.some((m) => m.role === "user" && m.content === "Continue.")).toBe(false)
  })

  // A history already ending in a user (or tool) turn is valid — don't append.
  test("leaves a history that already ends with a user turn untouched", async () => {
    const trailingUser = {
      system: ["env"],
      model,
      messages: [{ role: "user", content: "go" }] satisfies ModelMessage[],
    } as unknown as LLM.StreamInput

    const wire = await Effect.runPromise(RunWsWire.toWireMessages(trailingUser))
    expect(wire.filter((m) => m.role === "user").length).toBe(1)
    expect(wire[wire.length - 1].role).toBe("user")
  })
})
