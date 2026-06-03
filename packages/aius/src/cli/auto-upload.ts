// Auto-start the artifact watcher for the TUI session.
//
// When the TUI boots and the user is logged in, we start the same polling
// watcher used by `aius artifacts watch` in the background, pointed at the
// project's ./output directory. Everything here is wrapped so it can NEVER
// crash or block the TUI: a failure to resolve auth/org/project, an
// unreachable API, or anything else is logged at debug level and swallowed.
// It does not touch the agent run loop.

import * as Log from "@aius-ai/core/util/log"
import { Effect } from "effect"
import path from "path"
import { Auth } from "@/auth"
import { Filesystem } from "@/util/filesystem"
import { apiBaseUrlTrimmed } from "@/config/api-url"
import { errorMessage } from "@/util/error"
import {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_MAX_BYTES,
  fetchClients,
  resolveProject,
  startWatcher,
  type WatchContext,
  type WatchReporter,
  type WatcherHandle,
} from "@/cli/cmd/artifacts"

const log = Log.Default.tag("service", "auto-upload")

/**
 * Whether auto-upload is enabled. Default ON; disabled when
 * AIUS_AUTO_UPLOAD_ARTIFACTS is "0", "false", "no", or "off"
 * (case-insensitive).
 */
export function autoUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["AIUS_AUTO_UPLOAD_ARTIFACTS"]
  if (raw === undefined) return true
  const v = raw.trim().toLowerCase()
  return !(v === "0" || v === "false" || v === "no" || v === "off")
}

async function resolveTokenQuiet(): Promise<string | undefined> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Auth.Service).getAccessToken()
    }).pipe(Effect.provide(Auth.defaultLayer)),
  ).catch(() => undefined)
}

/**
 * Start the background artifact watcher for a TUI session. Returns a handle so
 * the TUI can stop it on shutdown, or `undefined` when it did not start
 * (disabled, not logged in, no org, etc.). Never throws.
 */
export async function startAutoUpload(directory: string): Promise<WatcherHandle | undefined> {
  try {
    if (!autoUploadEnabled()) {
      log.debug("disabled via AIUS_AUTO_UPLOAD_ARTIFACTS")
      return undefined
    }

    const token = await resolveTokenQuiet()
    if (!token) {
      log.debug("not logged in; skipping auto-upload")
      return undefined
    }

    const base = apiBaseUrlTrimmed()
    const root = Filesystem.resolve(path.join(directory, DEFAULT_OUTPUT_DIR))

    let orgId: string | undefined
    try {
      const clients = await fetchClients(base, token)
      orgId = clients[0]?.id
    } catch (e) {
      log.debug("could not resolve org; skipping auto-upload", { error: errorMessage(e) })
      return undefined
    }
    if (!orgId) {
      log.debug("no client/org for account; skipping auto-upload")
      return undefined
    }

    const project = await resolveProject(base, token, orgId).catch(() => ({ projectId: undefined }))

    const reporter: WatchReporter = {
      onUploaded: (rel, size) => log.info("uploaded artifact", { path: rel, size }),
      onFailed: (rel, message) => log.warn("artifact upload failed", { path: rel, error: message }),
      onSkipped: (rel, size, max) => log.debug("artifact skipped (too large)", { path: rel, size, max }),
      onTrouble: (message) => log.debug("artifact watch trouble", { message }),
    }

    const ctx: WatchContext = {
      root,
      base,
      token,
      orgId,
      projectId: project.projectId,
      maxBytes: DEFAULT_MAX_BYTES,
    }

    log.info("starting auto-upload watcher", { root, org: orgId, project: project.projectId })
    return startWatcher(ctx, reporter)
  } catch (e) {
    // Absolute backstop — auto-upload must never break the TUI.
    log.debug("auto-upload failed to start", { error: errorMessage(e) })
    return undefined
  }
}
