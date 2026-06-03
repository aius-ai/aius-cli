import { Option, Schema } from "effect"

/**
 * Server → client frames for the backend-owned run loop over `WS /v1/runs/ws`.
 * Mirrors `../api/src/aius_api/api/run_ws.py`.
 */

export class Ready extends Schema.Class<Ready>("RunWsReady")({
  type: Schema.Literal("ready"),
  session_id: Schema.String,
  run_id: Schema.String,
  step_run_id: Schema.String,
}) {}

export class ToolCall extends Schema.Class<ToolCall>("RunWsToolCall")({
  type: Schema.Literal("tool_call"),
  tool_call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
}) {}

export class AssistantMessage extends Schema.Class<AssistantMessage>("RunWsAssistantMessage")({
  type: Schema.Literal("assistant_message"),
  // Unique per emitted message (the backend's llm_call_id) — keys the rendered
  // text part so a run's successive assistant messages show as distinct blocks
  // rather than overwriting one another. Optional for backward compatibility.
  id: Schema.optional(Schema.String),
  message: Schema.Struct({
    role: Schema.String,
    content: Schema.optional(Schema.Unknown),
  }),
}) {}

export class RunCompleted extends Schema.Class<RunCompleted>("RunWsRunCompleted")({
  type: Schema.Literal("run_completed"),
  status: Schema.Literals(["completed", "max_iterations", "disconnected"]),
  session_id: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.String),
}) {}

export class ServerError extends Schema.Class<ServerError>("RunWsError")({
  type: Schema.Literal("error"),
  detail: Schema.String,
}) {}

// Backend-generated session title (sent only when `start.generate_title` was set).
// Not an LLM event — the processor taps it straight to `Session.setTitle`. Title
// generation used to run client-side; it now lives in the backend so the client
// holds no model credentials.
export class Title extends Schema.Class<Title>("RunWsTitle")({
  type: Schema.Literal("title"),
  title: Schema.String,
}) {}

export const ServerFrame = Schema.Union([Ready, ToolCall, AssistantMessage, RunCompleted, ServerError, Title]).annotate({
  discriminator: "type",
  identifier: "RunWsServerFrame",
})
export type ServerFrame = Schema.Schema.Type<typeof ServerFrame>

export const decodeFrame = Schema.decodeUnknownOption(ServerFrame)

const decodeJsonArgs = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

/**
 * Tool-call `arguments` arrive as the raw OpenAI `function.arguments` value,
 * which is a JSON **string** (the backend forwards it verbatim — see
 * `../api/src/aius_api/orchestrator/run_loop.py`). Parse it to an object before
 * handing it to a tool's `execute` (which expects parsed input) or rendering it.
 * A non-string (already-parsed) or unparseable value is passed through as-is.
 */
export const parseArguments = (raw: unknown): unknown =>
  typeof raw === "string" ? Option.getOrElse(decodeJsonArgs(raw), () => raw) : raw

export * as RunWsProtocol from "./protocol"
