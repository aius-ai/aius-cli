import { Effect } from "effect"
import path from "path"
import { ToolRegistry } from "@/tool/registry"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Agent } from "@/agent/agent"

// The backend seeds tool schemas for the primary "aius" data-scientist agent.
// That agent is registered under the name "build" in `Agent.Service` — the
// in-app default — so seeding collects against it.
export const AGENT_NAME = "build"

export interface SeedTool {
  name: string
  schema_json: string
}

// The backend injects each `schema_json` verbatim into the LLM request body, so
// it must be a complete OpenAI tool object — not just the parameter schema.
export const collectTools = Effect.fn("AgentSeed.collectTools")(function* (agentName: string) {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const agent = yield* agents.get(agentName)
  if (!agent) return yield* Effect.die(new Error(`agent "${agentName}" not found`))

  const items = yield* registry.tools({
    modelID: ModelID.make("openai/gpt-4o"),
    providerID: ProviderID.openrouter,
    agent,
  })

  // `invalid` is the registry's InvalidTool placeholder for surfacing bad tool
  // calls — it must never be advertised to the model as a callable tool.
  return items
    .filter((item) => item.id !== "invalid")
    .map(
      (item): SeedTool => ({
        name: item.id,
        schema_json: JSON.stringify({
          type: "function",
          function: {
            name: item.id,
            description: item.description,
            parameters: ToolJsonSchema.fromTool(item),
          },
        }),
      }),
    )
})

export const readAgentPrompt = Effect.fn("AgentSeed.readAgentPrompt")(function* () {
  return yield* Effect.promise(() => Bun.file(path.join(import.meta.dir, "..", "session", "prompt", "aius.txt")).text())
})

export * as AgentSeed from "./collect"
