import path from "path"
import { Schema } from "effect"

const GOALS_FILE = "goals.json"
const GOALS_DIR = ".aius"
const SCHEMA_VERSION = 1

export const GoalType = Schema.Literals(["modeling", "artifact", "question"])
export type GoalType = Schema.Schema.Type<typeof GoalType>

export const ToolIntent = Schema.Literals(["result", "explainability", "artifact", "question"])
export type ToolIntent = Schema.Schema.Type<typeof ToolIntent>

export const Deliverable = Schema.Literals(["notebook", "model_card", "feature_report", "dashboard", "report"])
export type Deliverable = Schema.Schema.Type<typeof Deliverable>

export const SuccessCriterion = Schema.Struct({
  metric: Schema.String.annotate({ description: "Concrete metric name (e.g., 'ROC AUC, 5-fold CV')" }),
  target: Schema.String.annotate({ description: "Comparator + numeric target (e.g., '>= 0.78', '<= 0.20')" }),
  rationale: Schema.String.annotate({ description: "Why this target — tied to the brief or a benchmark" }),
})
export type SuccessCriterion = Schema.Schema.Type<typeof SuccessCriterion>

export const GoalTooling = Schema.Struct({
  intent: ToolIntent,
  primary: Schema.optional(Schema.String).annotate({
    description: "Primary estimator/library (e.g., 'sklearn:LogisticRegression', 'aiusfe')",
  }),
  candidates: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Alternatives to consider if primary fails its success criteria",
  }),
  explainability_required: Schema.optional(Schema.Boolean),
})
export type GoalTooling = Schema.Schema.Type<typeof GoalTooling>

export const GoalData = Schema.Struct({
  source: Schema.String.annotate({ description: "Path to source dataset (data/raw/*.parquet, etc.)" }),
  target: Schema.optional(Schema.String).annotate({ description: "Target column name for modeling goals" }),
  filters: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Pandas-style boolean filters to apply before training (e.g., 'device == \\'mobile\\'')",
  }),
})
export type GoalData = Schema.Schema.Type<typeof GoalData>

export const Goal = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable identifier, e.g., 'g1', 'g2'" }),
  slug: Schema.String.annotate({ description: "kebab-case, used for output folder names" }),
  type: GoalType,
  title: Schema.String,
  outcome: Schema.String.annotate({
    description: "Plain-language description of what the user gets at the end. No fluff.",
  }),
  success_criteria: Schema.Array(SuccessCriterion).annotate({
    description: "At least one measurable criterion with a numeric target. The contract with the user.",
  }),
  data: GoalData,
  tooling: GoalTooling,
  deliverables: Schema.Array(Deliverable),
  depends_on: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Other goal IDs that must complete before this one starts",
  }),
  status: Schema.optional(Schema.Literals(["pending", "training", "evaluating", "complete", "at_risk", "failed"])),
  notes: Schema.optional(Schema.String),
})
export type Goal = Schema.Schema.Type<typeof Goal>

export const GoalsFile = Schema.Struct({
  schema_version: Schema.Literal(SCHEMA_VERSION),
  goals: Schema.Array(Goal),
  generated_at: Schema.optional(Schema.String),
  reviewed_at: Schema.optional(Schema.String),
})
export type GoalsFile = Schema.Schema.Type<typeof GoalsFile>

const decode = Schema.decodeUnknownSync(GoalsFile)
const encode = Schema.encodeSync(GoalsFile)

export const goalsPath = (projectRoot: string) => path.join(projectRoot, GOALS_DIR, GOALS_FILE)

export const exists = (projectRoot: string) => Bun.file(goalsPath(projectRoot)).exists()

export const load = async (projectRoot: string): Promise<GoalsFile> => decode(await Bun.file(goalsPath(projectRoot)).json())

export const markdownPath = (projectRoot: string) => path.join(projectRoot, "output", "GOALS.md")

