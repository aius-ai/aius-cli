import { expect, test } from "bun:test"
import { sanitizeTitle } from "@/session/processor"

// Tool-result titles are often built from LLM-supplied args and render in the
// TUI without the stripAnsi pass that tool OUTPUT gets — so they're sanitized at
// the store boundary against terminal escape injection.

const ESC = "\x1b"

test("strips ANSI color escape sequences from a title", () => {
  const out = sanitizeTitle(`read ${ESC}[31mDANGER${ESC}[0m file.txt`)
  expect(out).toBe("read DANGER file.txt")
  expect(out).not.toContain(ESC)
})

test("removes raw control characters (CR, NUL, C1)", () => {
  const out = sanitizeTitle("ab\rc\x00d\x9be")
  expect(out).toBe("abcde")
})

test("leaves a clean title untouched", () => {
  expect(sanitizeTitle("dashboard_render: churn-overview")).toBe("dashboard_render: churn-overview")
})

test("neutralizes a screen-clear injection payload", () => {
  // ESC[2J ESC[H would clear the screen + home the cursor if rendered raw.
  const out = sanitizeTitle(`ok${ESC}[2J${ESC}[Hspoofed`)
  expect(out).not.toContain(ESC)
  expect(out).toBe("okspoofed")
})
