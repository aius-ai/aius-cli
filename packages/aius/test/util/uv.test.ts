import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { resolveUv } from "../../src/util/uv"

const tmp = async () => {
  const dir = path.join(os.tmpdir(), "aius-uv-" + Math.random().toString(36).slice(2))
  await fs.mkdir(path.join(dir, "bin"), { recursive: true })
  return dir
}

describe("resolveUv", () => {
  test("prefers a uv bundled next to the Aius executable", async () => {
    const dir = await tmp()
    const aius = path.join(dir, "bin", "aius")
    const uv = path.join(dir, "bin", "uv")
    await Bun.write(aius, "#!/bin/sh\n")
    await Bun.write(uv, "#!/bin/sh\n")
    expect(await resolveUv(aius)).toBe(uv)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("does NOT treat a sibling of dev `bun` as bundled", async () => {
    const dir = await tmp()
    const bun = path.join(dir, "bin", "bun")
    const uv = path.join(dir, "bin", "uv")
    await Bun.write(bun, "#!/bin/sh\n")
    await Bun.write(uv, "#!/bin/sh\n")
    // execPath is `bun` (dev), not the Aius binary → the sibling uv must NOT be
    // taken as bundled (it'd coincidentally match e.g. a brew uv next to bun).
    expect(await resolveUv(bun)).not.toBe(uv)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
