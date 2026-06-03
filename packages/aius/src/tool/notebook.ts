import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Notebook } from "@/python/notebook"
import DESCRIPTION from "./notebook.txt"
import * as Tool from "./tool"

const SLUG_RE = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/

const notebookPath = (directory: string, slug: string) =>
  path.join(directory, "output", "notebooks", slug, "notebook.ipynb")

const requireSlug = (slug: string) => {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid notebook slug "${slug}" — use lowercase kebab-case (e.g. g1-viewability)`)
  }
}

const PREVIEW = 6_000
const preview = (s: string) => (s.length <= PREVIEW ? s : s.slice(0, PREVIEW) + `\n[… truncated ${s.length - PREVIEW} chars]`)

const NotebookCreate = Schema.Struct({
  slug: Schema.String.annotate({ description: "kebab-case notebook id; becomes output/notebooks/<slug>/notebook.ipynb" }),
  title: Schema.String.annotate({ description: "Title for the notebook's first markdown cell" }),
})

export const NotebookCreateTool = Tool.define(
  "notebook_create",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Create a new Jupyter notebook. " + DESCRIPTION,
      parameters: NotebookCreate,
      execute: (params: { slug: string; title: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          const p = notebookPath(ins.directory, params.slug)
          yield* nb.init(p, params.title)
          return {
            title: `notebook_create: ${params.slug}`,
            metadata: { slug: params.slug, path: path.relative(ins.directory, p) } as Record<string, unknown>,
            output: `Created \`${path.relative(ins.directory, p)}\`. Add cells with notebook_add_code / notebook_add_markdown, then notebook_run.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const SlugText = Schema.Struct({ slug: Schema.String, text: Schema.String.annotate({ description: "Markdown cell content" }) })

export const NotebookAddMarkdownTool = Tool.define(
  "notebook_add_markdown",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Append a markdown cell to a notebook.",
      parameters: SlugText,
      execute: (params: { slug: string; text: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          yield* nb.addMarkdown(notebookPath(ins.directory, params.slug), params.text)
          return { title: `+markdown: ${params.slug}`, metadata: {} as Record<string, unknown>, output: "Added markdown cell." }
        }).pipe(Effect.orDie),
    }
  }),
)

const SlugSource = Schema.Struct({ slug: Schema.String, source: Schema.String.annotate({ description: "Python source for the code cell" }) })

export const NotebookAddCodeTool = Tool.define(
  "notebook_add_code",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Append a code cell (does NOT execute — call notebook_run next).",
      parameters: SlugSource,
      execute: (params: { slug: string; source: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          yield* nb.addCode(notebookPath(ins.directory, params.slug), params.source)
          return { title: `+code: ${params.slug}`, metadata: {} as Record<string, unknown>, output: "Added code cell. Call notebook_run to execute it." }
        }).pipe(Effect.orDie),
    }
  }),
)

const SlugTimeout = Schema.Struct({
  slug: Schema.String,
  timeoutSeconds: Schema.optional(Schema.Number).annotate({ description: "Per-cell timeout, default 600" }),
})

const runResultOutput = (slug: string, kind: string, r: Notebook.RunResult) => {
  const sections = [r.had_error ? `Error in ${slug}:` : "", "```", preview(r.output), "```"].filter(Boolean)
  if (r.artifacts && r.artifacts.length > 0) sections.push(`artifacts/: ${r.artifacts.join(", ")}`)
  return {
    title: `${kind}: ${slug}${r.had_error ? " · error" : ""}`,
    metadata: { ok: !r.had_error, artifacts: r.artifacts ?? [] } as Record<string, unknown>,
    output: sections.join("\n"),
  }
}

export const NotebookRunTool = Tool.define(
  "notebook_run",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Execute the last code cell on the notebook's persistent kernel (state carries across cells).",
      parameters: SlugTimeout,
      execute: (params: { slug: string; timeoutSeconds?: number }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          const r = yield* nb.runLast(notebookPath(ins.directory, params.slug), params.timeoutSeconds)
          return runResultOutput(params.slug, "notebook_run", r)
        }).pipe(Effect.orDie),
    }
  }),
)

export const NotebookRunAllTool = Tool.define(
  "notebook_run_all",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Re-execute the whole notebook on a fresh kernel — final reproducibility check; embeds figures.",
      parameters: SlugTimeout,
      execute: (params: { slug: string; timeoutSeconds?: number }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          const r = yield* nb.runAll(notebookPath(ins.directory, params.slug), params.timeoutSeconds)
          return runResultOutput(params.slug, "notebook_run_all", r)
        }).pipe(Effect.orDie),
    }
  }),
)

export const NotebookReplaceLastTool = Tool.define(
  "notebook_replace_last",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Replace the last code cell's source (restarts the kernel on next run).",
      parameters: SlugSource,
      execute: (params: { slug: string; source: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          yield* nb.replaceLast(notebookPath(ins.directory, params.slug), params.source)
          return { title: `replace_last: ${params.slug}`, metadata: {} as Record<string, unknown>, output: "Replaced last code cell." }
        }).pipe(Effect.orDie),
    }
  }),
)

const SlugOnly = Schema.Struct({ slug: Schema.String })

export const NotebookDeleteLastTool = Tool.define(
  "notebook_delete_last",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Delete the last code cell (restarts the kernel on next run).",
      parameters: SlugOnly,
      execute: (params: { slug: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          yield* nb.deleteLast(notebookPath(ins.directory, params.slug))
          return { title: `delete_last: ${params.slug}`, metadata: {} as Record<string, unknown>, output: "Deleted last code cell." }
        }).pipe(Effect.orDie),
    }
  }),
)

export const NotebookShowTool = Tool.define(
  "notebook_show",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "List every cell in the notebook with type, execution count, and source.",
      parameters: SlugOnly,
      execute: (params: { slug: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          const cells = yield* nb.showSource(notebookPath(ins.directory, params.slug))
          const lines = cells.map((c, i) => {
            const ec = c.execution_count != null ? ` [ec=${c.execution_count}]` : ""
            return `[cell ${i}] ${c.cell_type}${ec}\n${c.source}`
          })
          return {
            title: `notebook_show: ${params.slug} (${cells.length} cells)`,
            metadata: { cells: cells.length } as Record<string, unknown>,
            output: lines.join("\n\n") || "(empty notebook)",
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const SlugCell = Schema.Struct({ slug: Schema.String, cellIndex: Schema.optional(Schema.Number) })

export const NotebookOutputTool = Tool.define(
  "notebook_output",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Show captured output for a cell (cellIndex) or the whole notebook.",
      parameters: SlugCell,
      execute: (params: { slug: string; cellIndex?: number }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          const out = yield* nb.showOutput(notebookPath(ins.directory, params.slug), params.cellIndex)
          return { title: `notebook_output: ${params.slug}`, metadata: {} as Record<string, unknown>, output: preview(out) }
        }).pipe(Effect.orDie),
    }
  }),
)

export const NotebookStopTool = Tool.define(
  "notebook_stop",
  Effect.gen(function* () {
    const nb = yield* Notebook.Service
    return {
      description: "Stop the persistent kernel for a notebook (frees memory; next run cold-starts).",
      parameters: SlugOnly,
      execute: (params: { slug: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          requireSlug(params.slug)
          const ins = yield* InstanceState.context
          yield* nb.kernelStop(notebookPath(ins.directory, params.slug))
          return { title: `notebook_stop: ${params.slug}`, metadata: {} as Record<string, unknown>, output: "Kernel stopped." }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as NotebookTools from "./notebook"
