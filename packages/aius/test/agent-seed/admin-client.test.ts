import { expect, test, beforeAll, afterAll } from "bun:test"
import { AdminClient } from "@/agent-seed/admin-client"
import { Effect } from "effect"

const calls: { path: string; body: any; admin: string | null }[] = []
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      calls.push({
        path: url.pathname,
        body: req.method === "POST" ? await req.json() : null,
        admin: req.headers.get("x-aius-admin-token"),
      })
      if (url.pathname === "/v1/admin/agents/build")
        return Response.json({ name: "build", system_prompt: "You are Aius", tools: [{ name: "read" }] })
      return Response.json({ name: "build", version: 1 })
    },
  })
})
afterAll(() => server.stop(true))

test("upsertPrompt sends admin header and body with default version", async () => {
  const base = `http://localhost:${server.port}`
  await Effect.runPromise(AdminClient.upsertPrompt(base, "secret", { name: "build", text: "hi" }))
  const call = calls.find((c) => c.path === "/v1/admin/prompts")!
  expect(call.admin).toBe("secret")
  expect(call.body).toEqual({ name: "build", text: "hi", version: 1 })
})

test("getAgent returns resolved config", async () => {
  const base = `http://localhost:${server.port}`
  const agent = await Effect.runPromise(AdminClient.getAgent(base, "secret", "build"))
  expect(agent.tools.map((t: any) => t.name)).toContain("read")
})

// Security: never send the admin token over cleartext HTTP to a remote host.
test("refuses to send the admin token over cleartext to a remote host", async () => {
  const exit = await Effect.runPromiseExit(
    AdminClient.upsertPrompt("http://evil.example/v1", "secret", { name: "build", text: "x" }),
  )
  expect(exit._tag).toBe("Failure")
})

// Regression for Fix 4: a base normalized to drop a trailing `/v1` (as
// seed-agent.ts does) must produce a single `/v1/admin/...`, never `.../v1/v1/...`.
test("base ending in /v1 normalizes to a single /v1/admin path", async () => {
  const base = `http://localhost:${server.port}/v1`.replace(/\/v1\/?$/, "")
  await Effect.runPromise(AdminClient.upsertPrompt(base, "secret", { name: "build", text: "hi" }))
  expect(calls.some((c) => c.path === "/v1/admin/prompts")).toBe(true)
  expect(calls.some((c) => c.path === "/v1/v1/admin/prompts")).toBe(false)
})
