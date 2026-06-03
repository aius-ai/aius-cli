import { Schema } from "effect"

export const StageName = Schema.Literals([
  "init",
  "context_build",
  "context_review",
  "discovery",
  "discovery_review",
  "goal_extract",
  "goal_review",
  "cleaning",
  "achieving_goals",
  "dashboards",
  "done",
])
export type StageName = Schema.Schema.Type<typeof StageName>

export const StageStatus = Schema.Literals(["pending", "running", "complete", "failed", "skipped"])
export type StageStatus = Schema.Schema.Type<typeof StageStatus>

export const ORDER: readonly StageName[] = [
  "init",
  "context_build",
  "context_review",
  "discovery",
  "discovery_review",
  "goal_extract",
  "goal_review",
  "cleaning",
  "achieving_goals",
  "dashboards",
  "done",
] as const

export const HITL: ReadonlySet<StageName> = new Set([
  "context_review",
  "discovery_review",
  "goal_review",
])

export const HITL_HARD: ReadonlySet<StageName> = new Set(["goal_review"])

export const next = (current: StageName): StageName | undefined => {
  const i = ORDER.indexOf(current)
  if (i === -1) return undefined
  return ORDER[i + 1]
}

export const isHITL = (stage: StageName) => HITL.has(stage)
export const isHardGate = (stage: StageName) => HITL_HARD.has(stage)

export const describe = (stage: StageName): { label: string; callout?: string } => {
  switch (stage) {
    case "init":
      return { label: "Initialising project" }
    case "context_build":
      return { label: "Reading the brief" }
    case "context_review":
      return {
        label: "Awaiting your review",
        callout: "Review `context/CONTEXT.md` in VS Code, then say **continue**.",
      }
    case "discovery":
      return { label: "Profiling the data" }
    case "discovery_review":
      return {
        label: "Discovery ready",
        callout: "Skim `output/discovery/`, then say **continue** (or skip — observations are informational).",
      }
    case "goal_extract":
      return { label: "Drafting goals" }
    case "goal_review":
      return {
        label: "Awaiting your approval",
        callout:
          "Open `.aius/goals.json` in VS Code. Tighten outcomes and success criteria. Say **continue** when ready.",
      }
    case "cleaning":
      return { label: "Cleaning data" }
    case "achieving_goals":
      return { label: "Achieving goals" }
    case "dashboards":
      return { label: "Building dashboards" }
    case "done":
      return { label: "Done" }
  }
}

export * as Stage from "./stage"
