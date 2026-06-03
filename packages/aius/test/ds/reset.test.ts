import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Init } from "../../src/ds/init"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-reset-" + Math.random().toString(36).slice(2))
  await fs.mkdir(path.join(dir, "context"), { recursive: true })
  await fs.mkdir(path.join(dir, "data"), { recursive: true })
  // what the user provided
  await Bun.write(path.join(dir, "context", "brief.md"), "# Brief\nPredict churn.")
  await Bun.write(path.join(dir, "data", "customers.csv"), "id,churn\n1,0\n2,1\n")
  return dir
}

const exists = (p: string) => fs.access(p).then(() => true, () => false)

const commitAll = async (dir: string, msg: string) => {
  await $`git add -A`.cwd(dir).quiet().nothrow()
  await $`git -c user.email=a@b.c -c user.name=t -c commit.gpgsign=false commit --no-verify --quiet -m ${msg}`.cwd(dir).quiet().nothrow()
}

describe("Init.reset", () => {
  test("removes agent-generated CONTEXT.md but keeps user-provided context", async () => {
    const dir = await tmp()
    try {
      const status = await Init.run({ projectRoot: dir, setupVenv: false })
      expect(status.kind).toBe("ok")
      // baseline recorded as a git tag for a precise rollback
      expect((await $`git rev-parse -q --verify refs/tags/aius-baseline`.cwd(dir).quiet().nothrow()).exitCode).toBe(0)

      // simulate the agent: write CONTEXT.md (+ an output) and auto-commit
      await Bun.write(path.join(dir, "context", "CONTEXT.md"), "# Agent context\n...")
      await fs.mkdir(path.join(dir, "output", "discovery"), { recursive: true })
      await Bun.write(path.join(dir, "output", "discovery", "note.md"), "finding")
      await commitAll(dir, "aius: context")

      const summary = await Init.reset(dir)
      // the summary reports what moved back and what was stripped
      expect(summary.moved).toContain("customers.csv")
      expect(summary.removed).toContain(".aius")

      // agent artifact gone; user's brief restored, raw moved back to data/ root
      expect(await exists(path.join(dir, "context", "CONTEXT.md"))).toBe(false)
      expect(await exists(path.join(dir, "context", "brief.md"))).toBe(true)
      expect(await exists(path.join(dir, "data", "customers.csv"))).toBe(true)
      // scaffolding stripped
      for (const rel of [".aius", ".git", "output", path.join("data", "raw"), path.join("data", "processed")]) {
        expect(await exists(path.join(dir, rel))).toBe(false)
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("leaves data/raw writable after init (no OS lock)", async () => {
    const dir = await tmp()
    try {
      await Init.run({ projectRoot: dir, setupVenv: false })
      // the user must still be able to edit their own raw inputs
      const raw = path.join(dir, "data", "raw", "customers.csv")
      expect(await Bun.file(raw).exists()).toBe(true)
      const w = await $`sh -c ${"echo edited >> " + raw}`.quiet().nothrow()
      expect(w.exitCode).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
