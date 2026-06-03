import { expect, test } from "bun:test"
import { RunWsProtocol } from "@/session/run-ws/protocol"
import { RunWsEvents } from "@/session/run-ws/events"

test("tool_call frame maps to tool-input-start then tool-call", () => {
  const events = RunWsEvents.toLLMEvents(
    new RunWsProtocol.ToolCall({
      type: "tool_call",
      tool_call_id: "c1",
      name: "read",
      arguments: { path: "a" },
    }),
  )

  expect(events.map((e) => e.type)).toEqual(["tool-input-start", "tool-call"])

  const call = events[1]
  if (call.type !== "tool-call") throw new Error("expected tool-call")
  expect(call.id).toBe("c1")
  expect(call.name).toBe("read")
  expect(call.input).toEqual({ path: "a" })
})

test("tool_call with JSON-string arguments is parsed for the rendered input", () => {
  const events = RunWsEvents.toLLMEvents(
    new RunWsProtocol.ToolCall({
      type: "tool_call",
      tool_call_id: "c2",
      name: "bash",
      arguments: '{"command":"echo hi"}',
    }),
  )
  const call = events[1]
  if (call.type !== "tool-call") throw new Error("expected tool-call")
  expect(call.input).toEqual({ command: "echo hi" })
})

test("assistant_message with content maps to text start/delta/end", () => {
  const events = RunWsEvents.toLLMEvents(
    new RunWsProtocol.AssistantMessage({
      type: "assistant_message",
      message: { role: "assistant", content: "hi" },
    }),
  )

  expect(events.map((e) => e.type)).toEqual(["text-start", "text-delta", "text-end"])

  const delta = events[1]
  if (delta.type !== "text-delta") throw new Error("expected text-delta")
  expect(delta.text).toBe("hi")
})

test("assistant_message frames with distinct ids produce distinct text-part ids", () => {
  // Each mid-run assistant message must render as its own block. The backend
  // keys them by llm_call_id; without distinct ids the renderer would overwrite
  // one text part instead of showing message-by-message progress.
  const first = RunWsEvents.toLLMEvents(
    new RunWsProtocol.AssistantMessage({ type: "assistant_message", id: "llm_a", message: { role: "assistant", content: "first" } }),
  )
  const second = RunWsEvents.toLLMEvents(
    new RunWsProtocol.AssistantMessage({ type: "assistant_message", id: "llm_b", message: { role: "assistant", content: "second" } }),
  )

  const idOf = (events: ReturnType<typeof RunWsEvents.toLLMEvents>) => {
    const start = events[0]
    if (start.type !== "text-start") throw new Error("expected text-start")
    return start.id
  }

  expect(idOf(first)).toBe("llm_a")
  expect(idOf(second)).toBe("llm_b")
  expect(idOf(first)).not.toBe(idOf(second))
})

test("assistant_message without an id falls back to a role-based id", () => {
  const events = RunWsEvents.toLLMEvents(
    new RunWsProtocol.AssistantMessage({ type: "assistant_message", message: { role: "assistant", content: "hi" } }),
  )
  const start = events[0]
  if (start.type !== "text-start") throw new Error("expected text-start")
  expect(start.id).toBe("msg-assistant")
})

test("assistant_message with empty content maps to no events", () => {
  expect(
    RunWsEvents.toLLMEvents(
      new RunWsProtocol.AssistantMessage({
        type: "assistant_message",
        message: { role: "assistant", content: "" },
      }),
    ),
  ).toEqual([])
})

test("assistant_message with missing content maps to no events", () => {
  expect(
    RunWsEvents.toLLMEvents(
      new RunWsProtocol.AssistantMessage({
        type: "assistant_message",
        message: { role: "assistant" },
      }),
    ),
  ).toEqual([])
})

test("run_completed completed maps to finish with reason stop", () => {
  const events = RunWsEvents.toLLMEvents(new RunWsProtocol.RunCompleted({ type: "run_completed", status: "completed" }))

  expect(events.map((e) => e.type)).toEqual(["finish"])

  const finish = events[0]
  if (finish.type !== "finish") throw new Error("expected finish")
  expect(finish.reason).toBe("stop")
})

test("run_completed max_iterations maps to finish with reason length", () => {
  const events = RunWsEvents.toLLMEvents(
    new RunWsProtocol.RunCompleted({ type: "run_completed", status: "max_iterations" }),
  )

  const finish = events[0]
  if (finish.type !== "finish") throw new Error("expected finish")
  expect(finish.reason).toBe("length")
})

test("run_completed disconnected maps to finish with reason unknown", () => {
  const events = RunWsEvents.toLLMEvents(
    new RunWsProtocol.RunCompleted({ type: "run_completed", status: "disconnected" }),
  )

  const finish = events[0]
  if (finish.type !== "finish") throw new Error("expected finish")
  expect(finish.reason).toBe("unknown")
})

test("error frame maps to provider-error with the detail message", () => {
  const events = RunWsEvents.toLLMEvents(new RunWsProtocol.ServerError({ type: "error", detail: "boom" }))

  expect(events.map((e) => e.type)).toEqual(["provider-error"])

  const error = events[0]
  if (error.type !== "provider-error") throw new Error("expected provider-error")
  expect(error.message).toBe("boom")
})

test("ready frame maps to no events", () => {
  expect(
    RunWsEvents.toLLMEvents(
      new RunWsProtocol.Ready({ type: "ready", session_id: "s1", run_id: "r1", step_run_id: "p1" }),
    ),
  ).toEqual([])
})

test("toolResultEvent builds a tool-result event", () => {
  const event = RunWsEvents.toolResultEvent("c1", "read", { ok: true })

  expect(event.type).toBe("tool-result")
  if (event.type !== "tool-result") throw new Error("expected tool-result")
  expect(event.id).toBe("c1")
  expect(event.name).toBe("read")
  expect(event.result).toEqual({ type: "json", value: { ok: true } })
})
