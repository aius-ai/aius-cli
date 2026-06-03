import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const BROKER = path.join(import.meta.dir, "../../src/python/broker.py")

const buildVenv = async (dir: string): Promise<string | null> => {
  const libs = ["pandas", "pypdf"]
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

const call = async (py: string, cwd: string, method: string, params: object): Promise<any> => {
  const proc = Bun.spawn([py, BROKER], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  try {
    const sink = proc.stdin as { write: (d: Uint8Array) => void; flush?: () => void }
    sink.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"))
    sink.flush?.()
    const dec = new TextDecoder()
    let buf = ""
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      const nl = buf.indexOf("\n")
      if (nl !== -1) return JSON.parse(buf.slice(0, nl))
    }
    throw new Error("no response")
  } finally {
    proc.kill()
  }
}

describe("context_ingest", () => {
  test(
    "extracts full HTML text (baseline) + deep CSV profile",
    async () => {
      const dir = path.join(os.tmpdir(), "aius-ingest-" + Math.random().toString(36).slice(2))
      await fs.mkdir(path.join(dir, "context"), { recursive: true })
      await fs.mkdir(path.join(dir, "data", "raw"), { recursive: true })
      const py = await buildVenv(dir)
      if (!py) {
        console.warn("context_ingest test skipped: could not build venv")
        await fs.rm(dir, { recursive: true, force: true })
        return
      }
      try {
        // a long-ish HTML email with a baseline buried in a table
        await Bun.write(
          path.join(dir, "context", "mail.html"),
          "<html><head><style>x{}</style></head><body><p>hi</p>" +
            "<table><tr><td>RF baseline</td><td>MAE 0.1251 F1 0.82</td></tr></table>" +
            "<p>regards</p></body></html>",
        )
        await Bun.write(path.join(dir, "context", "notes.md"), "# Notes\nSee the email.")
        await Bun.write(path.join(dir, "data", "raw", "impressions.csv"), "id,viewable,cpm\n1,0,2.5\n2,1,3.0\n3,1,1.2\n")

        const res = await call(py, dir, "context_ingest", { root: dir })
        expect(res.result.context_files).toContain("mail.html")
        expect(res.result.data_files).toContain("impressions.csv")

        const ingest = await Bun.file(path.join(dir, "output", "context", "ingest.md")).text()
        // HTML stripped to text — baseline must survive
        expect(ingest).toContain("RF baseline")
        expect(ingest).toContain("MAE 0.1251")
        expect(ingest).not.toContain("<table>")
        // deep CSV profile — every column listed with dtype + null%
        expect(ingest).toContain("impressions.csv")
        expect(ingest).toContain("viewable")
        expect(ingest).toContain("cpm")
        expect(ingest).toMatch(/rows:\s*3/)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
