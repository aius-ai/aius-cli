import type { CommandModule } from "yargs"
import { Effect } from "effect"
import path from "path"
import { readdir } from "fs/promises"
import { Auth } from "@/auth"
import { Filesystem } from "@/util/filesystem"
import { apiBaseUrlTrimmed } from "@/config/api-url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@/util/error"

// ── pretty output (mirrors cli/cmd/auth.ts) ──────────────────────────────────
const { Style } = UI
const RESET = Style.TEXT_NORMAL
const BRAND = "\x1b[38;2;222;123;255m" // brand violet #de7bff

const heading = (m: string) => UI.println(`${BRAND}\x1b[1m${m}${RESET}`)
const ok = (m: string) => UI.println(`${Style.TEXT_SUCCESS_BOLD}✓${RESET} ${m}`)
const bad = (m: string) => UI.println(`${Style.TEXT_DANGER_BOLD}✗${RESET} ${m}`)
const warn = (m: string) => UI.println(`${Style.TEXT_WARNING_BOLD}!${RESET} ${m}`)
const note = (m: string) => UI.println(`${Style.TEXT_DIM}${m}${RESET}`)

// Default skip threshold for individual files (~10 MB). Files larger than this
// are logged and skipped rather than silently dropped or uploaded.
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

// The canonical agent output directory (see ds/init.ts CANONICAL_DIRS).
export const DEFAULT_OUTPUT_DIR = "output"

// ── pure logic (unit-tested) ─────────────────────────────────────────────────

export interface WalkedFile {
  /** Absolute path on disk. */
  readonly absolute: string
  /** POSIX-style path relative to the walk root (what the server stores). */
  readonly relative: string
  /** Size in bytes. */
  readonly size: number
}

export interface WalkResult {
  readonly files: WalkedFile[]
  /** Files skipped because they exceed maxBytes. */
  readonly skipped: WalkedFile[]
}

/** Normalize a relative path to forward slashes regardless of platform. */
export const toPosix = (p: string): string => p.split(path.sep).join("/")

/**
 * Recursively walk `root`, returning every regular file with a POSIX relative
 * path, partitioned into uploadable `files` and oversized `skipped` (size >
 * maxBytes). Symlinks are not followed. Order is stable (sorted by rel path).
 */
export async function walkOutputDir(root: string, maxBytes = DEFAULT_MAX_BYTES): Promise<WalkResult> {
  const files: WalkedFile[] = []
  const skipped: WalkedFile[] = []

  async function recurse(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await recurse(abs)
        continue
      }
      // Skip symlinks and non-regular files (sockets, fifos, devices).
      if (!entry.isFile()) continue
      const size = await Filesystem.size(abs)
      const file: WalkedFile = { absolute: abs, relative: toPosix(path.relative(root, abs)), size }
      if (size > maxBytes) skipped.push(file)
      else files.push(file)
    }
  }

  await recurse(root)
  const byRel = (a: WalkedFile, b: WalkedFile) => a.relative.localeCompare(b.relative)
  return { files: files.sort(byRel), skipped: skipped.sort(byRel) }
}

/** base64-encode raw file bytes (Node Buffer -> base64 string). */
export const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

// ── watch manifest diff (unit-tested) ────────────────────────────────────────

/** Lightweight fingerprint of a file used to detect changes between polls. */
export interface FileStat {
  readonly size: number
  readonly mtimeMs: number
}

/** Manifest of files seen by the watcher, keyed by POSIX relative path. */
export type Manifest = Record<string, FileStat>

export interface ManifestDiff {
  /** Relative paths that are new or whose size/mtime changed since `prev`. */
  readonly toUpload: string[]
  /** The manifest to remember for the next poll (always the full `current`). */
  readonly nextManifest: Manifest
}

/**
 * Pure diff of two manifests. A file is queued for upload when it is absent
 * from `prev`, or when its size or mtime differs from the previously seen
 * value. Deletions are intentionally ignored (the server keeps every version).
 * `toUpload` is sorted for deterministic output/testing.
 */
export function diffManifest(prev: Manifest, current: Manifest): ManifestDiff {
  const toUpload: string[] = []
  for (const [rel, cur] of Object.entries(current)) {
    const before = prev[rel]
    if (!before || before.size !== cur.size || before.mtimeMs !== cur.mtimeMs) {
      toUpload.push(rel)
    }
  }
  return { toUpload: toUpload.sort((a, b) => a.localeCompare(b)), nextManifest: current }
}

