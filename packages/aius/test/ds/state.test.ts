import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { State } from "../../src/ds/state"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-state-" + Math.random().toString(36).slice(2))
  await fs.mkdir(path.join(dir, ".aius"), { recursive: true })
  return dir
}

describe("State", () => {
  test("initial state starts at context_build (running) with init complete", () => {
    const s = State.initial()
    expect(s.current_stage).toBe("context_build")
    expect(s.stages.init.status).toBe("complete")
    // The starting stage is running with a start time so its duration is
    // measurable for the end-of-pipeline timing.
    expect(s.stages.context_build.status).toBe("running")
    expect(s.stages.context_build.started_at).toBeDefined()
    expect(s.schema_version).toBe(1)
  })

  test("save then load is roundtrip equal", async () => {
    const dir = await tmp()
    const initial = State.initial()
    await State.save(dir, initial)
    const loaded = await State.load(dir)
    expect(loaded.current_stage).toBe(initial.current_stage)
    expect(loaded.stages.init.status).toBe("complete")
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("advance walks the stage order", async () => {
    const dir = await tmp()
    await State.save(dir, State.initial())
    const a = await State.advance(dir)
    expect(a.current_stage).toBe("context_review")
    expect(a.stages.context_build.status).toBe("complete")
    expect(a.stages.context_review.status).toBe("running")
    const b = await State.advance(dir)
    expect(b.current_stage).toBe("discovery")
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("markFailed records a note", async () => {
    const dir = await tmp()
    await State.save(dir, State.initial())
    const failed = await State.markFailed(dir, "context_build", "missing context")
    expect(failed.stages.context_build.status).toBe("failed")
    expect(failed.stages.context_build.note).toBe("missing context")
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("exists returns false then true", async () => {
    const dir = await tmp()
    expect(await State.exists(dir)).toBe(false)
    await State.save(dir, State.initial())
    expect(await State.exists(dir)).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
