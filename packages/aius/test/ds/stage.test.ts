import { describe, expect, test } from "bun:test"
import { Stage } from "../../src/ds/stage"

describe("Stage.next", () => {
  test("walks the order", () => {
    expect(Stage.next("init")).toBe("context_build")
    expect(Stage.next("context_build")).toBe("context_review")
    expect(Stage.next("context_review")).toBe("discovery")
    expect(Stage.next("goal_extract")).toBe("goal_review")
    expect(Stage.next("dashboards")).toBe("done")
    expect(Stage.next("done")).toBeUndefined()
  })
})

describe("Stage gating", () => {
  test("classifies HITL gates", () => {
    expect(Stage.isHITL("context_review")).toBe(true)
    expect(Stage.isHITL("discovery_review")).toBe(true)
    expect(Stage.isHITL("goal_review")).toBe(true)
    expect(Stage.isHITL("init")).toBe(false)
    expect(Stage.isHITL("cleaning")).toBe(false)
  })

  test("only goal_review is the hard gate", () => {
    expect(Stage.isHardGate("goal_review")).toBe(true)
    expect(Stage.isHardGate("context_review")).toBe(false)
    expect(Stage.isHardGate("discovery_review")).toBe(false)
  })
})

describe("Stage.describe", () => {
  test("hitl gates have callouts", () => {
    expect(Stage.describe("goal_review").callout).toMatch(/goals\.json/)
    expect(Stage.describe("context_review").callout).toMatch(/CONTEXT\.md/)
    expect(Stage.describe("discovery_review").callout).toMatch(/continue/i)
  })

  test("auto stages have no callout", () => {
    expect(Stage.describe("init").callout).toBeUndefined()
    expect(Stage.describe("achieving_goals").callout).toBeUndefined()
  })

  test("the achieving-goals stage is labelled 'Achieving goals'", () => {
    expect(Stage.describe("achieving_goals").label).toBe("Achieving goals")
  })
})
