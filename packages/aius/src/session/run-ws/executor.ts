import { type Tool as AITool, type ToolExecutionOptions } from "ai"
import { Effect, Schema } from "effect"
import { errorMessage } from "@/util/error"
import { parseArguments } from "./protocol"

/**
 * Raised when the backend asks the client to run a tool that isn't present in
 * the resolved tool map (or is present but exposes no `execute`). The typed
 * error keeps the failure matchable upstream; `RunWsClient.open` stringifies it
 * into the WS `tool_result` error payload.
 */
export class UnknownToolError extends Schema.TaggedErrorClass<UnknownToolError>()("RunWsUnknownToolError", {
  name: Schema.String,
}) {
  override get message() {
    return `No local tool named "${this.name}" is available to run.`
  }
}

/**
 * Adapt the `Record<string, AITool>` that `SessionTools.resolve` builds into the
 * `(name, args) => Effect<result>` callback `RunWsClient.open` expects. Each
 * backend `tool_call` frame names a tool and supplies args; we look the tool up,
 * build a valid `ToolExecutionOptions`, and run its AI SDK `execute`.
 *
 * `signal` and `messages` come from the run itself: the resolved tools build
 * their `Tool.Context` from `options.abortSignal`, so passing the run's signal
 * (rather than a throwaway one) lets cancellation propagate into a running tool
 * — without it a long-running tool keeps going after the session is cancelled.
 *
 * Returns whatever `execute` returns; selecting the WS-wire subset is the
 * processor's concern (Task 4).
 */
export const fromTools = (
  tools: Record<string, AITool>,
  signal: AbortSignal,
  messages: ToolExecutionOptions["messages"],
) =>
  Effect.fn("RunWsExecutor.execute")(function* (name: string, args: unknown) {
    const tool = tools[name]
    if (!tool?.execute) return yield* new UnknownToolError({ name })

    const options: ToolExecutionOptions = {
      toolCallId: crypto.randomUUID(),
      abortSignal: signal,
      messages,
    }
    // Arguments arrive as a JSON string from the wire; tools expect parsed input.
    // The `catch` surfaces the tool's REAL failure message (the resolved tools
    // `Effect.orDie`, so a rejection otherwise collapses to a generic
    // "error occurred in Effect.tryPromise") — RunWsClient reports it as the
    // tool_result error and renders it.
    return yield* Effect.tryPromise({
      try: () => Promise.resolve(tool.execute!(parseArguments(args), options)),
      catch: (e) => new Error(errorMessage(e)),
    })
  })

export * as RunWsExecutor from "./executor"
