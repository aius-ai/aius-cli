import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Init } from "../../src/ds/init"
import { State } from "../../src/ds/state"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-advance-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const setup = async () => {
  const dir = await tmp()
  await Bun.write(path.join(dir, "context", "brief.md"), "# brief\n")
  await Bun.write(path.join(dir, "data", "rows.csv"), "id\n1\n")
  await Init.run({ projectRoot: dir, setupVenv: false })
  return dir
}

describe("State.advance pipeline walk", () => {
  test("walks through every stage in order", async () => {
    const dir = await setup()
    const stages = []
    let s = await State.load(dir)
    stages.push(s.current_stage)
    while (s.current_stage !== "done") {
      s = await State.advance(dir)
      stages.push(s.current_stage)
    }
    expect(stages).toEqual([
      "context_build",
      "context_review",
      "discovery",
      "discovery_review",
      "goal_extract",
      "goal_review",
      "cleaning",
      "achieving_goals",
      "dashboards",
      "done",
    ])
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("marks the previous stage complete on each advance", async () => {
    const dir = await setup()
    let s = await State.advance(dir)
    expect(s.stages.context_build.status).toBe("complete")
    expect(s.stages.context_review.status).toBe("running")

    s = await State.advance(dir)
    expect(s.stages.context_review.status).toBe("complete")
    expect(s.stages.discovery.status).toBe("running")
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
