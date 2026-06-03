import type { Provider } from "@/provider/provider"
import type { ModelMessage, Tool } from "ai"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import type { Permission } from "@/permission"

// The client no longer calls the LLM directly — the backend run loop owns the
// agent loop (see session/run-ws/) and session titling (see processor.ts). What
// remains here is the shape of a run's input, lowered onto the run-loop `start`
// frame by `session/run-ws/wire.ts` and consumed by the processor. The old
// client-side streaming runtime (ai-sdk / native adapters / request prep) and the
// `LLM` Effect service were removed with the run-loop rewire.
export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  // Ask the backend run loop to generate a session title from the first user
  // message and push it back as a `title` frame. Set once, for an untitled
  // top-level session — the client makes no LLM call itself.
  generateTitle?: boolean
}

export * as LLM from "./llm"
