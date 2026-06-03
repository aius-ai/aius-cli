import { describe, expect, test } from "bun:test"
import { State } from "../../src/ds/state"

const iso = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString()

describe("State.timing", () => {
  test("sums non-HITL stage durations and excludes review-gate waits", () => {
    const base = State.initial("done")
    const state: State.ProjectState = {
      ...base,
      current_stage: "done",
      stages: {
        ...base.stages,
        context_build: { status: "complete", started_at: iso(0), completed_at: iso(60) }, // 60s active
        context_review: { status: "complete", started_at: iso(60), completed_at: iso(160) }, // 100s wait
        discovery: { status: "complete", started_at: iso(160), completed_at: iso(220) }, // 60s active
        goal_review: { status: "complete", started_at: iso(220), completed_at: iso(320) }, // 100s wait
        dashboards: { status: "complete", started_at: iso(320), completed_at: iso(350) }, // 30s active
      },
    }
    const t = State.timing(state)
    expect(t.activeMs).toBe(150_000)
    expect(t.waitingMs).toBe(200_000)
  })

  test("ignores stages missing a timestamp (skipped / in-progress / pending)", () => {
    const base = State.initial("done")
    const state: State.ProjectState = {
      ...base,
      stages: {
        ...base.stages,
        context_build: { status: "complete", started_at: iso(0), completed_at: iso(10) }, // 10s active
        cleaning: { status: "skipped" }, // no timestamps
        achieving_goals: { status: "running", started_at: iso(10) }, // no completed_at
      },
    }
    const t = State.timing(state)
    expect(t.activeMs).toBe(10_000)
    expect(t.waitingMs).toBe(0)
  })
})

describe("State.formatDuration", () => {
  test("formats hours, minutes, seconds", () => {
    expect(State.formatDuration(0)).toBe("0s")
    expect(State.formatDuration(38_000)).toBe("38s")
    expect(State.formatDuration(150_000)).toBe("2m 30s")
    expect(State.formatDuration(3_600_000)).toBe("1h 0m")
    expect(State.formatDuration(8_100_000)).toBe("2h 15m")
  })
})

describe("State.initial", () => {
  test("marks the starting stage running with a start time (so its duration is measurable)", () => {
    const s = State.initial("context_build")
    expect(s.stages.context_build.status).toBe("running")
    expect(s.stages.context_build.started_at).toBeDefined()
    expect(s.stages.init.status).toBe("complete")
  })
})
