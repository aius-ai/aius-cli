import { Cause, Effect, Queue, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { isRecord } from "@/util/record"
import { ServerFrame, decodeFrame } from "./protocol"
import { RunWsConnectionError } from "./errors"
import { isLoopbackOrSecure } from "@/util/transport"

export interface StartFrame {
  readonly messages: unknown
  readonly model?: string
  readonly agent?: string
  readonly session_id?: string
  readonly run_id?: string
  readonly step_run_id?: string
  // When set, the backend generates a session title from the first user message
  // and pushes a `title` server frame (best-effort). See protocol.ts `Title`.
  readonly generate_title?: boolean
}

export interface OpenInput {
  readonly url: string
  readonly token: string
  readonly start: StartFrame
  // Error channel is `unknown`: the executor may fail (e.g. unknown tool, or a
  // tool's own rejection). RunWsClient folds both channels and reports failures
  // as a `tool_result` with status "error".
  readonly execute: (name: string, args: unknown) => Effect.Effect<unknown, unknown>
  // Invoked after a local tool execution resolves (success OR failure),
  // alongside the `tool_result` sent to the server. Lets the processor surface
  // a synthetic `tool-result` / `tool-error` LLMEvent so local execution
  // renders through the same path. On failure, `result` is the error string.
  readonly onToolResult?: (toolCallId: string, name: string, result: unknown, status: "ok" | "error") => void
}

export interface Connection {
  readonly frames: Stream.Stream<ServerFrame, RunWsConnectionError>
}

/**
 * Open the backend run-loop socket: send the `auth` + `start` handshake, then
 * surface decoded server frames as a `Stream`. Each `tool_call` frame is run
 * locally via `input.execute(...)` (bridged back into Effect with context) and
 * answered with a `tool_result`. The stream ends on `run_completed`, `error`,
 * or socket close, and the socket is closed when the stream's scope ends.
 *
 * Mirrors the house WebSocket wiring in
 * `packages/llm/src/route/transport/websocket.ts`.
 */
export const open = Effect.fn("RunWsClient.open")(function* (input: OpenInput) {
  // Never send the AIUS bearer to an untrusted transport: require wss:// (TLS)
  // or a loopback host. A plaintext ws:// to a remote/redirected AIUS_API_URL
  // would leak the token. Not retryable — it's a config problem.
  if (!isLoopbackOrSecure(input.url))
    return yield* new RunWsConnectionError({
      kind: "rejected",
      detail: `Refusing to send credentials over an insecure connection to ${new URL(input.url).host}. Use an https:// AIUS_API_URL (wss) or a local server.`,
    })

  const bridge = yield* EffectBridge.make()
  const ws = new globalThis.WebSocket(input.url)
  yield* Effect.acquireRelease(Effect.succeed(ws), () =>
    Effect.sync(() => {
      if (ws.readyState !== globalThis.WebSocket.CLOSED && ws.readyState !== globalThis.WebSocket.CLOSING)
        ws.close(1000)
    }),
  )

  yield* waitOpen(ws, input.url)

  const frames = yield* Queue.bounded<ServerFrame, RunWsConnectionError | Cause.Done>(128)
  const send = (frame: unknown) => ws.send(JSON.stringify(frame))

  // Tracks whether the server delivered a terminal frame. If the socket then
  // closes (even abnormally), that's expected; an abnormal close WITHOUT a
  // terminal frame is a real failure we must surface, not swallow.
  let finished = false

  const onMessage = (event: MessageEvent) => {
    const decoded = decodeFrame(JSON.parse(String(event.data)))
    if (decoded._tag === "None") return
    const frame = decoded.value
    // A server `error` frame means the run loop itself failed (e.g. a transient
    // upstream-provider rejection). Surface it as a retryable failure rather
    // than rendering a dead-end "run failed" — the processor retries it.
    if (frame.type === "error") {
      Queue.failCauseUnsafe(
        frames,
        Cause.fail(new RunWsConnectionError({ kind: "run", detail: frame.detail || "The run failed on the server." })),
      )
      return
    }
    Queue.offerUnsafe(frames, frame)
    if (frame.type === "tool_call") {
      bridge.fork(
        input.execute(frame.name, frame.arguments).pipe(
          Effect.match({
            onSuccess: (result) => {
              // Server gets the model-facing output string; render gets the rich object.
              send({
                type: "tool_result",
                tool_call_id: frame.tool_call_id,
                result: isRecord(result) && typeof result.output === "string" ? result.output : result,
                status: "ok",
              })
              input.onToolResult?.(frame.tool_call_id, frame.name, result, "ok")
            },
            onFailure: (error) => {
              const detail = error instanceof Error ? error.message : String(error)
              send({
                type: "tool_result",
                tool_call_id: frame.tool_call_id,
                result: detail,
                status: "error",
              })
              input.onToolResult?.(frame.tool_call_id, frame.name, detail, "error")
            },
          }),
        ),
      )
    }
    if (frame.type === "run_completed") {
      finished = true
      Queue.endUnsafe(frames)
    }
  }
  // A normal close (1000/1005) or any close after a terminal frame ends the
  // stream cleanly. An abnormal close before completion is surfaced as a typed
  // error so the run renders a clear message instead of looking like it "just
  // stopped". 1008 is the server rejecting the handshake (bad key / run loop
  // disabled).
  const onClose = (event: CloseEvent) => {
    if (finished || event.code === 1000 || event.code === 1005) return Queue.endUnsafe(frames)
    const rejected = event.code === 1008
    Queue.failCauseUnsafe(
      frames,
      Cause.fail(
        new RunWsConnectionError({
          kind: rejected ? "rejected" : "closed",
          code: event.code,
          detail: rejected
            ? "The AIUS server rejected the run-loop connection (code 1008). Your AIUS API key may be invalid, or the server's run loop / agent injection is not enabled."
            : `The AIUS server connection closed unexpectedly (code ${event.code}) before the run finished.`,
        }),
      ),
    )
  }

  ws.addEventListener("message", onMessage)
  ws.addEventListener("close", onClose)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("close", onClose)
    }),
  )

  send({ type: "auth", token: input.token })
  send({ type: "start", ...input.start })

  return { frames: Stream.fromQueue(frames) } satisfies Connection
})

