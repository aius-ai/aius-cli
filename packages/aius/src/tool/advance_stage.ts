import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Stage } from "@/ds/stage"
import { State } from "@/ds/state"
import { Goals } from "@/ds/goals"
import DESCRIPTION from "./advance_stage.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  note: Schema.String.annotate({
    description:
      "Short description of why this stage is complete (one sentence). Surfaced in commit messages and the audit log. Pass an empty string only if you really have nothing to add.",
  }),
  force: Schema.optional(Schema.Boolean).annotate({
    description:
      "Bypass the HITL continue-signal check. Only set true after the user has explicitly told you to continue past a review gate, OR if the gate is soft and the user has clearly read the artifact.",
  }),
})

const CONTINUE_RE = /\b(continue|continuar|kontynuuj|dalej|proceed|next|go|advance)\b/i

const userSaidContinue = (ctx: Tool.Context): boolean => {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i]
    if (m.info.role !== "user") continue
    for (const part of m.parts) {
      if (part.type === "text" && CONTINUE_RE.test(part.text)) return true
    }
    break
  }
  return false
}

export const AdvanceStageTool = Tool.define(
  "advance_stage",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { force?: boolean; note?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const present = yield* Effect.promise(() => State.exists(ins.directory))
          if (!present) {
            return {
              title: "advance_stage: no project",
              metadata: { advanced: false, reason: "no-project" } as Record<string, unknown>,
              output: "No .aius/project.json found. Run init first.",
            }
          }
          const state = yield* Effect.promise(() => State.load(ins.directory))
          const current = state.current_stage

          // Enforced gate: context_build cannot complete until the deep ingest
          // exists — guarantees the agent saw full documents (baselines!) and a
          // real data profile, not just file heads.
          if (current === "context_build") {
            const ingest = path.join(ins.directory, "output", "context", "ingest.md")
            const hasIngest = yield* Effect.promise(() => Bun.file(ingest).exists())
            if (!hasIngest) {
              return {
                title: "advance_stage: blocked at context_build",
                metadata: { advanced: false, stage: current, reason: "missing-ingest" } as Record<string, unknown>,
                output:
                  "Cannot leave context_build: output/context/ingest.md does not exist. Call context_ingest first, read it, and ground CONTEXT.md in it (including any baselines).",
              }
            }
          }

          // Enforced depth: discovery is the most important stage. It can't
          // complete without several observation folders, each with real visual
          // evidence — so "shallow discovery with two figures" is impossible.
          if (current === "discovery") {
            const fs = yield* Effect.promise(() => import("fs/promises"))
            const discDir = path.join(ins.directory, "output", "discovery")
            const entries = yield* Effect.promise(() => fs.readdir(discDir, { withFileTypes: true }).catch(() => [] as never[]))
            let valid = 0
            for (const e of entries) {
              if (!e.isDirectory()) continue
              const hasMd = yield* Effect.promise(() => Bun.file(path.join(discDir, e.name, "observation.md")).exists())
              const evid = yield* Effect.promise(() =>
                fs.readdir(path.join(discDir, e.name, "evidence")).catch(() => [] as string[]),
              )
              if (hasMd && evid.filter((f) => !f.startsWith(".")).length > 0) valid += 1
            }
            const MIN = 3
            if (valid < MIN) {
              return {
                title: "advance_stage: discovery too shallow",
                metadata: { advanced: false, stage: current, observations: valid, required: MIN } as Record<string, unknown>,
                output: `Discovery needs at least ${MIN} observation folders with evidence — found ${valid}. Build more notebooks (distributions, correlations, target relationships, missingness, segments, leakage) and record each with the observe tool before advancing.`,
              }
            }
          }

          if (current === "done") {
            return {
              title: "advance_stage: done",
              metadata: { advanced: false, stage: current } as Record<string, unknown>,
              output: "Pipeline already at `done`. Nothing further to advance.",
            }
          }

          if (Stage.isHITL(current)) {
            const sentContinue = userSaidContinue(ctx)
            if (Stage.isHardGate(current) && !sentContinue) {
              return {
                title: "advance_stage: blocked at " + current,
                metadata: { advanced: false, stage: current, gate: "hard", waiting_for: "user_continue" } as Record<string, unknown>,
                output:
                  "Blocked at the hard HITL gate. The user has not said 'continue' since the last review artifact was produced. Surface the gate in your reply and wait.",
              }
            }
            if (!params.force && !sentContinue) {
              return {
                title: "advance_stage: blocked at " + current,
                metadata: { advanced: false, stage: current, gate: "soft", waiting_for: "user_continue_or_force" } as Record<string, unknown>,
                output:
                  "Soft HITL gate. Wait for the user to say 'continue', or call this tool again with force=true once you are sure they have read the artifact.",
              }
            }
          }

          // The achieving-goals stage is optional. Leaving goal_review with no
          // modeling-type goals skips cleaning + achieving_goals and goes
          // straight to dashboards (the discovery + dashboards only path).
          if (current === "goal_review") {
            const goals = yield* Effect.promise(() => Goals.load(ins.directory).catch(() => null))
            const hasModeling = !!goals && goals.goals.some((g) => g.type === "modeling")
            if (!hasModeling) {
              const jumped = yield* Effect.promise(() => State.advanceTo(ins.directory, "dashboards"))
              return {
                title: `advance_stage: ${current} → dashboards (no modeling goals)`,
                metadata: { advanced: true, from: current, to: jumped.current_stage, skipped: ["cleaning", "achieving_goals"] } as Record<string, unknown>,
                output:
                  "No modeling goals — skipped cleaning and the achieving-goals stage. Now at dashboards. Build the deliverable dashboards from the discovery findings and any artifacts.",
              }
            }
          }

          const next = yield* Effect.promise(() => State.advance(ins.directory))
          const meta = Stage.describe(next.current_stage)
          const done = next.current_stage === "done"
          const t = done ? State.timing(next) : undefined
          return {
            title: `advance_stage: ${current} → ${next.current_stage}`,
            metadata: {
              advanced: true,
              from: current,
              to: next.current_stage,
              hitl: Stage.isHITL(next.current_stage),
              hardGate: Stage.isHardGate(next.current_stage),
              ...(t ? { active_ms: t.activeMs, waiting_ms: t.waitingMs } : {}),
            } as Record<string, unknown>,
            output: [
              `Advanced from \`${current}\` to \`${next.current_stage}\`.`,
              `Stage: ${meta.label}.`,
              meta.callout ? `Callout: ${meta.callout}` : "",
              t
                ? `\nPipeline complete. Total active time: ${State.formatDuration(t.activeMs)} (excludes ${State.formatDuration(t.waitingMs)} waiting at review gates).`
                : "",
              "",
              done
                ? "Summarise what was produced and where to find it, and report the total active time above."
                : Stage.isHITL(next.current_stage)
                  ? "STOP HERE — this is a human review gate. Write a short summary of what the user should review, then END YOUR TURN immediately: do NOT call any more tools and do NOT begin the next stage's work. The user must review and click Continue; you will be re-invoked automatically when they do."
                  : "Start the next stage's work immediately — forward motion is the rule.",
            ]
              .filter(Boolean)
              .join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as AdvanceStage from "./advance_stage"
