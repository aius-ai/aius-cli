import { Schema } from "effect"

/**
 * A run-loop transport failure surfaced to the user. The run loop runs on the
 * server over `WS /v1/runs/ws`; when the socket can't be reached, is rejected,
 * or drops mid-run, this carries a clear, actionable message instead of the
 * connection silently ending (which previously looked like a frozen/looping
 * TUI). `kind` lets the renderer pick framing; `detail` is the user-facing text.
 *
 * - `unreachable` — the socket never opened (server down / wrong AIUS_API_URL).
 * - `rejected` — the server closed the handshake (code 1008): bad AIUS API key,
 *   or the server's run loop / agent injection is disabled. NOT retryable.
 * - `closed` — the socket dropped before the run finished (unexpected).
 * - `run` — the server reported the run loop itself failed (an `error` frame),
 *   e.g. a transient upstream-provider rejection. Retryable.
 */
export class RunWsConnectionError extends Schema.TaggedErrorClass<RunWsConnectionError>()("RunWsConnectionError", {
  kind: Schema.Literals(["unreachable", "rejected", "closed", "run"]),
  code: Schema.optional(Schema.Number),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

// Every transport/run failure is worth one or two automatic retries EXCEPT an
// auth/config rejection (1008) — re-running with the same bad key won't help.
export const isRetryable = (e: unknown): e is RunWsConnectionError =>
  e instanceof RunWsConnectionError && e.kind !== "rejected"

export * as RunWsErrors from "./errors"
