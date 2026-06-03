import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import { State } from "@/ds/state"
import { Stage } from "@/ds/stage"

const VISIBLE: readonly Stage.StageName[] = [
  "context_build",
  "context_review",
  "discovery",
  "discovery_review",
  "goal_extract",
  "goal_review",
  "cleaning",
  "achieving_goals",
  "dashboards",
]

const loadStage = async (directory: string): Promise<State.ProjectState | undefined> => {
  if (!directory) return undefined
  if (!(await State.exists(directory))) return undefined
  return State.load(directory).catch(() => undefined)
}

export function StageStrip(props: { revision?: unknown }) {
  const { theme } = useTheme()
  const project = useProject()
  const sync = useSync()
  const route = useRoute()
  const [state, setState] = createSignal<State.ProjectState | undefined>(undefined)

  const refresh = async () => {
    const dir = project.instance.path().directory
    setState(await loadStage(dir))
  }

  createEffect(() => {
    void refresh()
  })

  createEffect(
    on(
      () => props.revision,
      () => {
        void refresh()
      },
      { defer: true },
    ),
  )

  // The agent advances stages mid-turn (one long assistant message, many tool
  // calls), so message-count changes alone miss most transitions. Poll the
  // small project.json on a short interval so the strip tracks the live stage.
  const poll = setInterval(() => void refresh(), 1200)
  onCleanup(() => clearInterval(poll))

  const current = () => state()?.current_stage
  const stages = () => state()?.stages

  // Once the pipeline reaches `done`, surface the total active time — wall-clock
  // minus the time spent waiting at review gates (see State.timing).
  const doneTiming = () => {
    const s = state()
    return s?.current_stage === "done" ? State.timing(s) : undefined
  }

  const tokenFor = (stage: Stage.StageName) => {
    const s = stages()?.[stage]?.status ?? "pending"
    const isCurrent = current() === stage
    if (isCurrent && Stage.isHardGate(stage)) {
      return { ch: "▣", fg: theme.accent }
    }
    if (isCurrent && Stage.isHITL(stage)) {
      return { ch: "▣", fg: theme.secondary }
    }
    if (isCurrent) return { ch: "▣", fg: theme.primary }
    if (s === "complete") return { ch: "■", fg: theme.primary }
    if (s === "failed") return { ch: "✕", fg: theme.error }
    if (s === "running") return { ch: "▤", fg: theme.secondary }
    return { ch: "□", fg: theme.textMuted }
  }

  const callout = () => {
    const s = current()
    if (!s) return undefined
    const meta = Stage.describe(s)
    return meta.callout
  }

  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)

  const trim = (s: string, max = 64) => {
    const cleaned = s.replace(/\s+/g, " ").trim()
    return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned
  }

  const basename = (p: string) => {
    const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
    return idx === -1 ? p : p.slice(idx + 1)
  }

  const firstWord = (cmd: string) => cmd.trim().split(/\s+/, 1)[0]

  const describeBash = (cmd: string): string => {
    const c = cmd.trim()
    const verb = firstWord(c)
    if (/^find\b/.test(c)) return `Searching the filesystem`
    if (/^grep\b/.test(c) || /^rg\b/.test(c)) return `Grepping for a pattern`
    if (/^cat\b/.test(c)) {
      const target = c.replace(/^cat\s+/, "").split(/\s+/, 1)[0]
      return `Reading ${basename(target) || "a file"}`
    }
    if (/^head\b|^tail\b/.test(c)) {
      const target = c.split(/\s+/).filter((x) => !x.startsWith("-"))[1] ?? ""
      return `Sampling ${basename(target) || "a file"}`
    }
    if (/^ls\b/.test(c)) return `Listing files`
    if (/^pdftotext\b/.test(c)) return `Extracting text from a PDF`
    if (/python\b/.test(c) && /-c\b/.test(c)) return `Probing the Python venv`
    if (/^uv\s+pip\s+install\b|^pip\s+install\b/.test(c)) return `Installing Python packages`
    if (/^git\b/.test(c)) return `Running git`
    if (/^mv\b/.test(c)) return `Moving files`
    if (/^cp\b/.test(c)) return `Copying files`
    if (/^mkdir\b/.test(c)) return `Creating a directory`
    if (/^rm\b/.test(c)) return `Removing files`
    return `Running ${verb}`
  }

  const describePython = (code: string): string => {
    const lines = code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    const first = lines[0] ?? ""
    if (/^import\b|^from\b/.test(first)) return "Loading Python modules"
    if (/\.read_csv\(|\.read_parquet\(|\.read_excel\(|\.read_json\(/.test(code)) return "Loading a dataset"
    if (/\.fit\(|\.train\(/.test(code)) return "Training a model"
    if (/\.predict\(|\.score\(|\.predict_proba\(/.test(code)) return "Scoring a model"
    if (/cross_validate\(|cross_val_score\(/.test(code)) return "Running cross-validation"
    if (/\.value_counts\(\)|\.describe\(\)|\.info\(\)|\.dtypes/.test(code)) return "Profiling the dataset"
    if (/\.to_parquet\(|\.to_csv\(/.test(code)) return "Saving a processed snapshot"
    if (/plt\.|matplotlib/.test(code)) return "Plotting a figure"
    return trim(first || "Running Python")
  }

  const describeTool = (tool: string, input: Record<string, any>): string => {
    switch (tool) {
      case "bash":
        return describeBash(String(input.command ?? ""))
      case "notebook_create":
        return `Creating notebook ${input.slug ?? ""}`
      case "notebook_add_code":
        return describePython(String(input.source ?? ""))
      case "notebook_add_markdown":
        return `Writing notes in ${input.slug ?? "notebook"}`
      case "notebook_run":
        return `Running a cell in ${input.slug ?? "notebook"}`
      case "notebook_run_all":
        return `Re-running ${input.slug ?? "notebook"} end-to-end`
      case "notebook_replace_last":
        return describePython(String(input.source ?? ""))
      case "notebook_delete_last":
        return `Removing a cell from ${input.slug ?? "notebook"}`
      case "notebook_show":
        return `Reviewing ${input.slug ?? "notebook"}`
      case "notebook_output":
        return `Reading output of ${input.slug ?? "notebook"}`
      case "notebook_stop":
        return `Stopping ${input.slug ?? "notebook"} kernel`
      case "publish_artifact":
        return `Publishing ${input.artifact ?? "an artifact"}`
      case "read":
        return `Reading ${basename(String(input.filePath ?? input.file_path ?? "")) || "a file"}`
      case "write":
        return `Writing ${basename(String(input.filePath ?? input.file_path ?? "")) || "a file"}`
      case "edit":
        return `Editing ${basename(String(input.filePath ?? input.file_path ?? "")) || "a file"}`
      case "glob":
        return `Searching for ${input.pattern ?? "files"}`
      case "grep":
        return `Grepping for "${trim(String(input.pattern ?? ""))}"`
      case "list":
        return `Listing ${input.path ?? "a directory"}`
      case "webfetch":
        return `Fetching ${trim(String(input.url ?? ""))}`
      case "websearch":
        return `Searching the web for "${trim(String(input.query ?? ""))}"`
      case "task":
        return `Delegating to a subagent`
      case "todo":
      case "todowrite":
        return "Updating the todo list"
      case "advance_stage":
        return "Advancing the stage"
      case "goals_write":
        return "Drafting the goals contract"
      case "goals_load":
        return "Loading goals.json"
      case "dashboard_render":
        return `Rendering the dashboard${input.goal_id ? ` for ${input.goal_id}` : ""}`
      case "aiusfe":
        return "Running AiusFE feature engineering"
      case "validation_protocol":
        return "Freezing the validation protocol"
      case "validation_score":
        return `Scoring ${input.model_name ?? "a model"}`
      case "autogluon":
        return "Training AutoGluon (heavy, up to 4h)"
      case "skill":
        return `Loading skill: ${input.name ?? ""}`
      case "apply_patch":
        return "Applying a patch"
      default:
        return `Running ${tool}`
    }
  }

  // The bar shows the agent's current PLAN STEP, not per-tool churn. Primary
  // source is the agent's own todo list (the in-progress item) — these are the
  // "general plan steps" within a stage: stable for many tool calls, smaller
  // than the main pipeline stages. We deliberately do NOT surface streaming
  // text/reasoning first-lines here; those changed token-by-token and made the
  // bar flicker. Fallback when there's no plan is a per-tool-call label (only
  // changes when a new tool starts), then a generic "Working…".
  const activity = createMemo((): { text: string; progress?: string } | undefined => {
    const sid = sessionID()
    if (!sid) return undefined
    const status = sync.data.session_status[sid]
    if (status?.type === "retry") return { text: `Retrying — ${trim(String(status.message ?? ""))}` }
    if (status?.type !== "busy") return undefined

    const todos = (sync.data.todo[sid] ?? []).filter((t) => t.status !== "cancelled")
    const inProgress = todos.find((t) => t.status === "in_progress")
    if (inProgress) {
      const done = todos.filter((t) => t.status === "completed").length
      // full step text — the bar wraps it rather than truncating
      return { text: inProgress.content.replace(/\s+/g, " ").trim(), progress: `${Math.min(done + 1, todos.length)}/${todos.length}` }
    }

    const msgs = sync.data.message[sid]
    const last = msgs?.[msgs.length - 1]
    if (last && last.role === "assistant" && !last.time?.completed) {
      const parts = sync.data.part[last.id] ?? []
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i] as any
        if (p?.type === "tool" && p.tool && (p.state?.status === "running" || p.state?.status === "pending")) {
          return { text: describeTool(p.tool, p.state?.input ?? {}) }
        }
      }
    }
    return { text: "Working…" }
  })

  return (
    <Show when={state()}>
      <box
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        backgroundColor={theme.backgroundPanel}
        flexShrink={0}
      >
        <box flexDirection="row">
          <For each={VISIBLE}>
            {(stage, idx) => {
              // createMemo so the token re-derives when state() changes — VISIBLE
              // is static so the For row is created once; without a reactive read
              // the token char/colour would freeze at the first render's stage.
              const t = createMemo(() => tokenFor(stage))
              return (
                <>
                  <text fg={t().fg} attributes={current() === stage ? 1 : 0}>
                    {t().ch}
                  </text>
                  <Show when={idx() < VISIBLE.length - 1}>
                    <text fg={theme.textMuted}>─</text>
                  </Show>
                </>
              )
            }}
          </For>
          <text fg={theme.textMuted}>{"  "}</text>
          <text fg={theme.text} attributes={1}>{Stage.describe(current() ?? "init").label}</text>
          <Show when={current() && Stage.isHITL(current()!)}>
            <text fg={Stage.isHardGate(current()!) ? theme.accent : theme.secondary}>
              {Stage.isHardGate(current()!) ? "  · awaiting your approval" : "  · awaiting your review"}
            </text>
          </Show>
          <Show when={doneTiming()}>
            <text fg={theme.primary}>{`  ·  ${State.formatDuration(doneTiming()!.activeMs)} active`}</text>
          </Show>
        </box>
        <Show when={activity()}>
          <box paddingTop={0}>
            <text wrapMode="word">
              <span style={{ fg: theme.textMuted }}>Now: </span>
              <span style={{ fg: theme.secondary }}>{activity()!.text}</span>
              <Show when={activity()!.progress}>
                <span style={{ fg: theme.textMuted }}>{`  ·  step ${activity()!.progress}`}</span>
              </Show>
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}