// ── HTTP client ──────────────────────────────────────────────────────────────

export interface ClientInfo {
  readonly id: string
  readonly name?: string
}

export class ArtifactsApiError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "ArtifactsApiError"
    this.status = status
  }
}

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` })

/** GET {base}/clients -> first/default client's org id. */
export async function fetchClients(base: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ClientInfo[]> {
  let res: Response
  try {
    res = await fetchImpl(`${base}/clients`, { headers: authHeaders(token), signal: AbortSignal.timeout(15000) })
  } catch (e) {
    throw new ArtifactsApiError(`Could not reach the AIUS API at ${base}/clients: ${errorMessage(e)}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new ArtifactsApiError("The AIUS API rejected the token (401/403). Run `aius auth login`.", res.status)
  }
  if (!res.ok) {
    throw new ArtifactsApiError(`GET /clients failed (${res.status}).`, res.status)
  }
  const body = (await res.json().catch(() => ({}))) as { data?: ClientInfo[] } | ClientInfo[]
  const list = Array.isArray(body) ? body : (body.data ?? [])
  return list
}

export interface ProjectInfo {
  readonly id: string
  readonly name?: string
}

/**
 * GET {base}/projects?org_id=<org> -> the org's projects. Used by
 * resolveProject to auto-associate uploads with a single project.
 */
