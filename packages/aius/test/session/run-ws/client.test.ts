import { expect, test, beforeAll, afterAll } from "bun:test"
import { Effect, Stream } from "effect"
import { RunWsClient } from "@/session/run-ws/client"
import { RunWsConnectionError, RunWsErrors } from "@/session/run-ws/errors"

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
          ws.send(JSON.stringify({ type: "tool_call", tool_call_id: "c1", name: "read", arguments: { path: "a.txt" } }))
        }
        if (m.type === "tool_result") {
          expect(m.tool_call_id).toBe("c1")
          ws.send(JSON.stringify({ type: "assistant_message", message: { role: "assistant", content: "done" } }))
          ws.send(JSON.stringify({ type: "run_completed", status: "completed" }))
        }
      },
    },
  })
})
afterAll(() => server.stop(true))

test("RunWsClient handshakes, surfaces frames, round-trips a tool result", async () => {
  const url = `ws://localhost:${server.port}/v1/runs/ws`
  const frames = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RunWsClient.open({
          url,
          token: "secret",
          start: { messages: [{ role: "user", content: "hi" }], model: "openai/gpt-4o", agent: "build" },
          execute: (name) => Effect.succeed({ output: `ran ${name}`, ok: true }),
        })
        return yield* Stream.runCollect(client.frames)
      }),
    ),
  )
  const types = [...frames].map((f) => f.type)
  expect(types).toEqual(["ready", "tool_call", "assistant_message", "run_completed"])
})

// A 1008 close (server rejecting the handshake — bad key / run loop disabled)
// before any terminal frame must surface as a clear error, not a clean end.
test("a 1008 close surfaces as RunWsConnectionError(kind=rejected)", async () => {
  const rejectServer = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        if (JSON.parse(String(raw)).type === "start") ws.close(1008, "policy")
      },
    },
  })
  const err = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RunWsClient.open({
          url: `ws://localhost:${rejectServer.port}/v1/runs/ws`,
          token: "bad",
          start: { messages: [{ role: "user", content: "hi" }] },
          execute: () => Effect.succeed({}),
        })
        return yield* Stream.runCollect(client.frames)
      }),
    ).pipe(Effect.flip),
  )
  rejectServer.stop(true)
  expect(err).toBeInstanceOf(RunWsConnectionError)
  expect(err.kind).toBe("rejected")
  expect(err.message).toContain("rejected")
})

// A server `error` frame (the run loop failed, e.g. a transient upstream
// rejection) must surface as a RETRYABLE failure, not a clean stream end.
test("a server error frame surfaces as a retryable RunWsConnectionError(kind=run)", async () => {
  const errServer = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        if (JSON.parse(String(raw)).type === "start") ws.send(JSON.stringify({ type: "error", detail: "run failed" }))
      },
    },
  })
  const err = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RunWsClient.open({
          url: `ws://localhost:${errServer.port}/v1/runs/ws`,
          token: "x",
          start: { messages: [{ role: "user", content: "hi" }] },
          execute: () => Effect.succeed({}),
        })
        return yield* Stream.runCollect(client.frames)
      }),
    ).pipe(Effect.flip),
  )
  errServer.stop(true)
  expect(err).toBeInstanceOf(RunWsConnectionError)
  expect(err.kind).toBe("run")
  expect(RunWsErrors.isRetryable(err)).toBe(true)
})

// Security: never send the AIUS bearer over plaintext ws:// to a remote host.
test("refuses an insecure remote ws:// URL (does not send credentials)", async () => {
  const err = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RunWsClient.open({
          url: "ws://evil.example:8000/v1/runs/ws",
          token: "secret",
          start: { messages: [{ role: "user", content: "hi" }] },
          execute: () => Effect.succeed({}),
        })
        return yield* Stream.runCollect(client.frames)
      }),
    ).pipe(Effect.flip),
  )
  expect(err).toBeInstanceOf(RunWsConnectionError)
  expect(err.kind).toBe("rejected")
  expect(RunWsErrors.isRetryable(err)).toBe(false)
})

// Connecting to a server that isn't there must fail loudly, not hang silently.
test("an unreachable server surfaces as RunWsConnectionError(kind=unreachable)", async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("x") })
  const deadPort = probe.port
  probe.stop(true)
  const err = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RunWsClient.open({
          url: `ws://localhost:${deadPort}/v1/runs/ws`,
          token: "x",
          start: { messages: [{ role: "user", content: "hi" }] },
          execute: () => Effect.succeed({}),
        })
        return yield* Stream.runCollect(client.frames)
      }),
    ).pipe(Effect.flip),
  )
  expect(err).toBeInstanceOf(RunWsConnectionError)
  expect(err.kind).toBe("unreachable")
})
