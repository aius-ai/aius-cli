import { Effect } from "effect"
import { OpenAIChat } from "@aius-ai/llm/protocols/openai-chat"
import { LLMNative } from "@/session/llm/native-request"
import type { LLM } from "@/session/llm"

// The backend `/v1/runs/ws` forwards the `start` frame's `messages` array verbatim
// to OpenRouter, which expects OpenAI chat-completions wire format (assistant
// `tool_calls`, `tool`-role messages with `tool_call_id`). The client only holds
// ai-sdk `ModelMessage`s, so we reuse the canonical `@aius-ai/llm` lowering rather
// than hand-rolling the OpenAI shaping: `LLMNative.request` builds a canonical
// `LLMRequest` (system parts + messages) from the StreamInput, and
// `OpenAIChat.fromRequest` lowers that request to the OpenAI body — we keep only
// `body.messages`.
//
// `streamInput.system` is the dynamic context (env + instructions + skills +
// user.system); the static `aius.txt` agent prompt and tool schemas are injected
// by the backend via the agent name, so tools are deliberately omitted here.
export const toWireMessages = Effect.fn("RunWsWire.toWireMessages")(function* (streamInput: LLM.StreamInput) {
  const body = yield* OpenAIChat.fromRequest(
    LLMNative.request({
      model: streamInput.model,
      system: streamInput.system,
      messages: streamInput.messages,
    }),
  )
  // Anthropic (e.g. Sonnet 4.6) requires the conversation to END with a user or
  // tool turn — a trailing ASSISTANT message is treated as "prefill", which it
  // rejects with a 400 ("does not support assistant message prefill"). When a
  // run starts from a history that ends on the agent's own message, drop the
  // trailing assistant turn(s) so the request is valid.
  //
  // We DROP rather than inject a synthetic user "continue": injecting one would
  // fake the human-approval signal the DS review gates check for (advance_stage
  // / userSaidContinue), letting the agent self-advance past a gate. Dropping
  // keeps Anthropic happy without forging consent — the gate still waits for the
  // real Continue button. A history already ending in `tool`/`user` is untouched.
  const messages = [...body.messages]
  while (messages.length > 1 && messages[messages.length - 1]?.role === "assistant") messages.pop()
  return messages
})

export * as RunWsWire from "./wire"
