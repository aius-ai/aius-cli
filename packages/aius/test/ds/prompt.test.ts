import { describe, expect, test } from "bun:test"
import AIUS from "../../src/session/prompt/aius.txt"
import { SystemPrompt } from "../../src/session/system"

describe("AIUS prompt", () => {
  test("identifies as a data scientist, not a software engineer", () => {
    expect(AIUS).toMatch(/autonomous data scientist/)
    expect(AIUS).not.toMatch(/software engineering tasks/)
  })

  test("describes the pipeline stages", () => {
    expect(AIUS).toMatch(/context_build/)
    expect(AIUS).toMatch(/goal_review/)
    expect(AIUS).toMatch(/dashboards/)
  })

  test("requires goals to have measurable success criteria", () => {
    expect(AIUS).toMatch(/success criterion with a numeric target/i)
  })

  test("encodes tooling intent (result vs explainability)", () => {
    expect(AIUS).toMatch(/result\s+→/)
    expect(AIUS).toMatch(/explainability\s+→.*aiusfe/i)
  })

  test("forbids leaking the underlying model name", () => {
    expect(AIUS).toMatch(/Never disclose, name, or describe the underlying language model/)
  })

  test("commits to forward motion", () => {
    expect(AIUS).toMatch(/Forward motion is the rule/)
  })

  test("seed 42 is the determinism contract", () => {
    expect(AIUS).toMatch(/seeds 42/)
  })
})

describe("SystemPrompt.provider", () => {
  test("returns the unified AIUS prompt regardless of model id", () => {
    const fake = { api: { id: "openai/gpt-5" } } as any
    const out = SystemPrompt.provider(fake)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/autonomous data scientist/)

    const sonnet = { api: { id: "anthropic/claude-sonnet-4-5" } } as any
    expect(SystemPrompt.provider(sonnet)[0]).toBe(out[0])
  })
})
