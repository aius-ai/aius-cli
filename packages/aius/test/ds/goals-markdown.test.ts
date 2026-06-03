import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Goals } from "../../src/ds/goals"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-goalsmd-" + Math.random().toString(36).slice(2))
  await fs.mkdir(path.join(dir, ".aius"), { recursive: true })
  await fs.mkdir(path.join(dir, "output"), { recursive: true })
  return dir
}

const goal = (over: Partial<Goals.Goal> = {}): Goals.Goal => ({
  id: "g1",
  slug: "app-viewability",
  type: "modeling",
  title: "App viewability model",
  outcome: "A calibrated classifier beating the RF baseline.",
  success_criteria: [{ metric: "MAE", target: "<= 0.1251", rationale: "beat the reported RF baseline" }],
  data: { source: "data/raw/app.parquet", target: "viewable" },
  tooling: { intent: "result", primary: "lightgbm:LGBMClassifier" },
  deliverables: ["notebook", "dashboard"],
  notes: "RF baseline MAE 0.1251 from the email.",
  ...over,
})

describe("Goals markdown", () => {
  test("save writes both goals.json and output/GOALS.md", async () => {
    const dir = await tmp()
    await Goals.save(dir, { schema_version: 1, goals: [goal()], generated_at: "2026-05-29T00:00:00Z" })
    expect(await Bun.file(Goals.goalsPath(dir)).exists()).toBe(true)
    const md = await Bun.file(Goals.markdownPath(dir)).text()
    expect(md).toContain("# Goals")
    expect(md).toContain("App viewability model")
    expect(md).toContain("| MAE | `<= 0.1251` |")
    expect(md).toContain("RF baseline MAE 0.1251")
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("markdown renders type, tooling, outcome and criteria table", () => {
    const md = Goals.toMarkdown({ schema_version: 1, goals: [goal()] })
    expect(md).toContain("**Type:** modeling")
    expect(md).toContain("**Tooling intent:** result")
    expect(md).toContain("**Outcome.**")
    expect(md).toContain("| metric | target | rationale |")
  })
})
