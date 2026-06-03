import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import * as Log from "@aius-ai/core/util/log"
import { InstallationVersion, InstallationChannel } from "@aius-ai/core/installation/version"
import { NamedError } from "@aius-ai/core/util/error"
import { FormatError } from "./cli/error"
import { UI } from "./cli/ui"
import { Filesystem } from "@/util/filesystem"
import { EOL } from "os"
import path from "path"
import { Global } from "@aius-ai/core/global"
import { JsonMigration } from "@/storage/json-migration"
import { Database } from "@/storage/db"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureProcessMetadata } from "@aius-ai/core/util/aius-process"
import { isRecord } from "@/util/record"
import { Rpc } from "@/util/rpc"
import type { GlobalEvent } from "@aius-ai/sdk/v2"
import { type rpc } from "./cli/cmd/tui/worker"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { AIUS_PROCESS_ROLE, AIUS_RUN_ID, ensureRunID, sanitizedProcessEnv } from "@aius-ai/core/util/aius-process"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { writeHeapSnapshot } from "v8"
import { withTimeout } from "@/util/timeout"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./cli/cmd/tui/win32"
import { validateSession } from "./cli/cmd/tui/validate-session"
import { Preflight } from "./cli/preflight"
import { ServerAuth } from "@/server/auth"
import { Init } from "@/ds/init"
import { AuthCommand } from "./cli/cmd/auth"
import { ArtifactsCommand } from "./cli/cmd/artifacts"
import { startAutoUpload } from "./cli/auto-upload"

declare global {
  const AIUS_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient) {
  return {
    subscribe: async (handler: (event: GlobalEvent) => void) => {
      return client.on("global.event", (e: unknown) => {
        handler(e as GlobalEvent)
      })
    },
  }
}

async function workerTarget() {
  if (typeof AIUS_WORKER_PATH !== "undefined") return AIUS_WORKER_PATH
  const { fileURLToPath } = await import("url")
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./cli/cmd/tui/worker.ts", import.meta.url)
}

async function stdinInput(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  // envPWD wins over cwd so that wrappers like ~/.bun/bin/aius that use
  // `bun run --cwd …` for module resolution don't accidentally pin the
  // project to the package directory. The shell-exported PWD reflects
  // the directory the user actually ran the command from.
  return Filesystem.resolve(envPWD ?? cwd)
}

const isLocal = () => InstallationChannel === "local"