export async function fetchProjects(
  base: string,
  token: string,
  orgId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectInfo[]> {
  const url = `${base}/projects?org_id=${encodeURIComponent(orgId)}`
  let res: Response
  try {
    res = await fetchImpl(url, { headers: authHeaders(token), signal: AbortSignal.timeout(15000) })
  } catch (e) {
    throw new ArtifactsApiError(`Could not reach the AIUS API at ${url}: ${errorMessage(e)}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new ArtifactsApiError("The AIUS API rejected the token (401/403). Run `aius auth login`.", res.status)
  }
  if (!res.ok) {
    throw new ArtifactsApiError(`GET /projects failed (${res.status}).`, res.status)
  }
  const body = (await res.json().catch(() => ({}))) as { data?: ProjectInfo[] } | ProjectInfo[]
  return Array.isArray(body) ? body : (body.data ?? [])
}

export interface UploadArtifactInput {
  readonly orgId: string
  readonly relativePath: string
  readonly contentBase64: string
  readonly contentType?: string
  readonly projectId?: string
}

/** POST {base}/artifacts with the artifact body. */
export async function uploadArtifact(
  base: string,
  token: string,
  input: UploadArtifactInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const payload: Record<string, unknown> = {
    org_id: input.orgId,
    path: input.relativePath,
    content_base64: input.contentBase64,
  }
  if (input.contentType) payload["content_type"] = input.contentType
  if (input.projectId) payload["project_id"] = input.projectId

  let res: Response
  try {
    res = await fetchImpl(`${base}/artifacts`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    })
  } catch (e) {
    throw new ArtifactsApiError(`network error: ${errorMessage(e)}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new ArtifactsApiError("token rejected (401/403)", res.status)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new ArtifactsApiError(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`, res.status)
  }
}

// ── token resolution ─────────────────────────────────────────────────────────

const runAuth = <A, E>(program: Effect.Effect<A, E, Auth.Service>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(Auth.defaultLayer)))

/** Read the stored AIUS bearer (PAT or refreshed OAuth access token). */
async function resolveToken(): Promise<string | undefined> {
  return runAuth(
    Effect.gen(function* () {
      return yield* (yield* Auth.Service).getAccessToken()
    }),
  ).catch(() => undefined)
}

// ── project resolution (unit-tested) ─────────────────────────────────────────

export interface ResolveProjectResult {
  /** The project id to attach to uploads, or undefined for org-level upload. */
  readonly projectId: string | undefined
  /**
   * A one-time hint to show the user when no project could be auto-resolved
   * (zero or many projects), nudging them toward `--project`.
   */
  readonly hint?: string
}

const PROJECT_HINT = "Tip: pass --project <id> to group artifacts under a project."

/**
 * Decide which project to associate uploads with:
 *   - explicit `--project` wins;
 *   - else GET /projects?org_id=… and use the project iff there is exactly one;
 *   - else (zero or many) upload at the org level and return a one-time hint.
 * Never throws on a projects-fetch failure — a missing/erroring projects
 * endpoint must not block artifact uploads, so it falls back to org-level.
 */
export async function resolveProject(
  base: string,
  token: string,
  orgId: string,
  explicit?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolveProjectResult> {
  if (explicit) return { projectId: explicit }
  let projects: ProjectInfo[]
  try {
    projects = await fetchProjects(base, token, orgId, fetchImpl)
  } catch {
    // Projects are best-effort; fall back to org-level upload silently.
    return { projectId: undefined }
  }
  if (projects.length === 1) return { projectId: projects[0].id }
  return { projectId: undefined, hint: PROJECT_HINT }
}

// ── push command ─────────────────────────────────────────────────────────────

interface PushArgs {
  dir?: string
  positionalDir?: string
  client?: string
  project?: string
  maxBytes?: number
  dryRun?: boolean
}

const humanBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

async function runPush(args: PushArgs): Promise<void> {
  const maxBytes = args.maxBytes && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX_BYTES
  const dir = args.dir ?? args.positionalDir ?? DEFAULT_OUTPUT_DIR
  const root = Filesystem.resolve(dir)

  UI.empty()
  heading("AIUS artifact upload")
  UI.empty()

  if (!(await Filesystem.exists(root)) || !(await Filesystem.isDir(root))) {
    note(`No output directory at ${root} — nothing to upload.`)
    note(`Pass a directory (e.g. \`aius artifacts push ./output\`) or run from a project root.`)
    UI.empty()
    return
  }

  const { files, skipped } = await walkOutputDir(root, maxBytes)

  for (const f of skipped) {
    warn(`skip ${f.relative} (${humanBytes(f.size)} > max ${humanBytes(maxBytes)})`)
  }

  if (files.length === 0) {
    note(skipped.length > 0 ? "All files were skipped — nothing uploaded." : `${root} is empty — nothing to upload.`)
    UI.empty()
    return
  }

  // ── dry run: list and stop before any network or auth work ──
  if (args.dryRun) {
    note(`Would upload ${files.length} file(s) from ${root}:`)
    for (const f of files) UI.println(`  ${f.relative} ${Style.TEXT_DIM}(${humanBytes(f.size)})${RESET}`)
    UI.empty()
    note(`Dry run — no files were uploaded.`)
    UI.empty()
    return
  }

  // ── auth ──
  const token = await resolveToken()
  if (!token) {
    bad("Not logged in. Run `aius auth login` to add an AIUS API key first.")
    UI.empty()
    process.exitCode = 1
    return
  }

  const base = apiBaseUrlTrimmed()

  // ── resolve org id ──
  let orgId = args.client
  if (!orgId) {
    try {
      const clients = await fetchClients(base, token)
      if (clients.length === 0) {
        bad("No clients found for this account. Pass --client <org_id> explicitly.")
        UI.empty()
        process.exitCode = 1
        return
      }
      orgId = clients[0].id
      note(`Using client ${orgId}${clients[0].name ? ` (${clients[0].name})` : ""}`)
    } catch (e) {
      bad(e instanceof ArtifactsApiError ? e.message : errorMessage(e))
      UI.empty()
      process.exitCode = 1
      return
    }
  } else {
    note(`Using client ${orgId} (from --client)`)
  }

  // ── resolve project (best-effort association) ──
  const project = await resolveProject(base, token, orgId, args.project)
  if (project.projectId) {
    note(`Using project ${project.projectId}${args.project ? " (from --project)" : ""}`)
  } else if (project.hint) {
    note(project.hint)
  }

  note(`Uploading ${files.length} file(s) to ${base}/artifacts`)
  UI.empty()

  let uploaded = 0
  const failures: string[] = []
  for (const f of files) {
    try {
      const bytes = await Filesystem.readBytes(f.absolute)
      await uploadArtifact(base, token, {
        orgId,
        relativePath: f.relative,
        contentBase64: encodeBase64(bytes),
        projectId: project.projectId,
      })
      uploaded++
      ok(`${f.relative} ${Style.TEXT_DIM}(${humanBytes(f.size)})${RESET}`)
    } catch (e) {
      const msg = e instanceof ArtifactsApiError ? e.message : errorMessage(e)
      failures.push(f.relative)
      bad(`${f.relative} — ${msg}`)
    }
  }

  UI.empty()
  const summary = `${uploaded} uploaded, ${skipped.length} skipped, ${failures.length} failed`
  if (failures.length === 0) ok(summary)
  else if (uploaded === 0) bad(summary)
  else warn(summary)
  UI.empty()

  // Exit non-zero only if every attempted upload failed.
  if (files.length > 0 && uploaded === 0) process.exitCode = 1
}

const push: CommandModule = {
  command: "push [dir]",
  describe: "Upload files under an output directory to your AIUS artifacts",
  builder: (yargs) =>
    yargs
      .positional("dir", { type: "string", describe: "directory to upload (default ./output)" })
      .option("dir", { type: "string", describe: "directory to upload (alternative to the positional arg)" })
      .option("client", { type: "string", describe: "org/client id to upload to (default: first client)" })
      .option("project", {
        type: "string",
        describe: "project id to group artifacts under (default: the org's sole project, if any)",
      })
      .option("max-bytes", {
        type: "number",
        describe: `skip files larger than this many bytes (default ${DEFAULT_MAX_BYTES})`,
      })
      .option("dry-run", { type: "boolean", describe: "list what would be uploaded without uploading" })
      .example("aius artifacts push", "upload everything under ./output")
      .example("aius artifacts push ./output", "upload a specific directory")
      .example("aius artifacts push --dry-run", "preview the upload without sending")
      .example("aius artifacts push --client org_123", "upload to a specific client/org")
      .example("aius artifacts push --max-bytes 5000000", "skip files larger than 5 MB"),
  handler: async (raw) => {
    // yargs maps `dir` to both the positional and the option; the option wins
    // when both are present, otherwise fall back to the positional.
    const args = raw as unknown as {
      dir?: string
      client?: string
      project?: string
      maxBytes?: number
      dryRun?: boolean
    }
    try {
      await runPush({
        dir: args.dir,
        client: args.client,
        project: args.project,
        maxBytes: args.maxBytes,
        dryRun: args.dryRun,
      })
    } catch (e) {
      bad(errorMessage(e))
      process.exitCode = 1
    }
  },
}

// ── watch (upload-on-arrive) ──────────────────────────────────────────────────

/** Default poll interval, in milliseconds. */
export const DEFAULT_WATCH_INTERVAL_MS = 2000

/**
 * Build a Manifest from a walk result. Only uploadable files are tracked;
 * oversized (skipped) files are reported separately and never enter the
 * manifest, so a file that shrinks back under the limit is picked up later.
 */
async function manifestFromDisk(root: string, maxBytes: number): Promise<{ manifest: Manifest; skipped: WalkedFile[] }> {
  const { files, skipped } = await walkOutputDir(root, maxBytes)
  const manifest: Manifest = {}
  for (const f of files) {
    const s = Filesystem.stat(f.absolute)
    manifest[f.relative] = { size: f.size, mtimeMs: Number(s?.mtimeMs ?? 0) }
  }
  return { manifest, skipped }
}

/** Sink for watcher events — lets the CLI print pretty lines and the TUI log quietly. */
export interface WatchReporter {
  onUploaded(relative: string, size: number): void
  onFailed(relative: string, message: string): void
  onSkipped(relative: string, size: number, maxBytes: number): void
  /** Transient/non-fatal trouble (dir missing, API unreachable) while polling. */
  onTrouble(message: string): void
}

export interface WatchContext {
  readonly root: string
  readonly base: string
  readonly token: string
  readonly orgId: string
  readonly projectId: string | undefined
  readonly maxBytes: number
}

/**
 * Run exactly one poll: walk the dir, diff against `prev`, upload anything new
 * or changed, and return the manifest to remember. Pure-ish: all IO is funneled
 * through the injected fns so it stays testable. Never throws — failures are
 * reported and swallowed so the surrounding loop keeps running.
 */
export async function watchPollOnce(
  ctx: WatchContext,
  prev: Manifest,
  reporter: WatchReporter,
  deps: {
    readBytes?: (p: string) => Promise<Buffer>
    upload?: typeof uploadArtifact
  } = {},
): Promise<Manifest> {
  const readBytes = deps.readBytes ?? Filesystem.readBytes
  const upload = deps.upload ?? uploadArtifact

  if (!(await Filesystem.exists(ctx.root)) || !(await Filesystem.isDir(ctx.root))) {
    // Directory not created yet — wait for it on a later poll.
    return prev
  }

  let snapshot: { manifest: Manifest; skipped: WalkedFile[] }
  try {
    snapshot = await manifestFromDisk(ctx.root, ctx.maxBytes)
  } catch (e) {
    reporter.onTrouble(`could not read ${ctx.root}: ${errorMessage(e)}`)
    return prev
  }

  for (const s of snapshot.skipped) reporter.onSkipped(s.relative, s.size, ctx.maxBytes)

  const { toUpload, nextManifest } = diffManifest(prev, snapshot.manifest)

  // Track which uploads succeeded so a failed file is retried next poll (we keep
  // its *previous* fingerprint, or omit it entirely if it's brand new).
  const committed: Manifest = { ...prev }
  // Drop entries that no longer exist so re-created files re-upload.
  for (const rel of Object.keys(committed)) {
    if (!(rel in nextManifest)) delete committed[rel]
  }

  for (const rel of toUpload) {
    const fp = nextManifest[rel]
    const abs = path.join(ctx.root, rel.split("/").join(path.sep))
    try {
      const bytes = await readBytes(abs)
      await upload(ctx.base, ctx.token, {
        orgId: ctx.orgId,
        relativePath: rel,
        contentBase64: encodeBase64(bytes),
        projectId: ctx.projectId,
      })
      committed[rel] = fp
      reporter.onUploaded(rel, fp.size)
    } catch (e) {
      const msg = e instanceof ArtifactsApiError ? e.message : errorMessage(e)
      reporter.onFailed(rel, msg)
      // leave `committed[rel]` at its old value (or absent) so we retry.
    }
  }

  return committed
}

/** Handle returned by startWatcher so callers can stop the loop. */
export interface WatcherHandle {
  /** Resolves once the loop has fully stopped. */
  readonly done: Promise<void>
  /** Request a clean stop; idempotent. */
  stop(): void
}

/**
 * Start a polling watcher fiber. Returns immediately with a handle. The loop
 * never throws out — every poll is guarded — so it is safe to start in the
 * background of a long-lived process (the TUI). Call `stop()` to end it.
 */
export function startWatcher(
  ctx: WatchContext,
  reporter: WatchReporter,
  intervalMs: number = DEFAULT_WATCH_INTERVAL_MS,
): WatcherHandle {
  let stopped = false
  let manifest: Manifest = {}

  const loop = async () => {
    while (!stopped) {
      try {
        manifest = await watchPollOnce(ctx, manifest, reporter)
      } catch (e) {
        // watchPollOnce shouldn't throw, but never let the loop die.
        reporter.onTrouble(errorMessage(e))
      }
      if (stopped) break
      await new Promise<void>((r) => setTimeout(r, intervalMs))
    }
  }

  const done = loop()
  return {
    done,
    stop: () => {
      stopped = true
    },
  }
}

interface WatchArgs {
  dir?: string
  client?: string
  project?: string
  maxBytes?: number
  interval?: number
}

async function runWatch(args: WatchArgs): Promise<void> {
  const maxBytes = args.maxBytes && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX_BYTES
  const intervalMs = args.interval && args.interval > 0 ? args.interval * 1000 : DEFAULT_WATCH_INTERVAL_MS
  const dir = args.dir ?? DEFAULT_OUTPUT_DIR
  const root = Filesystem.resolve(dir)

  UI.empty()
  heading("AIUS artifact watch")
  UI.empty()

  // ── auth ──
  const token = await resolveToken()
  if (!token) {
    bad("Not logged in. Run `aius auth login` to add an AIUS API key first.")
    UI.empty()
    process.exitCode = 1
    return
  }

  const base = apiBaseUrlTrimmed()

  // ── resolve org id ──
  let orgId = args.client
  if (!orgId) {
    try {
      const clients = await fetchClients(base, token)
      if (clients.length === 0) {
        bad("No clients found for this account. Pass --client <org_id> explicitly.")
        UI.empty()
        process.exitCode = 1
        return
      }
      orgId = clients[0].id
      note(`Using client ${orgId}${clients[0].name ? ` (${clients[0].name})` : ""}`)
    } catch (e) {
      bad(e instanceof ArtifactsApiError ? e.message : errorMessage(e))
      UI.empty()
      process.exitCode = 1
      return
    }
  } else {
    note(`Using client ${orgId} (from --client)`)
  }

  // ── resolve project ──
  const project = await resolveProject(base, token, orgId, args.project)
  if (project.projectId) {
    note(`Using project ${project.projectId}${args.project ? " (from --project)" : ""}`)
  } else if (project.hint) {
    note(project.hint)
  }

  const reporter: WatchReporter = {
    onUploaded: (rel, size) => ok(`${rel} ${Style.TEXT_DIM}(${humanBytes(size)})${RESET}`),
    onFailed: (rel, msg) => bad(`${rel}: ${msg}`),
    onSkipped: (rel, size, max) => warn(`skip ${rel} (${humanBytes(size)} > max ${humanBytes(max)})`),
    onTrouble: (msg) => note(msg),
  }

  const ctx: WatchContext = { root, base, token, orgId, projectId: project.projectId, maxBytes }
  heading(`▸ watching ${root} (every ${intervalMs / 1000}s)`)
  note("Press Ctrl-C to stop.")
  UI.empty()

  const handle = startWatcher(ctx, reporter, intervalMs)

  await new Promise<void>((resolve) => {
    const onSigint = () => {
      UI.empty()
      note("Stopping watcher…")
      handle.stop()
    }
    process.once("SIGINT", onSigint)
    handle.done.then(() => {
      process.off("SIGINT", onSigint)
      resolve()
    })
  })

  UI.empty()
  ok("Watcher stopped.")
  UI.empty()
}

const watch: CommandModule = {
  command: "watch [dir]",
  describe: "Watch an output directory and upload files as they appear or change",
  builder: (yargs) =>
    yargs
      .positional("dir", { type: "string", describe: "directory to watch (default ./output)" })
      .option("dir", { type: "string", describe: "directory to watch (alternative to the positional arg)" })
      .option("client", { type: "string", describe: "org/client id to upload to (default: first client)" })
      .option("project", {
        type: "string",
        describe: "project id to group artifacts under (default: the org's sole project, if any)",
      })
      .option("max-bytes", {
        type: "number",
        describe: `skip files larger than this many bytes (default ${DEFAULT_MAX_BYTES})`,
      })
      .option("interval", {
        type: "number",
        describe: `seconds between scans (default ${DEFAULT_WATCH_INTERVAL_MS / 1000})`,
      })
      .example("aius artifacts watch", "watch ./output and upload as files arrive")
      .example("aius artifacts watch ./output --interval 5", "watch a directory, scanning every 5s")
      .example("aius artifacts watch --project proj_123", "upload watched files under a project"),
  handler: async (raw) => {
    const args = raw as unknown as {
      dir?: string
      client?: string
      project?: string
      maxBytes?: number
      interval?: number
    }
    try {
      await runWatch({
        dir: args.dir,
        client: args.client,
        project: args.project,
        maxBytes: args.maxBytes,
        interval: args.interval,
      })
    } catch (e) {
      bad(errorMessage(e))
      process.exitCode = 1
    }
  },
}

export const ArtifactsCommand: CommandModule = {
  command: "artifacts",
  describe: "Manage AIUS artifacts (push output files to your account)",
  builder: (yargs) =>
    yargs
      .command(push)
      .command(watch)
      .example("aius artifacts push", "upload everything under ./output")
      .example("aius artifacts watch", "upload files as they appear under ./output")
      .example("aius artifacts push --dry-run", "preview what would upload")
      .demandCommand(1, "Run `aius artifacts push` to upload your output/ directory."),
  handler: () => {
    UI.empty()
    heading("AIUS artifacts")
    UI.empty()
    UI.println(`  ${Style.TEXT_NORMAL_BOLD}aius artifacts push [dir]${RESET}    Upload files under output/ to your account`)
    UI.println(`  ${Style.TEXT_NORMAL_BOLD}aius artifacts watch [dir]${RESET}   Upload files as they appear under output/`)
    UI.empty()
    note("Run `aius artifacts <push|watch> --help` for flags.")
    UI.empty()
  },
}
