// OAuth sign-in for AIUS OAuth Provider
//
// This implements OAuth 2.0 Authorization Code Flow with PKCE for the AIUS OAuth Provider.
// The client authenticates users via the AIUS OAuth provider and stores OAuth tokens.

import path from "path"
import { Global } from "@aius-ai/core/global"
import fs from "fs/promises"
import { Effect } from "effect"

export type OAuthProvider = "aius"

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["aius"]

export const OAUTH_PROVIDER_LABEL: Record<OAuthProvider, string> = {
  aius: "AIUS",
}

export interface OAuthTokens {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  id_token?: string
  scope: string
}

export interface OAuthConfig {
  client_id: string
  client_secret: string
  redirect_uri: string
  scopes: string[]
  auth_url: string
  token_url: string
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

function generateState(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

function generateNonce(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

export async function getOAuthConfig(): Promise<OAuthConfig> {
  const api_url = process.env.AIUS_API_URL ?? "https://api.aius.co"
  
  return {
    client_id: process.env.AIUS_OAUTH_CLIENT_ID ?? "",
    client_secret: process.env.AIUS_OAUTH_CLIENT_SECRET ?? "",
    redirect_uri: process.env.AIUS_OAUTH_REDIRECT_URI ?? "http://localhost:3000/callback",
    scopes: (process.env.AIUS_OAUTH_SCOPES ?? "openid profile email").split(" "),
    auth_url: `${api_url}/oauth/authorize`,
    token_url: `${api_url}/oauth/token`,
  }
}

export async function getAuthorizationUrl(): Promise<{ url: string; code_verifier: string; state: string }> {
  const config = await getOAuthConfig()
  const code_verifier = generateCodeVerifier()
  const code_challenge = await generateCodeChallenge(code_verifier)
  const state = generateState()
  const nonce = generateNonce()

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    scope: config.scopes.join(" "),
    state,
    code_challenge,
    code_challenge_method: "S256",
    nonce,
  })

  return {
    url: `${config.auth_url}?${params.toString()}`,
    code_verifier,
    state,
  }
}

export async function exchangeCodeForTokens(
  code: string,
  code_verifier: string,
): Promise<OAuthTokens> {
  const config = await getOAuthConfig()
  
  const response = await fetch(config.token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirect_uri,
      client_id: config.client_id,
      client_secret: config.client_secret,
      code_verifier,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to exchange code for tokens: ${error}`)
  }

  return response.json()
}

export async function refreshAccessToken(refresh_token: string): Promise<OAuthTokens> {
  const config = await getOAuthConfig()
  
  const response = await fetch(config.token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
      client_id: config.client_id,
      client_secret: config.client_secret,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to refresh access token: ${error}`)
  }

  return response.json()
}

function readAuthFile() {
  return Effect.tryPromise({
    try: async () => {
      const file = path.join(Global.Path.data, "auth.json")
      const content = await fs.readFile(file, "utf-8")
      return JSON.parse(content)
    },
    catch: () => ({}),
  })
}

function writeAuthFile(data: Record<string, unknown>) {
  return Effect.tryPromise({
    try: async () => {
      const file = path.join(Global.Path.data, "auth.json")
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 })
    },
    catch: () => {},
  })
}

export function storeOAuthTokens(tokens: OAuthTokens) {
  const expires_at = Math.floor(Date.now() / 1000) + tokens.expires_in
  return Effect.gen(function* () {
    const data = yield* readAuthFile()
    data["openrouter"] = {
      type: "oauth",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: expires_at,
    }
    yield* writeAuthFile(data)
  })
}

export function getStoredOAuthTokens() {
  return Effect.gen(function* () {
    const data = yield* readAuthFile()
    const info = data["openrouter"] as { type: string; access: string; refresh: string; expires: number } | undefined
    if (info && info.type === "oauth") {
      return info as { type: "oauth"; access: string; refresh: string; expires: number }
    }
    return undefined
  })
}

export async function loginWithOAuth(): Promise<void> {
  const { url, code_verifier, state } = await getAuthorizationUrl()
  
  // Open browser for user to authorize
  console.log(`Opening browser for OAuth authorization...`)
  console.log(`Authorization URL: ${url}`)
  
  // In a TUI environment, we might need to display the URL and wait for the user to complete the flow
  // For now, we'll use a simple approach that requires the user to paste the callback URL
  throw new Error("OAuth flow requires browser interaction. Please open the URL above and complete the authorization.")
}

export async function handleOAuthCallback(
  callbackUrl: string,
  code_verifier: string,
  state: string,
): Promise<void> {
  const url = new URL(callbackUrl)
  const code = url.searchParams.get("code")
  const returnedState = url.searchParams.get("state")
  
  if (!code) {
    throw new Error("No authorization code in callback")
  }
  
  if (returnedState !== state) {
    throw new Error("State mismatch - possible CSRF attack")
  }
  
  const tokens = await exchangeCodeForTokens(code, code_verifier)
  await storeOAuthTokens(tokens)
  
  console.log("OAuth authentication successful!")
}

export * as OAuth from "./oauth"