const processMetadata = ensureProcessMetadata("main")

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("aius ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("aius")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .option("reset", {
    describe: "wipe local session/conversation state before starting (auth is preserved)",
    type: "boolean",
  })
  .middleware(async (opts) => {
    // --help / --version / completion exit immediately after yargs prints;
    // skip side-effects (logging init, DB migration) that don't belong on
    // those paths and slow them noticeably.
    const args = process.argv.slice(2)
    const isInformational =
      args.includes("--help") ||
      args.includes("-h") ||
      args.includes("--version") ||
      args.includes("-v") ||
      args[0] === "completion"
    if (isInformational) return

    if (opts.pure) {
      process.env.AIUS_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.AIUS = "1"
    process.env.AIUS_PID = String(process.pid)

    Log.Default.info("aius", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    if (opts.reset) {
      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())

      // Single source of truth: the same teardown the in-app resume-gate uses.
      // Rolls back to the aius baseline (dropping agent artefacts like a
      // generated CONTEXT.md), moves data/raw/* back to data/, and wipes the
      // scaffolding — so `--reset` and the gate behave identically.
      const { moved, conflicts, removed } = await Init.reset(root)

      const lines: string[] = []
      if (moved.length > 0) lines.push(`Moved back to data/: ${moved.map((m) => `\`${m}\``).join(", ")}`)
      if (conflicts.length > 0)
        lines.push(`Left in data/raw/ (name collision in data/): ${conflicts.map((c) => `\`${c}\``).join(", ")}`)
      if (removed.length > 0) lines.push(`Removed: ${removed.map((r) => `\`${r}\``).join(", ")}`)
      if (lines.length === 0) lines.push(`Project reset: nothing to undo in ${root}.`)
      else lines.unshift(`Project reset (${root}):`)
      process.stderr.write(lines.join(EOL) + EOL)
      process.exit(0)
    }

    const marker = path.join(Global.Path.data, "aius.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      // 24-bit ANSI for brand violet #de7bff (theme.primary equivalent at the CLI layer).
      const orange = "\x1b[38;2;222;123;255m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AuthCommand)
  .command(ArtifactsCommand)
  .command(
    "$0 [project]",
    "start aius tui",
    (yargs) =>
      withNetworkOptions(yargs)
        .positional("project", {
          type: "string",
          describe: "path to start aius in",
        })
        .option("model", {
          type: "string",
          alias: ["m"],
          describe: "model to use in the format of provider/model",
        })
        .option("continue", {
          alias: ["c"],
          describe: "continue the last session",
          type: "boolean",
        })
        .option("session", {
          alias: ["s"],
          type: "string",
          describe: "session id to continue",
        })
        .option("fork", {
          type: "boolean",
          describe: "fork the session when continuing (use with --continue or --session)",
        })
        .option("prompt", {
          type: "string",
          describe: "prompt to use",
        })
        .option("agent", {
          type: "string",
          describe: "agent to use",
        })
        .option("force", {
          type: "boolean",
          describe: "skip prompts for non-canonical project files at init",
        }),
    async (args) => {
      const unguard = win32InstallCtrlCGuard()
      try {
        win32DisableProcessedInput()

        if (args.fork && !args.continue && !args.session) {
          UI.error("--fork requires --continue or --session")
          process.exitCode = 1
          return
        }

        const next = resolveThreadDirectory(args.project)
        const file = await workerTarget()
        try {
          process.chdir(next)
        } catch {
          UI.error("Failed to change directory to " + next)
          return
        }
        const cwd = Filesystem.resolve(process.cwd())

        // Boot can take a while on first run (Python env + the data-science
        // libraries). Print progress to the terminal BEFORE the TUI takes the
        // screen so the user isn't staring at a frozen prompt. Stays quiet on a
        // healthy boot (onProgress only fires for real work).
        process.stderr.write("Starting Aius…" + EOL)
        const initStatus = await Init.run({
          projectRoot: cwd,
          onProgress: (message) => process.stderr.write("  " + message + EOL),
          confirmNonCanonical: args.force
            ? async () => true
            : async () => {
                if (!process.stdin.isTTY) return false
                const answer = await UI.input("Continue anyway? [y/N] ")
                return /^y(es)?$/i.test(answer)
              },
        })
        if (initStatus.kind !== "ok") {
          process.stderr.write(UI.logo() + EOL + EOL)
          process.stderr.write(Init.explain(initStatus) + EOL)
          process.exitCode = 2
          return
        }

        // Before the TUI takes the screen, confirm the backend run-loop proxy is
        // reachable — the agent loop runs server-side, so an unreachable proxy
        // means nothing will work. A clear message here beats a silent failure
        // on the first prompt. Bad credentials are surfaced inside the TUI.
        if (!process.env["AIUS_SKIP_PREFLIGHT"]) {
          const base = Preflight.proxyBaseUrl()
          const { reachable } = await Preflight.checkProxyReachable(base)
          if (!reachable) {
            process.stderr.write(UI.logo() + EOL + EOL)
            process.stderr.write(Preflight.unreachableMessage(base) + EOL)
            process.exitCode = 2
            return
          }
        }
        // Auto-upload artifacts: start a background poll-watcher on ./output so
        // files the agent produces are uploaded the moment they appear. Fully
        // self-contained and guarded — it can never crash or block the TUI, and
        // it does not touch the agent run loop. Default ON for logged-in users;
        // disable with AIUS_AUTO_UPLOAD_ARTIFACTS=0. Fire-and-forget so it never
        // delays the TUI boot; we keep the promise so shutdown can stop it.
        const autoUpload = startAutoUpload(cwd).catch((err) => {
          Log.Default.warn("auto-upload start failed", { error: errorMessage(err) })
          return undefined
        })

        const env = sanitizedProcessEnv({
          [AIUS_PROCESS_ROLE]: "worker",
          [AIUS_RUN_ID]: ensureRunID(),
        })

        const worker = new Worker(file, { env })
        worker.onerror = (e) => {
          Log.Default.error("thread error", {
            message: e.message,
            filename: e.filename,
            lineno: e.lineno,
            colno: e.colno,
            error: e.error,
          })
        }

        const client = Rpc.client<typeof rpc>(worker)
        const error = (e: unknown) => {
          Log.Default.error("process error", { error: errorMessage(e) })
        }
        const reload = () => {
          client.call("reload", undefined).catch((err) => {
            Log.Default.warn("worker reload failed", { error: errorMessage(err) })
          })
        }
        process.on("uncaughtException", error)
        process.on("unhandledRejection", error)
        process.on("SIGUSR2", reload)

        let stopped = false
        const stop = async () => {
          if (stopped) return
          stopped = true
          process.off("uncaughtException", error)
          process.off("unhandledRejection", error)
          process.off("SIGUSR2", reload)
          // Stop the artifact auto-upload watcher (best-effort; never blocks).
          await autoUpload
            .then((handle) => handle?.stop())
            .catch((err) => Log.Default.debug("auto-upload stop failed", { error: errorMessage(err) }))
          await withTimeout(client.call("shutdown", undefined), 5000).catch((err) => {
            Log.Default.warn("worker shutdown failed", { error: errorMessage(err) })
          })
          worker.terminate()
        }

        const prompt = await stdinInput(args.prompt)
        const config = await TuiConfig.get()

        const network = resolveNetworkOptionsNoConfig(args)
        const external =
          process.argv.includes("--port") ||
          process.argv.includes("--hostname") ||
          process.argv.includes("--mdns") ||
          network.mdns ||
          network.port !== 0 ||
          network.hostname !== "127.0.0.1"

        const transport = external
          ? {
              url: (await client.call("server", network)).url,
              fetch: undefined as typeof fetch | undefined,
              events: undefined as ReturnType<typeof createEventSource> | undefined,
            }
          : {
              url: "http://aius.internal",
              fetch: createWorkerFetch(client),
              events: createEventSource(client),
            }

        try {
          await validateSession({
            url: transport.url,
            sessionID: args.session,
            directory: cwd,
            fetch: transport.fetch,
          })
        } catch (error) {
          UI.error(errorMessage(error))
          process.exitCode = 1
          return
        }

        setTimeout(() => {
          client.call("checkUpgrade", { directory: cwd }).catch(() => {})
        }, 1000).unref?.()

        try {
          const { createTuiRenderer, tui } = await import("./cli/cmd/tui/app")
          const renderer = await createTuiRenderer(config)
          const handle = tui({
            url: transport.url,
            renderer,
            async onSnapshot() {
              const tuiSnap = writeHeapSnapshot("tui.heapsnapshot")
              const serverSnap = await client.call("snapshot", undefined)
              return [tuiSnap, serverSnap]
            },
            config,
            directory: cwd,
            fetch: transport.fetch,
            events: transport.events,
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
            },
          })
          await handle.done
        } finally {
          await stop()
        }
      } finally {
        unguard?.()
      }
      process.exit(0)
    },
  )
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
