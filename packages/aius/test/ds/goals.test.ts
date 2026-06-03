import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Goals } from "../../src/ds/goals"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-goals-" + Math.random().toString(36).slice(2))
  await fs.mkdir(path.join(dir, ".aius"), { recursive: true })
  return dir
}

const baseGoal = (overrides: Partial<Goals.Goal> = {}): Goals.Goal => ({
  id: "g1",
  slug: "predict-viewability",
  type: "modeling",
  title: "Predict viewability",
  outcome: "A calibrated classifier for ad viewability.",
  success_criteria: [
    { metric: "AUC", target: ">= 0.78", rationale: "Baseline target from brief" },
  ],
  data: { source: "data/raw/main.parquet", target: "viewable" },
  tooling: { intent: "result", primary: "sklearn:LogisticRegression" },
  deliverables: ["notebook", "dashboard"],
  ...overrides,
})

describe("Goals.save + load roundtrip", () => {
  test("encodes and decodes a valid goals file", async () => {
    const dir = await tmp()
    const goals: Goals.GoalsFile = { schema_version: 1, goals: [baseGoal()] }
    await Goals.save(dir, goals)
    const loaded = await Goals.load(dir)
    expect(loaded.goals.length).toBe(1)
    expect(loaded.goals[0].title).toBe("Predict viewability")
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("Goals.validate", () => {
  test("rejects empty goal list", () => {
    const errs = Goals.validate({ schema_version: 1, goals: [] })
    expect(errs.length).toBe(1)
    expect(errs[0].kind).toBe("no_goals")
  })

  test("rejects empty outcome", () => {
    const errs = Goals.validate({ schema_version: 1, goals: [baseGoal({ outcome: "   " })] })
    expect(errs.some((e) => e.kind === "missing_outcome")).toBe(true)
  })

  test("rejects missing success criteria", () => {
    const errs = Goals.validate({ schema_version: 1, goals: [baseGoal({ success_criteria: [] })] })
    expect(errs.some((e) => e.kind === "missing_success_criteria")).toBe(true)
  })

  test("rejects non-numeric success target", () => {
    const errs = Goals.validate({
      schema_version: 1,
      goals: [
        baseGoal({
          success_criteria: [{ metric: "fit", target: "looks good", rationale: "vibes" }],
        }),
      ],
    })
    expect(errs.some((e) => e.kind === "no_numeric_target")).toBe(true)
  })

  test("rejects duplicate ids and slugs", () => {
    const errs = Goals.validate({
      schema_version: 1,
      goals: [
        baseGoal({ id: "g1", slug: "a" }),
        baseGoal({ id: "g1", slug: "a" }),
      ],
    })
    expect(errs.some((e) => e.kind === "duplicate_id")).toBe(true)
    expect(errs.some((e) => e.kind === "duplicate_slug")).toBe(true)
  })

  test("rejects unknown and self-dependencies", () => {
    const errs = Goals.validate({
      schema_version: 1,
      goals: [
        baseGoal({ id: "g1", slug: "a", depends_on: ["g1"] }),
        baseGoal({ id: "g2", slug: "b", depends_on: ["ghost"] }),
      ],
    })
    expect(errs.some((e) => e.kind === "circular_dep")).toBe(true)
    expect(errs.some((e) => e.kind === "unknown_dep")).toBe(true)
  })

  test("accepts a well-formed goals file", () => {
    const errs = Goals.validate({
      schema_version: 1,
      goals: [
        baseGoal({ id: "g1", slug: "primary" }),
        baseGoal({
          id: "g2",
          slug: "explain",
          tooling: { intent: "explainability", primary: "aiusfe" },
          depends_on: ["g1"],
        }),
      ],
    })
    expect(errs).toEqual([])
  })
})

describe("Goals.explainValidation", () => {
  test("produces human-readable bullet list", () => {
    const text = Goals.explainValidation([
      { kind: "no_goals" },
      { kind: "missing_outcome", id: "g1" },
      { kind: "no_numeric_target", id: "g2", metric: "AUC" },
    ])
    expect(text).toMatch(/No goals defined/)
    expect(text).toMatch(/g1.*outcome is empty/)
    expect(text).toMatch(/g2.*AUC.*numeric comparator/)
  })
})
