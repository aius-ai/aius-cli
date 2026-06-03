import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import * as Log from "@aius-ai/core/util/log"
import { InstanceState } from "@/effect/instance-state"
import BROKER_SOURCE from "./broker.py" with { type: "text" }

const log = Log.create({ service: "notebook-broker" })

const BROKER_REL = "broker.py"
const PROTOCOL_TIMEOUT_MS = 30_000
const STARTUP_TIMEOUT_MS = 30_000

export const CellSource = Schema.Struct({
  cell_type: Schema.String,
  execution_count: Schema.NullOr(Schema.Number),
  source: Schema.String,
})
export type CellSource = Schema.Schema.Type<typeof CellSource>

export const RunResult = Schema.Struct({
  output: Schema.String,
  had_error: Schema.Boolean,
  artifacts: Schema.optional(Schema.Array(Schema.String)),
})
export type RunResult = Schema.Schema.Type<typeof RunResult>

// Broker returns { error } (as a normal result, not an RPC error) on bad input,
// otherwise the success fields — so every field past `error` is optional.
export const ProtocolMakeResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  strategy: Schema.optional(Schema.String),
  n_folds: Schema.optional(Schema.Number),
  metric: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.String),
  needs_proba: Schema.optional(Schema.Boolean),
  row_count: Schema.optional(Schema.Number),
  folds: Schema.optional(Schema.Array(Schema.Struct({ fold: Schema.Number, train: Schema.Number, test: Schema.Number }))),
})
export type ProtocolMakeResult = Schema.Schema.Type<typeof ProtocolMakeResult>

export const LeaderboardEntry = Schema.Struct({
  model: Schema.String,
  mean: Schema.Number,
  std: Schema.Number,
  folds: Schema.Array(Schema.Number),
})
export const ProtocolScoreResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  mean: Schema.optional(Schema.Number),
  std: Schema.optional(Schema.Number),
  folds: Schema.optional(Schema.Array(Schema.Number)),
  rank: Schema.optional(Schema.Number),
  n_models: Schema.optional(Schema.Number),
  leaderboard: Schema.optional(Schema.Array(LeaderboardEntry)),
})
export type ProtocolScoreResult = Schema.Schema.Type<typeof ProtocolScoreResult>

const RpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
const decodeResponse = Schema.decodeUnknownSync(RpcResponse)

const resolvePythonExe = async (projectRoot: string): Promise<string> => {
  const venvPy = path.join(projectRoot, ".venv", "bin", "python")
  if (await Bun.file(venvPy).exists()) return venvPy
  const venvPyWin = path.join(projectRoot, ".venv", "Scripts", "python.exe")
  if (await Bun.file(venvPyWin).exists()) return venvPyWin
  return "python3"
}

