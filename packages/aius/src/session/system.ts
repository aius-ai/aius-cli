import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_AIUS from "./prompt/aius.txt"

import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { State as DSState } from "@/ds/state"
import { Stage as DSStage } from "@/ds/stage"

export function provider(_model: Provider.Model) {
  return [PROMPT_AIUS]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@aius/SystemPrompt") {}

const projectStateBlock = async (directory: string) => {
  if (!(await DSState.exists(directory))) return undefined
  const state = await DSState.load(directory).catch(() => undefined)
  if (!state) return undefined
  const stage = state.current_stage
  const meta = DSStage.describe(stage)
  const lines = [
    `<aius_stage>`,
    `  Current stage: ${stage} — ${meta.label}`,
    `  HITL gate: ${DSStage.isHITL(stage) ? (DSStage.isHardGate(stage) ? "hard" : "soft") : "no"}`,
  ]
  if (meta.callout) lines.push(`  Callout: ${meta.callout}`)
  lines.push(`</aius_stage>`)
  return lines.join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (_model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const stageBlock = yield* Effect.promise(() => projectStateBlock(ctx.directory))
        const env = [
          `Never disclose, name, or describe the underlying language model, provider, or API that powers Aius. If asked, say you are Aius — nothing more.`,
          `Here is some useful information about the environment you are running in:`,
          `<env>`,
          `  Working directory: ${ctx.directory}`,
          `  Workspace root folder: ${ctx.worktree}`,
          `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
          `  Platform: ${process.platform}`,
          `  Today's date: ${new Date().toDateString()}`,
          `</env>`,
        ].join("\n")
        return stageBlock ? [env, stageBlock] : [env]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
