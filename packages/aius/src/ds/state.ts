import path from "path"
import { randomUUID } from "crypto"
import { Schema } from "effect"
import { Stage } from "./stage"

const STATE_FILENAME = "project.json"
const STATE_DIR = ".aius"
const SCHEMA_VERSION = 1

export const StageRecord = Schema.Struct({
  status: Stage.StageStatus,
  started_at: Schema.optional(Schema.String),
  completed_at: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
})
export type StageRecord = Schema.Schema.Type<typeof StageRecord>

export const ProjectState = Schema.Struct({
  schema_version: Schema.Literal(SCHEMA_VERSION),
  instance_id: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  current_stage: Stage.StageName,
  stages: Schema.Record(Stage.StageName, StageRecord),
})
export type ProjectState = Schema.Schema.Type<typeof ProjectState>

const decodeState = Schema.decodeUnknownSync(ProjectState)
const encodeState = Schema.encodeSync(ProjectState)

const now = () => new Date().toISOString()

const emptyStages = (): Record<Stage.StageName, StageRecord> => {
  const out: Partial<Record<Stage.StageName, StageRecord>> = {}
  for (const s of Stage.ORDER) out[s] = { status: "pending" }
  return out as Record<Stage.StageName, StageRecord>
}

export const initial = (current: Stage.StageName = "context_build"): ProjectState => {
  const ts = now()
  const stages = emptyStages()
  stages.init = { status: "complete", started_at: ts, completed_at: ts }
  // Mark the starting stage running with a start time. Without this the first
  // stage never gets a started_at (advance only stamps the *next* stage), so
  // its duration would be unmeasurable for the end-of-pipeline timing.
  if (current !== "init") stages[current] = { status: "running", started_at: ts }
  return {
    schema_version: SCHEMA_VERSION,
    instance_id: randomUUID(),
    created_at: ts,
    updated_at: ts,
    current_stage: current,
    stages,
  }
}

export const statePath = (projectRoot: string) => path.join(projectRoot, STATE_DIR, STATE_FILENAME)

export const exists = async (projectRoot: string) => Bun.file(statePath(projectRoot)).exists()

export const load = async (projectRoot: string): Promise<ProjectState> => {
  const raw = await Bun.file(statePath(projectRoot)).json()
  return decodeState(raw)
}

export const save = async (projectRoot: string, state: ProjectState): Promise<ProjectState> => {
  const next = { ...state, updated_at: now() }
  const file = statePath(projectRoot)
  await Bun.write(file, JSON.stringify(encodeState(next), null, 2) + "\n")
  return next
}

export const advance = async (projectRoot: string): Promise<ProjectState> => {
  const state = await load(projectRoot)
  const target = Stage.next(state.current_stage)
  if (!target) return state
  const ts = now()
  const stages = { ...state.stages }
  stages[state.current_stage] = { ...stages[state.current_stage], status: "complete", completed_at: ts }
  stages[target] = { ...stages[target], status: target === "done" ? "complete" : "running", started_at: ts }
  return save(projectRoot, { ...state, current_stage: target, stages })
}

// Advance forward to a target stage, marking the current stage complete and any
// stages skipped over as "skipped". Used to make the achieving-goals stage
// optional: a discovery-only / dashboards-only project jumps goal_review →
// dashboards.
export const advanceTo = async (projectRoot: string, target: Stage.StageName): Promise<ProjectState> => {
  const state = await load(projectRoot)
  const from = Stage.ORDER.indexOf(state.current_stage)
  const to = Stage.ORDER.indexOf(target)
  if (to <= from) return state
  const ts = now()
  const stages = { ...state.stages }
  stages[state.current_stage] = { ...stages[state.current_stage], status: "complete", completed_at: ts }
  for (let i = from + 1; i < to; i++) {
    const s = Stage.ORDER[i]
    stages[s] = { ...stages[s], status: "skipped" }
  }
  stages[target] = { ...stages[target], status: target === "done" ? "complete" : "running", started_at: ts }
  return save(projectRoot, { ...state, current_stage: target, stages })
}

export const markRunning = async (projectRoot: string, stage: Stage.StageName): Promise<ProjectState> => {
  const state = await load(projectRoot)
  const stages = { ...state.stages, [stage]: { ...state.stages[stage], status: "running" as const, started_at: now() } }
  return save(projectRoot, { ...state, current_stage: stage, stages })
}

export const markComplete = async (projectRoot: string, stage: Stage.StageName): Promise<ProjectState> => {
  const state = await load(projectRoot)
  const ts = now()
  const stages = { ...state.stages, [stage]: { ...state.stages[stage], status: "complete" as const, completed_at: ts } }
  return save(projectRoot, { ...state, stages })
}

export const markFailed = async (
  projectRoot: string,
  stage: Stage.StageName,
  note: string,
): Promise<ProjectState> => {
  const state = await load(projectRoot)
  const stages = { ...state.stages, [stage]: { ...state.stages[stage], status: "failed" as const, note } }
  return save(projectRoot, { ...state, stages })
}

// How long the pipeline actually worked, split from how long it sat waiting on
// the user. HITL review gates (context_review, discovery_review, goal_review)
// are decision-wait time and are NOT counted as active — "the time is not
// counted when the agent waits for a decision". Stages are contiguous (each
// advance stamps one stage's completed_at and the next's started_at from the
// same instant), so active = Σ non-HITL stage durations.
export const timing = (state: ProjectState): { activeMs: number; waitingMs: number } => {
  let activeMs = 0
  let waitingMs = 0
  for (const name of Stage.ORDER) {
    const rec = state.stages[name]
    if (!rec?.started_at || !rec?.completed_at) continue
    const ms = Date.parse(rec.completed_at) - Date.parse(rec.started_at)
    if (!Number.isFinite(ms) || ms <= 0) continue
    if (Stage.isHITL(name)) waitingMs += ms
    else activeMs += ms
  }
  return { activeMs, waitingMs }
}

// Compact human duration: "2h 14m" / "47m 3s" / "38s".
export const formatDuration = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export * as State from "./state"
