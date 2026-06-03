import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { State } from "../../src/ds/state"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-advto-" + Math.random().toString(36).slice(2))
  await fs.mkdir(path.join(dir, ".aius"), { recursive: true })
  return dir
}

describe("State.advanceTo (achieving-goals optional)", () => {
  test("jumps goal_review → dashboards, marking cleaning+achieving_goals skipped", async () => {
    const dir = await tmp()
    // walk to goal_review
    let s = State.initial("goal_review")
    s = { ...s, stages: { ...s.stages, goal_review: { status: "running" } } }
    await State.save(dir, s)

    const jumped = await State.advanceTo(dir, "dashboards")
    expect(jumped.current_stage).toBe("dashboards")
    expect(jumped.stages.goal_review.status).toBe("complete")
    expect(jumped.stages.cleaning.status).toBe("skipped")
    expect(jumped.stages.achieving_goals.status).toBe("skipped")
    expect(jumped.stages.dashboards.status).toBe("running")
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("no-op when target is not ahead", async () => {
    const dir = await tmp()
    await State.save(dir, State.initial("achieving_goals"))
    const r = await State.advanceTo(dir, "discovery")
    expect(r.current_stage).toBe("achieving_goals")
    await fs.rm(dir, { recursive: true, force: true })
  })
})
