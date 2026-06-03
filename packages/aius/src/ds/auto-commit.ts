import { $ } from "bun"
import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import * as Log from "@aius-ai/core/util/log"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { SessionStatus } from "@/session/status"
import { State } from "./state"
import { Stage } from "./stage"

const log = Log.create({ service: "ds-auto-commit" })

const SUBJECT_MAX = 60
const ENABLED_DEFAULT = true

const enabled = () => {
  const flag = process.env.AIUS_AUTOCOMMIT
  if (flag === undefined) return ENABLED_DEFAULT
  return flag !== "0" && flag.toLowerCase() !== "false"
}

const isGitRepo = async (dir: string) => {
  const r = await $`git rev-parse --git-dir`.cwd(dir).quiet().nothrow()
  return r.exitCode === 0
}

const dirtyPaths = async (dir: string): Promise<string[]> => {
  const r = await $`git status --porcelain`.cwd(dir).quiet().nothrow()
  if (r.exitCode !== 0) return []
  return r.text().split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
}

const groupForCommitBody = (paths: string[]) => {
  const groups: Record<string, string[]> = {}
  for (const p of paths) {
    const top = p.split("/")[0]
    const key = top.startsWith(".") ? top : `${top}/`
    if (!groups[key]) groups[key] = []
    groups[key].push(p)
  }
  return Object.entries(groups)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([group, files]) => `  ${group}: ${files.length} ${files.length === 1 ? "file" : "files"}`)
    .join("\n")
}

const buildSubject = (stage: Stage.StageName, hint?: string): string => {
  const stageLabel = Stage.describe(stage).label.toLowerCase()
  const trim = (hint ?? "").replace(/\s+/g, " ").trim()
  if (!trim) return `aius: ${stageLabel}`
  const body = trim.length > SUBJECT_MAX - stageLabel.length - 5 ? trim.slice(0, SUBJECT_MAX - stageLabel.length - 8) + "…" : trim
  return `aius: ${stageLabel} · ${body}`
}

export const commitOnce = async (projectRoot: string, hint?: string): Promise<{ committed: boolean; sha?: string; subject?: string }> => {
  if (!enabled()) return { committed: false }
  if (!(await isGitRepo(projectRoot))) return { committed: false }
  const dirty = await dirtyPaths(projectRoot)
  if (dirty.length === 0) return { committed: false }
  const state = (await State.exists(projectRoot)) ? await State.load(projectRoot).catch(() => undefined) : undefined
  const stage: Stage.StageName = state?.current_stage ?? "init"
  const subject = buildSubject(stage, hint)
  const body = groupForCommitBody(dirty)

  await $`git add -A`.cwd(projectRoot).quiet().nothrow()
  const message = `${subject}\n\n${body}\n`
  const commit = await $`git commit --no-verify --no-gpg-sign --quiet -m ${message}`.cwd(projectRoot).quiet().nothrow()
  if (commit.exitCode !== 0) return { committed: false, subject }

  const sha = (await $`git rev-parse --short HEAD`.cwd(projectRoot).quiet().nothrow()).text().trim()
  return { committed: true, sha, subject }
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly commit: (hint?: string) => Effect.Effect<{ committed: boolean; sha?: string; subject?: string }>
  readonly setHint: (hint: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@aius/DSAutoCommit") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const hintRef = yield* InstanceState.make(
      Effect.fn("DSAutoCommit.hint")(() => Effect.succeed({ current: undefined as string | undefined })),
    )

    const subscription = yield* InstanceState.make(
      Effect.fn("DSAutoCommit.subscribe")(function* (ctx) {
        yield* (yield* bus.subscribe(SessionStatus.Event.Idle)).pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              const h = yield* InstanceState.get(hintRef)
              const hint = h.current
              h.current = undefined
              const result = yield* Effect.promise(() =>
                commitOnce(ctx.directory, hint).catch(
                  () => ({ committed: false }) as Awaited<ReturnType<typeof commitOnce>>,
                ),
              )
              if (result.committed) {
                log.info("auto-commit", { sha: result.sha, subject: result.subject })
              }
            }),
          ),
          Effect.forkScoped,
        )
      }),
    )

    const init = Effect.fn("DSAutoCommit.init")(function* () {
      yield* InstanceState.get(subscription)
    })

    const commit = Effect.fn("DSAutoCommit.commit")(function* (hint?: string) {
      const ctx = yield* InstanceState.context
      return yield* Effect.promise(() => commitOnce(ctx.directory, hint))
    })

    const setHint = Effect.fn("DSAutoCommit.setHint")(function* (hint: string) {
      const h = yield* InstanceState.get(hintRef)
      h.current = hint
    })

    return Service.of({ init, commit, setHint })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(SessionStatus.defaultLayer))

export * as AutoCommit from "./auto-commit"
