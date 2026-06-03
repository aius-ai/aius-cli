import { expect, test, afterAll } from "bun:test"
import { Preflight } from "@/cli/preflight"

const servers: ReturnType<typeof Bun.serve>[] = []
afterAll(() => servers.forEach((s) => s.stop(true)))

test("reachable: any HTTP response (even 401) counts as reachable", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("unauthorized", { status: 401 }) })
  servers.push(server)
  const result = await Preflight.checkProxyReachable(`http://localhost:${server.port}/v1`)
  expect(result.reachable).toBe(true)
})

test("unreachable: a dead port reports not reachable with a detail", async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("x") })
  const deadPort = probe.port
  probe.stop(true)
  const result = await Preflight.checkProxyReachable(`http://localhost:${deadPort}/v1`)
  expect(result.reachable).toBe(false)
  expect(typeof result.detail).toBe("string")
})

test("proxyBaseUrl honors AIUS_API_URL with a sane default", () => {
  const prev = process.env["AIUS_API_URL"]
  delete process.env["AIUS_API_URL"]
  expect(Preflight.proxyBaseUrl()).toBe("http://localhost:8000/v1")
  process.env["AIUS_API_URL"] = "https://api.example/v1"
  expect(Preflight.proxyBaseUrl()).toBe("https://api.example/v1")
  if (prev === undefined) delete process.env["AIUS_API_URL"]
  else process.env["AIUS_API_URL"] = prev
})

test("unreachableMessage names the URL and the escape hatch", () => {
  const msg = Preflight.unreachableMessage("http://localhost:8000/v1")
  expect(msg).toContain("http://localhost:8000/v1")
  expect(msg).toContain("AIUS_SKIP_PREFLIGHT")
})

test("unreachableMessage redacts credentials embedded in AIUS_API_URL", () => {
  const msg = Preflight.unreachableMessage("http://user:s3cret@host.example:8000/v1")
  expect(msg).not.toContain("s3cret")
  expect(msg).not.toContain("user:")
  expect(msg).toContain("host.example:8000")
})
