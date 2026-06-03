import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AutoCommit } from "../../src/ds/auto-commit"
import { Init } from "../../src/ds/init"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-autocommit-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const setupGitProject = async () => {
  const dir = await tmp()
  await Bun.write(path.join(dir, "context", "brief.md"), "# brief\n")
  await Bun.write(path.join(dir, "data", "users.csv"), "id,name\n1,a\n")
  await Init.run({ projectRoot: dir, setupVenv: false })
  // Init.run already lands a baseline commit; just set a local identity so the
  // AutoCommit-under-test uses a known author.
  await $`git config user.email "test@aius.test"`.cwd(dir).quiet()
  await $`git config user.name "Aius Test"`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  return dir
}

describe("AutoCommit.commitOnce", () => {
  test("no-op when working tree is clean", async () => {
    const dir = await setupGitProject()
    const result = await AutoCommit.commitOnce(dir)
    expect(result.committed).toBe(false)
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("commits dirty paths and tags subject with current stage", async () => {
    const dir = await setupGitProject()
    await Bun.write(path.join(dir, "context", "CONTEXT.md"), "# project context\n")
    const result = await AutoCommit.commitOnce(dir, "wrote context")
    expect(result.committed).toBe(true)
    expect(result.subject).toMatch(/aius: reading the brief/)
    expect(result.subject).toMatch(/wrote context/)
    expect(result.sha).toMatch(/^[a-f0-9]{7,}$/)

    const log = (await $`git log -1 --pretty=%B`.cwd(dir).quiet()).text()
    expect(log).toMatch(/aius: reading the brief/)
    expect(log).toMatch(/context\/:.*1 file/)

    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("respects AIUS_AUTOCOMMIT=0", async () => {
    const dir = await setupGitProject()
    await Bun.write(path.join(dir, "context", "CONTEXT.md"), "# project\n")
    const prior = process.env.AIUS_AUTOCOMMIT
    process.env.AIUS_AUTOCOMMIT = "0"
    try {
      const result = await AutoCommit.commitOnce(dir)
      expect(result.committed).toBe(false)
    } finally {
      if (prior === undefined) delete process.env.AIUS_AUTOCOMMIT
      else process.env.AIUS_AUTOCOMMIT = prior
    }
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("groups commit body by top-level directory", async () => {
    const dir = await setupGitProject()
    // Use tracked locations only — data/raw, data/processed and *.parquet are
    // gitignored (heavy data stays out of history).
    await Bun.write(path.join(dir, "context", "CONTEXT.md"), "ctx\n")
    await Bun.write(path.join(dir, ".aius", "goals.json"), "{}\n")
    await Bun.write(path.join(dir, "output", "discovery", "01-test", "observation.md"), "obs\n")
    const result = await AutoCommit.commitOnce(dir)
    expect(result.committed).toBe(true)
    const log = (await $`git log -1 --pretty=%B`.cwd(dir).quiet()).text()
    expect(log).toMatch(/context\/:/)
    expect(log).toMatch(/\.aius\/?:/)
    expect(log).toMatch(/output\/:/)
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("no-op when directory is not a git repo", async () => {
    const dir = await tmp()
    await Bun.write(path.join(dir, "anything.txt"), "hi")
    const result = await AutoCommit.commitOnce(dir)
    expect(result.committed).toBe(false)
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
