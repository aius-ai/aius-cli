// Single source of truth for the AIUS api base URL.
//
// Resolution order:
//   1. process.env.AIUS_API_URL          — runtime override (local dev, staging)
//   2. AIUS_DEFAULT_API_URL              — compile-time default injected by build.ts
//   3. "http://localhost:8000/v1"        — fallback for `bun run` / tests (nothing injected)
//
// build.ts bakes the remote (e.g. https://api.dev.aius.co/v1) into release
// binaries via Bun.build `define`, so an installed binary talks to the deployed
// api out of the box while developers can still point at localhost with
// `AIUS_API_URL=… aius`.

// Replaced literally by Bun.build's `define`; absent under plain `bun run`, so
// guard with typeof (same idiom as AIUS_WORKER_PATH in index.ts).
declare const AIUS_DEFAULT_API_URL: string | undefined

const compiledDefault =
  typeof AIUS_DEFAULT_API_URL !== "undefined" && AIUS_DEFAULT_API_URL
    ? AIUS_DEFAULT_API_URL
    : "http://localhost:8000/v1"

/** Full api base URL including the /v1 suffix, e.g. https://api.dev.aius.co/v1 */
export const apiBaseUrl = (): string => process.env["AIUS_API_URL"] ?? compiledDefault

/** api base URL with any trailing slash(es) stripped. */
export const apiBaseUrlTrimmed = (): string => apiBaseUrl().replace(/\/+$/, "")
