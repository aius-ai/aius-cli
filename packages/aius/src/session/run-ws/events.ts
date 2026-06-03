import { type FinishReason, LLMEvent, ToolResultValue } from "@aius-ai/llm"
import { type ServerFrame, parseArguments } from "./protocol"

/**
 * Pure adapter from a single backend run-loop frame to zero-or-more
 * fine-grained `LLMEvent`s, so the existing renderer/projector consumes
 * backend COARSE frames unchanged.
 *
 * The backend does not stream text deltas — a whole assistant message becomes
 * a `text-start` + one `text-delta` + `text-end` triple.
 */
export function toLLMEvents(frame: ServerFrame): LLMEvent[] {
  if (frame.type === "tool_call")
    return [
      LLMEvent.toolInputStart({ id: frame.tool_call_id, name: frame.name }),
      LLMEvent.toolCall({ id: frame.tool_call_id, name: frame.name, input: parseArguments(frame.arguments) }),
    ]

  if (frame.type === "assistant_message") {
    const text = typeof frame.message.content === "string" ? frame.message.content : ""
    if (text.length === 0) return []
    const id = frame.id ?? `msg-${frame.message.role}`
    return [LLMEvent.textStart({ id }), LLMEvent.textDelta({ id, text }), LLMEvent.textEnd({ id })]
  }

  if (frame.type === "run_completed") return [LLMEvent.finish({ reason: finishReason(frame.status) })]

  if (frame.type === "error") return [LLMEvent.providerError({ message: frame.detail })]

  return []
}

export function toolResultEvent(toolCallId: string, name: string, result: unknown): LLMEvent {
  return LLMEvent.toolResult({ id: toolCallId, name, result: ToolResultValue.make(result) })
}

export function toolErrorEvent(toolCallId: string, name: string, message: string): LLMEvent {
  return LLMEvent.toolError({ id: toolCallId, name, message })
}

function finishReason(status: "completed" | "max_iterations" | "disconnected"): FinishReason {
  if (status === "completed") return "stop"
  if (status === "max_iterations") return "length"
  return "unknown"
}

export * as RunWsEvents from "./events"
