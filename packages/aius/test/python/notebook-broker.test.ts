import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const BROKER = path.join(import.meta.dir, "../../src/python/broker.py")
const RUNTIME = ["nbformat>=5.10", "jupyter-client>=8.6", "ipykernel>=6.29", "nbclient>=0.10"]

// Build a throwaway venv with just the notebook runtime (no pandas etc — the
// flow test only runs trivial cells). Returns the python path, or null if the
// environment can't be built (offline / no uv|python3) so the test soft-skips.
const buildRuntime = async (dir: string, libs: readonly string[] = RUNTIME): Promise<string | null> => {
  const hasUv = (await $`command -v uv`.quiet().nothrow()).exitCode === 0
  if (hasUv) {
    if ((await $`uv venv ${path.join(dir, ".venv")}`.quiet().nothrow()).exitCode !== 0) return null
    const py = path.join(dir, ".venv", "bin", "python")
    if ((await $`uv pip install --python ${py} ${libs}`.quiet().nothrow()).exitCode !== 0) return null
    return py
  }
  if ((await $`python3 -m venv ${path.join(dir, ".venv")}`.quiet().nothrow()).exitCode !== 0) return null
  const py = path.join(dir, ".venv", "bin", "python")
  if ((await $`${py} -m pip install ${libs}`.quiet().nothrow()).exitCode !== 0) return null
  return py
}

class Broker {
  proc: ReturnType<typeof Bun.spawn>
  enc = new TextEncoder()
  dec = new TextDecoder()
  buf = ""
  iter: AsyncIterator<Uint8Array>
  constructor(py: string, cwd: string) {
    this.proc = Bun.spawn([py, BROKER], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    this.iter = (this.proc.stdout as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  }
  async call(method: string, params?: object, id = Math.floor(Math.random() * 1e6)): Promise<any> {
    const sink = this.proc.stdin as { write: (d: Uint8Array) => void; flush?: () => void }
    sink.write(this.enc.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"))
    sink.flush?.()
    while (true) {
      const nl = this.buf.indexOf("\n")
      if (nl !== -1) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (line) {
          const parsed = JSON.parse(line)
          if (parsed.id === id) return parsed
        }
        continue
      }
      const c = await this.iter.next()
      if (c.done) throw new Error("broker closed")
      this.buf += this.dec.decode(c.value, { stream: true })
    }
  }
  close() {
    try {
      this.proc.kill()
    } catch {}
  }
}

describe("notebook broker", () => {
  test(
    "init → add_code → run → run_all → artifacts",
    async () => {
      const dir = path.join(os.tmpdir(), "aius-nb-" + Math.random().toString(36).slice(2))
      await fs.mkdir(dir, { recursive: true })
      const py = await buildRuntime(dir)
      if (!py) {
        console.warn("notebook broker test skipped: could not build notebook runtime venv")
        await fs.rm(dir, { recursive: true, force: true })
        return
      }
      const nbPath = path.join(dir, "output", "notebooks", "smoke", "notebook.ipynb")
      const broker = new Broker(py, dir)
      try {
        expect((await broker.call("info")).result.status).toBe("ready")

        await broker.call("nb_init", { path: nbPath, title: "Smoke" })
        expect(await Bun.file(nbPath).exists()).toBe(true)
        expect((await fs.stat(path.join(dir, "output", "notebooks", "smoke", "artifacts"))).isDirectory()).toBe(true)

        await broker.call("nb_add_code", { path: nbPath, source: "x = 21" })
        const r1 = await broker.call("nb_run_last", { path: nbPath })
        expect(r1.result.had_error).toBe(false)

        await broker.call("nb_add_code", { path: nbPath, source: "print(x * 2)" })
        const r2 = await broker.call("nb_run_last", { path: nbPath })
        expect(r2.result.output).toContain("42")
        expect(r2.result.had_error).toBe(false)

        // artifact: write a file into the kernel cwd (artifacts/)
        await broker.call("nb_add_code", { path: nbPath, source: "open('out.txt','w').write('hi')" })
        await broker.call("nb_run_last", { path: nbPath })
        const arts = await broker.call("nb_artifacts", { path: nbPath })
        expect(arts.result.artifacts).toContain("out.txt")

        // error capture
        await broker.call("nb_add_code", { path: nbPath, source: "raise ValueError('boom')" })
        const err = await broker.call("nb_run_last", { path: nbPath })
        expect(err.result.had_error).toBe(true)
        expect(err.result.output).toContain("boom")

        // show_source lists all cells
        const src = await broker.call("nb_show_source", { path: nbPath })
        expect(src.result.cells.length).toBeGreaterThanOrEqual(5)

        await broker.call("nb_kernel_stop", { path: nbPath })
      } finally {
        broker.close()
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    180_000,
  )

  // Regression for the "Kernel died before replying to kernel_info" report:
  // a venv missing ipykernel (klient1_2's actual state) must surface the cause
  // (the kernel's stderr), not a bare death message.
  test(
    "a kernel that can't launch surfaces its stderr",
    async () => {
      const dir = path.join(os.tmpdir(), "aius-nokernel-" + Math.random().toString(36).slice(2))
      await fs.mkdir(dir, { recursive: true })
      // jupyter-client + nbformat let the broker boot and attempt a launch, but
      // WITHOUT ipykernel `python -m ipykernel_launcher` dies on startup.
      const py = await buildRuntime(dir, ["nbformat>=5.10", "jupyter-client>=8.6", "nbclient>=0.10"])
      if (!py) {
        console.warn("kernel-stderr test skipped: could not build venv")
        await fs.rm(dir, { recursive: true, force: true })
        return
      }
      const nbPath = path.join(dir, "output", "notebooks", "nokernel", "notebook.ipynb")
      const broker = new Broker(py, dir)
      try {
        expect((await broker.call("info")).result.status).toBe("ready")
        await broker.call("nb_init", { path: nbPath, title: "No kernel" })
        await broker.call("nb_add_code", { path: nbPath, source: "print(1)" })
        const res = await broker.call("nb_run_last", { path: nbPath, timeout: 30 })
        expect(res.error).toBeDefined()
        // The fix: the broker now includes the kernel's captured stderr.
        expect(res.error.message).toContain("Kernel stderr")
        expect(res.error.message.toLowerCase()).toContain("ipykernel")
      } finally {
        broker.close()
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
