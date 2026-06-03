import { Effect } from "effect"
import { makeRuntime } from "@aius-ai/core/effect/runtime"
import { Auth } from "@/auth"

export type StartupAuth = "valid" | "invalid" | "unreachable" | "absent"

// Lazily construct the Auth runtime ONLY when a check actually runs. A
// module-level makeRuntime(...) ran (and pulled its layer graph) at import time,
// which crashed early startup — keep all side effects inside the function. The
// factory's return type is inferred so the service type is preserved.
const makeAuthRuntime = () => makeRuntime(Auth.Service, Auth.defaultLayer)
let _runtime: ReturnType<typeof makeAuthRuntime> | undefined
function runtime() {
  return (_runtime ??= makeAuthRuntime())
}

/**
 * Verify the stored credential against the AIUS API.
 *
 *   absent      — no token saved (first run; onboarding handles it)
 *   valid       — token accepted
 *   invalid     — token rejected (401/403): stale/revoked → re-login needed
 *   unreachable — API down / network error / any failure: never block on it
 *
 * Fully self-contained and failure-safe: any error resolves to "unreachable"
 * so a credential check can never hang or crash the TUI.
 */
export async function checkStoredCredential(): Promise<StartupAuth> {
  try {
    return await runtime().runPromise((auth) =>
      Effect.gen(function* () {
        const token = yield* auth.getAccessToken()
        if (!token) return "absent" as StartupAuth
        return (yield* auth.verify(token)) as StartupAuth
      }),
    )
  } catch {
    return "unreachable"
  }
}

/**
 * True when a credential is stored locally, regardless of whether it still
 * verifies against the API. This is a fast, network-free check (it only reads
 * the token file) — use it for UI that should treat "a key exists" the same as
 * "logged in" (e.g. the account menu offering only Log out). Failure-safe:
 * any error resolves to `false`.
 */
export async function hasStoredToken(): Promise<boolean> {
  try {
    return await runtime().runPromise((auth) =>
      Effect.gen(function* () {
        const token = yield* auth.getAccessToken()
        return Boolean(token)
      }),
    )
  } catch {
    return false
  }
}
