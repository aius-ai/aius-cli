// Reachability preflight for the AIUS proxy, run before the TUI takes the
// screen. The agent loop now runs server-side (WS /v1/runs/ws), so an
// unreachable proxy makes the TUI non-functional — we'd rather say so clearly
// up front than let the first run silently fail to connect.
//
// We probe a cheap HTTP endpoint: ANY HTTP response (including 401, which is the
// expected unauthenticated answer from /v1/models) proves the server is
// reachable. Only a network-level failure (refused / DNS / timeout) is treated
// as unreachable. Credential validity is NOT checked here — the bearer token
// lives in the worker's runtime; a bad key is surfaced clearly inside the TUI
// (see RunWsConnectionError + message-v2.fromError).

import { apiBaseUrl } from "@/config/api-url"

export interface ProxyReachability {
  readonly reachable: boolean
  readonly detail?: string
}

export const checkProxyReachable = async (
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<ProxyReachability> =>
  fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) })
    .then(() => ({ reachable: true }) as ProxyReachability)
    .catch((e) => ({ reachable: false, detail: e instanceof Error ? e.message : String(e) }))

// The base URL the run loop will use, resolved the same way provider.ts does.
export const proxyBaseUrl = () => apiBaseUrl()

// Strip any embedded credentials (userinfo) before showing a URL to the user —
// an `AIUS_API_URL=http://user:pass@host` would otherwise leak the secret into
// the terminal / logs on a connection failure.
const redactUrl = (raw: string): string => {
  try {
    const url = new URL(raw)
    if (!url.username && !url.password) return raw
    url.username = ""
    url.password = ""
    return url.toString()
  } catch {
    return raw
  }
}

// User-facing message shown before the TUI when the proxy can't be reached.
export const unreachableMessage = (baseUrl: string) =>
  [
    `Cannot reach the AIUS server at ${redactUrl(baseUrl)}.`,
    "The agent runs server-side, so the proxy must be running for Aius to work.",
    "  • Start the proxy (see the aius-api repo: `docker compose up -d`), or",
    "  • set AIUS_API_URL to a reachable proxy, or",
    "  • set AIUS_SKIP_PREFLIGHT=1 to bypass this check.",
  ].join("\n")

export * as Preflight from "./preflight"
