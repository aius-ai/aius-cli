import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Init } from "../../src/ds/init"
import { State } from "../../src/ds/state"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-init-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const seed = async (dir: string, layout: Record<string, string>) => {
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(dir, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await Bun.write(full, body)
  }
}

describe("Init.run", () => {
  test("hard-fails when context/ is missing", async () => {
    const dir = await tmp()
    await seed(dir, { "data/users.csv": "id,name\n1,a\n" })
    const result = await Init.run({ projectRoot: dir, setupVenv: false })
    expect(result.kind).toBe("missing-required")
    if (result.kind === "missing-required") {
      expect(result.which).toContain("context")
    }
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("hard-fails when data/ is missing", async () => {
    const dir = await tmp()
    await seed(dir, { "context/brief.md": "# brief\n" })
    const result = await Init.run({ projectRoot: dir, setupVenv: false })
    expect(result.kind).toBe("missing-required")
    if (result.kind === "missing-required") {
      expect(result.which).toContain("data")
    }
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("hard-fails when context/ is empty", async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, "context"), { recursive: true })
    await seed(dir, { "data/users.csv": "id,name\n1,a\n" })
    const result = await Init.run({ projectRoot: dir, setupVenv: false })
    expect(result.kind).toBe("missing-required")
    if (result.kind === "missing-required") {
      expect(result.which).toContain("context")
    }
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("scaffolds canonical layout on first run", async () => {
    const dir = await tmp()
    await seed(dir, {
      "context/brief.md": "# brief\n",
      "data/users.csv": "id,name\n1,a\n",
    })
    const result = await Init.run({ projectRoot: dir, setupVenv: false })
    expect(result.kind).toBe("ok")

    expect(await Bun.file(path.join(dir, ".aius", "project.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, ".gitignore")).exists()).toBe(true)
    expect((await fs.stat(path.join(dir, "output", "discovery"))).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(dir, "output", "notebooks"))).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(dir, "output", "models"))).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(dir, "output", "dashboards"))).isDirectory()).toBe(true)

    const state = await State.load(dir)
    expect(state.current_stage).toBe("context_build")

    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("migrates loose files at data/ root into data/raw/", async () => {
    const dir = await tmp()
    await seed(dir, {
      "context/brief.md": "# brief\n",
      "data/users.csv": "id\n1\n",
      "data/events.parquet": "fake-parquet-bytes",
    })

    await Init.run({ projectRoot: dir, setupVenv: false })

    expect(await Bun.file(path.join(dir, "data", "raw", "users.csv")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "data", "raw", "events.parquet")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "data", "users.csv")).exists()).toBe(false)
    expect((await fs.stat(path.join(dir, "data", "processed"))).isDirectory()).toBe(true)

    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("preserves existing data/raw/ without renaming", async () => {
    const dir = await tmp()
    await seed(dir, {
      "context/brief.md": "# brief\n",
      "data/raw/orig.csv": "id\n1\n",
      "data/random.csv": "id\n2\n",
    })

    await Init.run({ projectRoot: dir, setupVenv: false })

    expect(await Bun.file(path.join(dir, "data", "raw", "orig.csv")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "data", "random.csv")).exists()).toBe(true)

    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("non-canonical files trigger the confirm path", async () => {
    const dir = await tmp()
    await seed(dir, {
      "context/brief.md": "# brief\n",
      "data/users.csv": "id\n1\n",
      "stray_notes.txt": "hi",
    })

    const declined = await Init.run({ projectRoot: dir, setupVenv: false, confirmNonCanonical: async () => false })
    expect(declined.kind).toBe("non-canonical-present")

    const accepted = await Init.run({ projectRoot: dir, setupVenv: false, confirmNonCanonical: async () => true })
    expect(accepted.kind).toBe("ok")

    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("re-running on an initialized project is a no-op", async () => {
    const dir = await tmp()
    await seed(dir, {
      "context/brief.md": "# brief\n",
      "data/users.csv": "id\n1\n",
    })
    const first = await Init.run({ projectRoot: dir, setupVenv: false })
    expect(first.kind).toBe("ok")
    if (first.kind === "ok") expect(first.created).toBe(true)

    const second = await Init.run({ projectRoot: dir, setupVenv: false })
    expect(second.kind).toBe("ok")
    if (second.kind === "ok") expect(second.created).toBe(false)

    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("writes a .gitignore containing the venv and state entries", async () => {
    const dir = await tmp()
    await seed(dir, {
      "context/brief.md": "# brief\n",
      "data/users.csv": "id\n1\n",
    })
    await Init.run({ projectRoot: dir, setupVenv: false })
    const ig = await Bun.file(path.join(dir, ".gitignore")).text()
    expect(ig).toContain(".venv/")
    expect(ig).toContain(".aius/kernels/")
    expect(ig).toContain("__pycache__/")
    await $`chmod -R u+w ${dir}`.quiet().nothrow()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
