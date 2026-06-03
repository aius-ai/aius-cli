import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const BROKER = path.join(import.meta.dir, "../../src/python/broker.py")

const buildVenv = async (dir: string): Promise<string | null> => {
  const libs = ["pandas", "scikit-learn", "numpy"]
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

describe("validation protocol", () => {
  test(
    "freezes folds + scores models identically + ranks the leaderboard",
    async () => {
      const dir = path.join(os.tmpdir(), "aius-vproto-" + Math.random().toString(36).slice(2))
      const slug = "demo-goal"
      await fs.mkdir(path.join(dir, "data", "processed"), { recursive: true })
      const py = await buildVenv(dir)
      if (!py) {
        console.warn("validation-protocol test skipped: could not build venv")
        await fs.rm(dir, { recursive: true, force: true })
        return
      }
      try {
        // 10 positives, 10 negatives so 5-fold stratification keeps both classes.
        let csv = "y,x\n"
        for (let i = 0; i < 20; i++) csv += `${i % 2},${(i % 2) + Math.random() * 0.01}\n`
        await Bun.write(path.join(dir, "data", "processed", "model.csv"), csv)

        // --- protocol_make ---
        const made = (
          await call(py, dir, "protocol_make", {
            root: dir,
            goal_slug: slug,
            data_path: "data/processed/model.csv",
            target: "y",
            metric: "roc_auc",
            n_folds: 5,
          })
        ).result
        expect(made.error).toBeUndefined()
        expect(made.metric).toBe("roc_auc")
        expect(made.direction).toBe("maximize")
        expect(made.n_folds).toBe(5)
        expect(made.folds).toHaveLength(5)

        const vdir = path.join(dir, "output", "validation", slug)
        expect(await Bun.file(path.join(vdir, "cv_plan.json")).exists()).toBe(true)
        expect(await Bun.file(path.join(vdir, "metric.json")).exists()).toBe(true)
        expect(await Bun.file(path.join(vdir, "scorer.py")).exists()).toBe(true)
        expect(await Bun.file(path.join(vdir, "description.md")).exists()).toBe(true)

        // Build per-fold predictions from the frozen ground truth.
        const perfect: Record<string, number[]> = {}
        const constant: Record<string, number[]> = {}
        for (let i = 0; i < 5; i++) {
          const gt = await Bun.file(path.join(vdir, "ground_truth", `fold_${i}.json`)).json()
          perfect[String(i)] = gt.y_true.map((v: number) => v) // predict the truth → AUC 1.0
          constant[String(i)] = gt.y_true.map(() => 0.5) // constant → AUC 0.5
        }

        // --- protocol_score: perfect model (inline predictions) ---
        const good = (
          await call(py, dir, "protocol_score", { root: dir, goal_slug: slug, model_name: "perfect", predictions: perfect })
        ).result
        expect(good.error).toBeUndefined()
        expect(good.mean).toBeCloseTo(1.0, 6)
        expect(good.rank).toBe(1)

        // --- protocol_score: constant model (read from disk) ---
        await Bun.write(path.join(vdir, "predictions", "weak.json"), JSON.stringify(constant))
        const bad = (await call(py, dir, "protocol_score", { root: dir, goal_slug: slug, model_name: "weak" })).result
        expect(bad.error).toBeUndefined()
        expect(bad.mean).toBeCloseTo(0.5, 6)

        // leaderboard ranks by direction (maximize) → perfect on top
        expect(bad.rank).toBe(2)
        expect(bad.leaderboard[0].model).toBe("perfect")
        expect(bad.n_models).toBe(2)

        // --- the standalone scorer.py reproduces the broker's score ---
        const out = await $`${py} ${path.join(vdir, "scorer.py")} ${path.join(vdir, "predictions", "perfect.json")}`
          .cwd(vdir)
          .quiet()
          .nothrow()
        expect(out.exitCode).toBe(0)
        expect(JSON.parse(out.stdout.toString()).mean).toBeCloseTo(1.0, 6)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )

  test(
    "rejects an unknown metric",
    async () => {
      const dir = path.join(os.tmpdir(), "aius-vproto-err-" + Math.random().toString(36).slice(2))
      await fs.mkdir(path.join(dir, "data", "processed"), { recursive: true })
      const py = await buildVenv(dir)
      if (!py) {
        console.warn("validation-protocol error test skipped: could not build venv")
        await fs.rm(dir, { recursive: true, force: true })
        return
      }
      try {
        await Bun.write(path.join(dir, "data", "processed", "model.csv"), "y,x\n0,1\n1,2\n")
        const res = (
          await call(py, dir, "protocol_make", {
            root: dir,
            goal_slug: "g",
            data_path: "data/processed/model.csv",
            target: "y",
            metric: "not_a_metric",
          })
        ).result
        expect(res.error).toMatch(/unknown metric/)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )
})
