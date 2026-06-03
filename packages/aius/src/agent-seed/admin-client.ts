import { Effect } from "effect"
import { isLoopbackOrSecure } from "@/util/transport"

const AUTHORIZATION = "Authorization"

// The admin token is privileged; never transmit it over cleartext to a remote
// host (on-path interception). TLS or loopback only.
function requireSecure(base: string) {
  if (!isLoopbackOrSecure(base))
    throw new Error(
      `Refusing to send a bearer token over an insecure connection to ${new URL(base).host}. ` +
        `Use an https:// AIUS_API_URL or a local server.`,
    )
}

async function post(base: string, token: string, route: string, body: unknown) {
  requireSecure(base)
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [AUTHORIZATION]: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${await res.text()}`)
  return res.json()
}

export const upsertPrompt = (base: string, token: string, p: { name: string; text: string; version?: number }) =>
  Effect.promise(() => post(base, token, "/v1/admin/prompts", { version: 1, ...p }))

export const upsertTool = (base: string, token: string, t: { name: string; schema_json: string; version?: number }) =>
  Effect.promise(() => post(base, token, "/v1/admin/tools", { version: 1, ...t }))

export const upsertAgent = (
  base: string,
  token: string,
  a: { name: string; prompt_name?: string; tool_names?: string[]; version?: number },
) => Effect.promise(() => post(base, token, "/v1/admin/agents", { version: 1, ...a }))

export const getAgent = (base: string, token: string, name: string) =>
  Effect.promise(async () => {
    requireSecure(base)
    const res = await fetch(`${base}/v1/admin/agents/${name}`, { headers: { [AUTHORIZATION]: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`getAgent -> ${res.status}`)
    return res.json() as Promise<{ name: string; system_prompt: string | null; tools: any[] }>
  })

export * as AdminClient from "./admin-client"
