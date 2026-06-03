import { Effect } from "effect"
import { AGENT_NAME, collectTools, readAgentPrompt } from "./collect"
import { AdminClient } from "./admin-client"

export const runSeed = Effect.fn("AgentSeed.runSeed")(function* (cfg: { base: string; token: string }) {
  const prompt = yield* readAgentPrompt()
  const tools = yield* collectTools(AGENT_NAME)

  yield* AdminClient.upsertPrompt(cfg.base, cfg.token, { name: AGENT_NAME, text: prompt })
  yield* Effect.forEach(tools, (t) => AdminClient.upsertTool(cfg.base, cfg.token, t), { concurrency: 4 })
  yield* AdminClient.upsertAgent(cfg.base, cfg.token, {
    name: AGENT_NAME,
    prompt_name: AGENT_NAME,
    tool_names: tools.map((t) => t.name),
  })

  const resolved = yield* AdminClient.getAgent(cfg.base, cfg.token, AGENT_NAME)
  return { verifiedToolCount: resolved.tools.length }
})
