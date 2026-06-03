import { afterEach, describe, expect, it } from "bun:test"
import { completeTwoFactorLogin, loginWithPassword } from "../../src/auth/password"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// Route a fake fetch by URL path; each entry is [status, jsonBody].
function stub(routes: Record<string, [number, unknown]>) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString()
    const key = Object.keys(routes).find((p) => u.endsWith(p))
    const [status, body] = key ? routes[key] : [404, {}]
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response
  }) as typeof fetch
}

describe("password auth", () => {
  it("login returns a 2FA challenge when the account requires it", async () => {
    stub({ "/login": [200, { requires_2fa: true, challenge_token: "chal_abc" }] })
    const res = await loginWithPassword("a@b.com", "pw")
    expect(res.ok).toBe(false)
    expect("twoFactor" in res && res.twoFactor.challengeToken).toBe("chal_abc")
  })

  it("login without 2FA mints an aius_ token", async () => {
    stub({
      "/login": [200, { user: { email: "a@b.com" }, session_token: "sess" }],
      "/tokens": [200, { token: "aius_live" }],
    })
    const res = await loginWithPassword("a@b.com", "pw")
    expect(res).toEqual({ ok: true, token: "aius_live" })
  })

  it("completeTwoFactorLogin exchanges a code for a token", async () => {
    stub({
      "/2fa/login": [200, { user: { email: "a@b.com" }, session_token: "sess" }],
      "/tokens": [200, { token: "aius_2fa" }],
    })
    const res = await completeTwoFactorLogin("chal_abc", "123456")
    expect(res).toEqual({ ok: true, token: "aius_2fa" })
  })

  it("completeTwoFactorLogin surfaces an invalid-code error", async () => {
    stub({ "/2fa/login": [401, { detail: { code: "INVALID_CODE", message: "Invalid verification code" } }] })
    const res = await completeTwoFactorLogin("chal_abc", "000000")
    expect(res.ok).toBe(false)
    expect("error" in res && res.error).toBe("Invalid verification code")
  })
})
