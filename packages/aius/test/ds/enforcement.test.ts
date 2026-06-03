import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Init } from "../../src/ds/init"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-enforce-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const hasPython3 = async () => (await $`command -v python3`.quiet().nothrow()).exitCode === 0

describe("pip physically blocked (hardenVenv)", () => {
  test("removes pip and blocks import pip / python -m pip", async () => {
    if (!(await hasPython3())) {
      console.warn("hardenVenv test skipped: python3 not available")
      return
    }
    const dir = await tmp()
    try {
      // python3 -m venv ships pip — the case that needs hardening
      const made = await $`python3 -m venv .venv`.cwd(dir).quiet().nothrow()
      if (made.exitCode !== 0) {
        console.warn("hardenVenv test skipped: venv creation failed")
        return
      }
      const pipBefore = await Bun.file(path.join(dir, ".venv", "bin", "pip")).exists()
      expect(pipBefore).toBe(true)

      await Init.hardenVenv(dir)

      expect(await Bun.file(path.join(dir, ".venv", "bin", "pip")).exists()).toBe(false)
      const py = path.join(dir, ".venv", "bin", "python")
      const imp = await $`${py} -c ${"import pip"}`.cwd(dir).quiet().nothrow()
      expect(imp.exitCode).not.toBe(0)
      expect(imp.stderr.toString()).toContain("Aius: installing packages is disabled")
      const mpip = await $`${py} -m pip --version`.cwd(dir).quiet().nothrow()
      expect(mpip.exitCode).not.toBe(0)
      const ensure = await $`${py} -m ensurepip`.cwd(dir).quiet().nothrow()
      expect(ensure.exitCode).not.toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
