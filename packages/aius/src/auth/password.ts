// Email/password auth for the CLI.
//
// The API gateway has no browser session, so login/register return a
// `session_token` (HS256 JWT) in the body. The CLI uses it once — as the
// `__Host-aius_session` cookie — to mint a durable `aius_` API token via
// POST /v1/tokens, then stores ONLY that token (same PAT entry the rest of the
// client already understands). The session_token is never persisted.

import { apiBaseUrlTrimmed } from "@/config/api-url"

export type PasswordResult =
  | { ok: true; token: string }
  | { ok: false; error: string }
  // The account has 2FA enabled: prompt for a code and finish via
  // completeTwoFactorLogin(challengeToken, code).
  | { ok: false; twoFactor: { challengeToken: string } }

interface AuthBody {
  user?: { email?: string; name?: string }
  message?: string
  session_token?: string
  requires_2fa?: boolean
  challenge_token?: string
  detail?: string | { code?: string; message?: string }
}

async function postJson(path: string, payload: unknown): Promise<{ status: number; body: AuthBody }> {
  const res = await fetch(apiBaseUrlTrimmed() + path, {
    method: "POST",
    // Accept-Encoding: identity avoids a gzip decode error (ZlibError) against
    // the dev gateway, whose nginx mislabels gzipped auth responses.
    headers: { "Content-Type": "application/json", "Accept-Encoding": "identity" },
    body: JSON.stringify(payload),
  })
  let body: AuthBody = {}
  try {
    body = (await res.json()) as AuthBody
  } catch {
    // non-JSON error page
  }
  return { status: res.status, body }
}

function errorFrom(status: number, body: AuthBody, fallback: string): string {
  // The backend returns structured errors as detail: { code, message } (e.g.
  // PASSWORD_TOO_WEAK / EMAIL_ALREADY_EXISTS / INVALID_CREDENTIALS). Surface the
  // human message; fall back to string detail, top-level message, then default.
  const detail = body.detail as unknown
  if (detail && typeof detail === "object" && "message" in detail) {
    const m = (detail as { message?: unknown }).message
    if (typeof m === "string" && m) return m
  }
  if (typeof detail === "string" && detail) return detail
  if (typeof body.message === "string" && body.message) return body.message
  return `${fallback} (HTTP ${status})`
}

// Exchange a session_token for a durable aius_ API token via POST /v1/tokens.
async function mintApiToken(sessionToken: string, tokenName: string): Promise<string> {
  const res = await fetch(apiBaseUrlTrimmed() + "/tokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      // require_session reads the JWT from this cookie.
      Cookie: `__Host-aius_session=${sessionToken}`,
    },
    body: JSON.stringify({ token_name: tokenName }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Could not create an API token (HTTP ${res.status})${text ? `: ${text}` : ""}`)
  }
  const data = (await res.json()) as { token?: string }
  if (!data.token) throw new Error("Token endpoint did not return a token.")
  return data.token
}

const tokenName = () => `aius-cli-${new Date().toISOString().slice(0, 10)}`

async function flow(path: string, payload: unknown, failLabel: string): Promise<PasswordResult> {
  try {
    const { status, body } = await postJson(path, payload)
    if (status < 200 || status >= 300) return { ok: false, error: errorFrom(status, body, failLabel) }
    // 2FA-enabled accounts get a challenge (no session) instead of success.
    if (body.requires_2fa && body.challenge_token) {
      return { ok: false, twoFactor: { challengeToken: body.challenge_token } }
    }
    if (!body.session_token) {
      return {
        ok: false,
        error: "Server did not return a session — update the AIUS API, or use `aius auth login --key`.",
      }
    }
    const token = await mintApiToken(body.session_token, tokenName())
    return { ok: true, token }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Register a new account, then return a freshly minted aius_ token. */
export const registerWithPassword = (email: string, name: string, password: string): Promise<PasswordResult> =>
  flow("/register", { email, name, password }, "Registration failed")

/** Log in to an existing account, then return a freshly minted aius_ token. */
export const loginWithPassword = (email: string, password: string): Promise<PasswordResult> =>
  flow("/login", { email, password }, "Login failed")

/**
 * Finish a 2FA login: exchange a challenge token + TOTP/recovery code for a
 * durable aius_ token. Call this after loginWithPassword returns `twoFactor`.
 */
export async function completeTwoFactorLogin(challengeToken: string, code: string): Promise<PasswordResult> {
  try {
    const { status, body } = await postJson("/2fa/login", { challenge_token: challengeToken, code })
    if (status < 200 || status >= 300) return { ok: false, error: errorFrom(status, body, "Invalid code") }
    if (!body.session_token) return { ok: false, error: "Server did not return a session." }
    const token = await mintApiToken(body.session_token, tokenName())
    return { ok: true, token }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
