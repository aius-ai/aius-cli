import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Question } from "../../src/question"

describe("Question.Info danger flag", () => {
  const decodeInfo = Schema.decodeUnknownSync(Question.Info)

  test("Info accepts and preserves danger (the heavy-work confirmation flag)", () => {
    const info = decodeInfo({
      question: "AutoGluon will run for up to 4h, CPU-only. Run it?",
      header: "HEAVY WORK",
      options: [
        { label: "Cancel", description: "Don't run", recommended: true },
        { label: "Run for up to 4h", description: "Start the heavy job" },
      ],
      danger: true,
    })
    expect(info.danger).toBe(true)
  })

  test("danger defaults to undefined when omitted", () => {
    const info = decodeInfo({
      question: "Pick a path",
      header: "Path",
      options: [{ label: "A", description: "a" }],
    })
    expect(info.danger).toBeUndefined()
  })

  test("the LLM `question` tool param (Prompt) does NOT expose danger", () => {
    // danger is system-set; it must not be settable through the question tool.
    expect(Object.keys(Question.Prompt.fields)).not.toContain("danger")
    expect(Object.keys(Question.Info.fields)).toContain("danger")
  })
})