// Human-readable rendering of the goals contract. This is the auditable artifact
// the user reads/edits — the JSON stays as the machine source.
export const toMarkdown = (goals: GoalsFile): string => {
  const lines: string[] = ["# Goals", ""]
  if (goals.reviewed_at) lines.push(`_Reviewed ${goals.reviewed_at}._`, "")
  else if (goals.generated_at) lines.push(`_Drafted ${goals.generated_at} — review and edit before continuing._`, "")
  for (const g of goals.goals) {
    lines.push(`## ${g.id} · ${g.title}`, "")
    lines.push(`- **Type:** ${g.type}`)
    lines.push(`- **Slug:** \`${g.slug}\``)
    lines.push(`- **Tooling intent:** ${g.tooling.intent}${g.tooling.primary ? ` (primary: ${g.tooling.primary})` : ""}`)
    lines.push(`- **Deliverables:** ${g.deliverables.join(", ")}`)
    if (g.data?.source) lines.push(`- **Data:** \`${g.data.source}\`${g.data.target ? ` → target \`${g.data.target}\`` : ""}`)
    if (g.depends_on && g.depends_on.length) lines.push(`- **Depends on:** ${g.depends_on.join(", ")}`)
    lines.push("")
    lines.push(`**Outcome.** ${g.outcome}`, "")
    lines.push("**Success criteria**", "", "| metric | target | rationale |", "|---|---|---|")
    for (const c of g.success_criteria) {
      lines.push(`| ${c.metric} | \`${c.target}\` | ${c.rationale.replace(/\|/g, "/")} |`)
    }
    lines.push("")
    if (g.notes) lines.push(`> ${g.notes.replace(/\n/g, "\n> ")}`, "")
  }
  return lines.join("\n")
}

export const save = async (projectRoot: string, goals: GoalsFile): Promise<void> => {
  await Bun.write(goalsPath(projectRoot), JSON.stringify(encode(goals), null, 2) + "\n")
  // also emit the readable markdown view for auditability
  await Bun.write(markdownPath(projectRoot), toMarkdown(goals) + "\n")
}

export type ValidationError =
  | { kind: "no_goals" }
  | { kind: "missing_outcome"; id: string }
  | { kind: "missing_success_criteria"; id: string }
  | { kind: "no_numeric_target"; id: string; metric: string }
  | { kind: "duplicate_id"; id: string }
  | { kind: "duplicate_slug"; slug: string }
  | { kind: "circular_dep"; id: string }
  | { kind: "unknown_dep"; id: string; missing: string }

export const validate = (goals: GoalsFile): ValidationError[] => {
  const errs: ValidationError[] = []
  if (goals.goals.length === 0) {
    errs.push({ kind: "no_goals" })
    return errs
  }
  const ids = new Set<string>()
  const slugs = new Set<string>()
  for (const g of goals.goals) {
    if (ids.has(g.id)) errs.push({ kind: "duplicate_id", id: g.id })
    ids.add(g.id)
    if (slugs.has(g.slug)) errs.push({ kind: "duplicate_slug", slug: g.slug })
    slugs.add(g.slug)
    if (!g.outcome.trim()) errs.push({ kind: "missing_outcome", id: g.id })
    if (g.success_criteria.length === 0) errs.push({ kind: "missing_success_criteria", id: g.id })
    for (const c of g.success_criteria) {
      if (!/[<>≤≥=]/.test(c.target) || !/\d/.test(c.target)) {
        errs.push({ kind: "no_numeric_target", id: g.id, metric: c.metric })
      }
    }
    for (const dep of g.depends_on ?? []) {
      if (!goals.goals.some((other) => other.id === dep)) errs.push({ kind: "unknown_dep", id: g.id, missing: dep })
      if (dep === g.id) errs.push({ kind: "circular_dep", id: g.id })
    }
  }
  return errs
}

export const explainValidation = (errs: ValidationError[]): string =>
  errs
    .map((e) => {
      switch (e.kind) {
        case "no_goals":
          return "  • No goals defined. Add at least one."
        case "missing_outcome":
          return `  • Goal ${e.id}: outcome is empty.`
        case "missing_success_criteria":
          return `  • Goal ${e.id}: no success criteria. Every goal needs at least one measurable criterion.`
        case "no_numeric_target":
          return `  • Goal ${e.id}, criterion "${e.metric}": target lacks a numeric comparator (use ≥, ≤, =, etc. with a number).`
        case "duplicate_id":
          return `  • Duplicate goal id: ${e.id}`
        case "duplicate_slug":
          return `  • Duplicate goal slug: ${e.slug}`
        case "circular_dep":
          return `  • Goal ${e.id} depends on itself.`
        case "unknown_dep":
          return `  • Goal ${e.id} depends on unknown goal: ${e.missing}`
      }
    })
    .join("\n")

export * as Goals from "./goals"