const ensureBrokerScript = async (projectRoot: string): Promise<string> => {
  const dest = path.join(projectRoot, ".aius", "kernels", BROKER_REL)
  await Bun.write(dest, BROKER_SOURCE)
  return dest
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
type SpawnedProc = ReturnType<typeof Bun.spawn>
type Session = { proc: SpawnedProc; pending: Map<number, Pending>; next: number; closed: boolean; encoder: TextEncoder }

const sink = (proc: SpawnedProc) =>
  proc.stdin as { write: (data: Uint8Array) => void | Promise<unknown>; flush?: () => unknown }

const callRaw = async (session: Session, method: string, params: unknown, timeoutMs = PROTOCOL_TIMEOUT_MS): Promise<unknown> => {
  if (session.closed) throw new Error("notebook broker is closed")
  const id = session.next++
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (session.pending.delete(id)) reject(new Error(`notebook broker call '${method}' timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    session.pending.set(id, { resolve, reject, timer })
    try {
      const target = sink(session.proc)
      target.write(session.encoder.encode(payload))
      target.flush?.()
    } catch (err) {
      clearTimeout(timer)
      session.pending.delete(id)
      reject(err as Error)
    }
  })
}

const createSession = async (projectRoot: string): Promise<Session> => {
  const python = await resolvePythonExe(projectRoot)
  const broker = await ensureBrokerScript(projectRoot)
  const proc = Bun.spawn([python, broker], {
    cwd: projectRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
  })
  const session: Session = { proc, pending: new Map(), next: 1, closed: false, encoder: new TextEncoder() }

  const pumpStdout = async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const decoded = decodeResponse(JSON.parse(line))
          const pend = session.pending.get(decoded.id)
          if (!pend) continue
          clearTimeout(pend.timer)
          session.pending.delete(decoded.id)
          if (decoded.error) pend.reject(new Error(`broker rpc error ${decoded.error.code}: ${decoded.error.message}`))
          else pend.resolve(decoded.result)
        } catch (err) {
          log.warn("broker emitted unparseable line", { line, err: String(err) })
        }
      }
    }
    session.closed = true
    for (const pend of session.pending.values()) {
      clearTimeout(pend.timer)
      pend.reject(new Error("notebook broker closed unexpectedly"))
    }
    session.pending.clear()
  }

  const pumpStderr = async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true }).trim()
      if (text) log.warn("broker stderr", { text })
    }
  }

  void pumpStdout()
  void pumpStderr()

  await Promise.race([
    callRaw(session, "info", {}, STARTUP_TIMEOUT_MS),
    new Promise((_r, reject) => setTimeout(() => reject(new Error(`notebook broker did not respond within ${STARTUP_TIMEOUT_MS}ms`)), STARTUP_TIMEOUT_MS)),
  ])
  return session
}

const closeSession = async (session: Session) => {
  if (session.closed) return
  try {
    await callRaw(session, "shutdown", {}, 5_000).catch(() => undefined)
  } finally {
    session.closed = true
    session.proc.kill()
  }
}

export interface Interface {
  readonly init: (notebookPath: string, title: string) => Effect.Effect<void>
  readonly addMarkdown: (notebookPath: string, text: string) => Effect.Effect<void>
  readonly addCode: (notebookPath: string, source: string) => Effect.Effect<void>
  readonly replaceLast: (notebookPath: string, source: string) => Effect.Effect<void>
  readonly deleteLast: (notebookPath: string) => Effect.Effect<void>
  readonly showSource: (notebookPath: string) => Effect.Effect<CellSource[]>
  readonly showOutput: (notebookPath: string, cellIndex?: number) => Effect.Effect<string>
  readonly runLast: (notebookPath: string, timeoutSeconds?: number) => Effect.Effect<RunResult>
  readonly runAll: (notebookPath: string, timeoutSeconds?: number) => Effect.Effect<RunResult>
  readonly kernelStop: (notebookPath: string) => Effect.Effect<void>
  readonly artifacts: (notebookPath: string) => Effect.Effect<string[]>
  readonly contextIngest: (root: string) => Effect.Effect<{ path: string; context_files: string[]; data_files: string[] }>
  readonly protocolMake: (params: {
    root: string
    goal_slug: string
    data_path: string
    target: string
    metric: string
    task?: string
    n_folds?: number
    seed?: number
    group_col?: string
    time_col?: string
  }) => Effect.Effect<ProtocolMakeResult>
  readonly protocolScore: (params: {
    root: string
    goal_slug: string
    model_name: string
    predictions?: Record<string, readonly number[]>
  }) => Effect.Effect<ProtocolScoreResult>
}

export class Service extends Context.Service<Service, Interface>()("@aius/Notebook") {}

const decodeRun = Schema.decodeUnknownSync(RunResult)
const decodeCells = Schema.decodeUnknownSync(Schema.Struct({ cells: Schema.Array(CellSource) }))
const decodeOut = Schema.decodeUnknownSync(Schema.Struct({ output: Schema.String }))
const decodeArtifacts = Schema.decodeUnknownSync(Schema.Struct({ artifacts: Schema.Array(Schema.String) }))
const decodeIngest = Schema.decodeUnknownSync(
  Schema.Struct({ path: Schema.String, context_files: Schema.Array(Schema.String), data_files: Schema.Array(Schema.String) }),
)
const decodeProtocolMake = Schema.decodeUnknownSync(ProtocolMakeResult)
const decodeProtocolScore = Schema.decodeUnknownSync(ProtocolScoreResult)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(
      Effect.fn("Notebook.acquire")(function* (ctx) {
        const session = yield* Effect.promise(() => createSession(ctx.directory))
        yield* Effect.addFinalizer(() => Effect.promise(() => closeSession(session)))
        return session
      }),
    )

    const call = <A>(method: string, params: unknown, decode: (u: unknown) => A, timeoutMs?: number) =>
      Effect.gen(function* () {
        const session = yield* InstanceState.get(state)
        const result = yield* Effect.promise(() => callRaw(session, method, params, timeoutMs))
        return decode(result)
      })

    const cellTimeout = (s?: number) => (s ?? 600) * 1000 + 5_000

    return Service.of({
      init: Effect.fn("Notebook.init")(function* (p: string, title: string) {
        yield* call("nb_init", { path: p, title }, () => undefined)
      }),
      addMarkdown: Effect.fn("Notebook.addMarkdown")(function* (p: string, text: string) {
        yield* call("nb_add_markdown", { path: p, text }, () => undefined)
      }),
      addCode: Effect.fn("Notebook.addCode")(function* (p: string, source: string) {
        yield* call("nb_add_code", { path: p, source }, () => undefined)
      }),
      replaceLast: Effect.fn("Notebook.replaceLast")(function* (p: string, source: string) {
        yield* call("nb_replace_last", { path: p, source }, () => undefined)
      }),
      deleteLast: Effect.fn("Notebook.deleteLast")(function* (p: string) {
        yield* call("nb_delete_last", { path: p }, () => undefined)
      }),
      showSource: Effect.fn("Notebook.showSource")(function* (p: string) {
        return [...(yield* call("nb_show_source", { path: p }, (u) => decodeCells(u).cells))]
      }),
      showOutput: Effect.fn("Notebook.showOutput")(function* (p: string, cellIndex?: number) {
        return yield* call("nb_show_output", { path: p, cell_index: cellIndex }, (u) => decodeOut(u).output)
      }),
      runLast: Effect.fn("Notebook.runLast")(function* (p: string, timeoutSeconds?: number) {
        return yield* call("nb_run_last", { path: p, timeout: timeoutSeconds ?? 600 }, decodeRun, cellTimeout(timeoutSeconds))
      }),
      runAll: Effect.fn("Notebook.runAll")(function* (p: string, timeoutSeconds?: number) {
        return yield* call("nb_run_all", { path: p, timeout: timeoutSeconds ?? 600 }, decodeRun, cellTimeout(timeoutSeconds))
      }),
      kernelStop: Effect.fn("Notebook.kernelStop")(function* (p: string) {
        yield* call("nb_kernel_stop", { path: p }, () => undefined)
      }),
      artifacts: Effect.fn("Notebook.artifacts")(function* (p: string) {
        return [...(yield* call("nb_artifacts", { path: p }, (u) => decodeArtifacts(u).artifacts))]
      }),
      contextIngest: Effect.fn("Notebook.contextIngest")(function* (root: string) {
        const r = yield* call("context_ingest", { root }, decodeIngest, 600_000)
        return { path: r.path, context_files: [...r.context_files], data_files: [...r.data_files] }
      }),
      protocolMake: Effect.fn("Notebook.protocolMake")(function* (params) {
        return yield* call("protocol_make", params, decodeProtocolMake, 600_000)
      }),
      protocolScore: Effect.fn("Notebook.protocolScore")(function* (params) {
        return yield* call("protocol_score", params, decodeProtocolScore, 600_000)
      }),
    })
  }),
)

export const defaultLayer = layer

export * as Notebook from "./notebook"