const waitOpen = (ws: globalThis.WebSocket, url: string) => {
  if (ws.readyState === globalThis.WebSocket.OPEN) return Effect.void
  return Effect.callback<void, RunWsConnectionError>((resume, signal) => {
    const cleanup = () => {
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onCloseBeforeOpen)
      signal.removeEventListener("abort", onAbort)
    }
    const unreachable = () =>
      new RunWsConnectionError({
        kind: "unreachable",
        detail: `Could not connect to the AIUS server at ${url}. Is the proxy running? Set AIUS_API_URL to point elsewhere.`,
      })
    const onAbort = () => {
      cleanup()
      if (ws.readyState !== globalThis.WebSocket.CLOSED && ws.readyState !== globalThis.WebSocket.CLOSING)
        ws.close(1000)
    }
    const onOpen = () => {
      cleanup()
      resume(Effect.void)
    }
    // A connect-time error or a close before the socket ever opens means the
    // server is unreachable — fail loudly rather than proceeding to send into a
    // dead socket (which previously surfaced as a silent hang).
    const onError = () => {
      cleanup()
      resume(Effect.fail(unreachable()))
    }
    const onCloseBeforeOpen = () => {
      cleanup()
      resume(Effect.fail(unreachable()))
    }
    ws.addEventListener("open", onOpen, { once: true })
    ws.addEventListener("error", onError, { once: true })
    ws.addEventListener("close", onCloseBeforeOpen, { once: true })
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export * as RunWsClient from "./client"
