import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import * as Clipboard from "@tui/util/clipboard"
import * as Selection from "@tui/util/selection"
import * as TuiAudio from "@tui/util/audio"
import { createCliRenderer, MouseButton, type CliRenderer, type CliRendererConfig } from "@opentui/core"
import { RouteProvider, useRoute } from "@tui/context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  on,
} from "solid-js"
import { win32DisableProcessedInput, win32FlushInputBuffer, win32InstallCtrlCGuard } from "./win32"
import { Flag } from "@aius-ai/core/flag/flag"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderList } from "@tui/component/dialog-provider"
import { ErrorComponent } from "@tui/component/error-component"
import { PluginRouteMissing } from "@tui/component/plugin-route-missing"
import { ProjectProvider, useProject } from "@tui/context/project"
import { EditorContextProvider } from "@tui/context/editor"
import { useEvent } from "@tui/context/event"
import { SDKProvider, useSDK } from "@tui/context/sdk"
import { StartupLoading } from "@tui/component/startup-loading"
import { SyncProvider, useSync } from "@tui/context/sync"
import { SyncProviderV2 } from "@tui/context/sync-v2"
import { LocalProvider, useLocal } from "@tui/context/local"
import { DialogAccount } from "@tui/component/dialog-account"
import { checkStoredCredential } from "@tui/util/auth-check"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Home } from "@tui/routes/home"
import { Session } from "@tui/routes/session"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { DialogConfirm } from "./ui/dialog-confirm"
import { ToastProvider, useToast } from "./ui/toast"
import { createExit, ExitProvider, useExit, type Exit } from "./context/exit"
import { Session as SessionApi } from "@/session/session"
import { TuiEvent } from "./event"
import { KVProvider, useKV } from "./context/kv"
import { Provider } from "@/provider/provider"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig } from "./context/tui-config"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { createTuiApi } from "@/cli/cmd/tui/plugin/api"
import type { RouteMap } from "@/cli/cmd/tui/plugin/api"
import { createTuiAttention } from "@/cli/cmd/tui/attention"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { CommandPaletteDialog } from "./component/command-palette"
import {
  COMMAND_PALETTE_COMMAND,
  AIUS_BASE_MODE,
  AiusKeymapProvider,
  registerAiusKeymap,
  useBindings,
  useAiusKeymap,
} from "./keymap"

import type { EventSource } from "./context/sdk"

const appGlobalBindingCommands = [] as const

const appBindingCommands = [
  "command.palette.show",
  "account.open",
  "model.list",
  "model.cycle_recent",
  "model.cycle_recent_reverse",
  "aius.status",
  "help.show",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
] as const

export function tuiRendererConfig(_config: TuiConfig.Resolved): CliRendererConfig {
  const mouseEnabled = !Flag.AIUS_DISABLE_MOUSE && (_config.mouse ?? true)

  return {
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: mouseEnabled,
    consoleOptions: {
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
      onCopySelection: (text) => {
        Clipboard.copy(text).catch((error) => {
          console.error(`Failed to copy console selection to clipboard: ${error}`)
        })
      },
    },
  }
}

export function createTuiRenderer(config: TuiConfig.Resolved) {
  return createCliRenderer(tuiRendererConfig(config))
}

export type TuiHandle = {
  ready: Promise<void>
  done: Promise<void>
  exit: Exit
}

type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  renderer: CliRenderer
  onSnapshot?: () => Promise<string[]>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
}

type TuiLifecycle = {
  exit: Exit
  exited: Promise<void>
  fail(error: unknown): Promise<never>
}

function errorMessage(error: unknown) {
  const formatted = FormatError(error)
  if (formatted !== undefined) return formatted
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return FormatUnknownError(error)
}

export function tui(input: TuiInput): TuiHandle {
  const unguard = win32InstallCtrlCGuard()
  win32DisableProcessedInput()

  const renderer = input.renderer
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const unregisterKeymap = registerAiusKeymap(keymap, renderer, input.config)
  const lifecycle = createTuiLifecycle({
    renderer,
    unguard,
    cleanup: async () => {
      unregisterKeymap()
      await TuiPluginRuntime.dispose()
      TuiAudio.dispose()
    },
  })
  const ready = mountTui({ ...input, keymap, exit: lifecycle.exit }).catch((error) => lifecycle.fail(error))
  const done = waitUntilDone(ready, lifecycle.exited)

  return { ready, done, exit: lifecycle.exit }
}

async function mountTui(input: TuiInput & { keymap: ReturnType<typeof createDefaultOpenTuiKeymap>; exit: Exit }) {
  const renderer = input.renderer
  // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
  void renderer.getPalette({ size: 16 }).catch(() => undefined)
  const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"
  if (renderer.isDestroyed) return

  await render(() => {
    return (
      <ErrorBoundary
        fallback={(error, reset) => <ErrorComponent error={error} reset={reset} exit={input.exit} mode={mode} />}
      >
        <AiusKeymapProvider keymap={input.keymap}>
          <ArgsProvider {...input.args}>
            <ExitProvider exit={input.exit}>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider
                    initialRoute={
                      input.args.continue
                        ? {
                            type: "session",
                            sessionID: "dummy",
                          }
                        : undefined
                    }
                  >
                    <TuiConfigProvider config={input.config}>
                      <SDKProvider
                        url={input.url}
                        directory={input.directory}
                        fetch={input.fetch}
                        headers={input.headers}
                        events={input.events}
                      >
                        <ProjectProvider>
                          <SyncProvider>
                            <SyncProviderV2>
                              <ThemeProvider mode={mode}>
                                <LocalProvider>
                                  <PromptStashProvider>
                                    <DialogProvider>
                                      <FrecencyProvider>
                                        <PromptHistoryProvider>
                                          <PromptRefProvider>
                                            <EditorContextProvider>
                                              <App onSnapshot={input.onSnapshot} />
                                            </EditorContextProvider>
                                          </PromptRefProvider>
                                        </PromptHistoryProvider>
                                      </FrecencyProvider>
                                    </DialogProvider>
                                  </PromptStashProvider>
                                </LocalProvider>
                              </ThemeProvider>
                            </SyncProviderV2>
                          </SyncProvider>
                        </ProjectProvider>
                      </SDKProvider>
                    </TuiConfigProvider>
                  </RouteProvider>
                </ToastProvider>
              </KVProvider>
            </ExitProvider>
          </ArgsProvider>
        </AiusKeymapProvider>
      </ErrorBoundary>
    )
  }, renderer)
}

function createTuiLifecycle(input: {
  renderer: CliRenderer
  unguard?: () => void
  cleanup: () => Promise<void>
}): TuiLifecycle {
  let resolveExited!: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })
  let exitCompleted = false
  let exiting = false
  let cleanupTask: Promise<void> | undefined

  const completeExit = () => {
    if (exitCompleted) return
    exitCompleted = true
    resolveExited()
  }

  const cleanup = () => {
    cleanupTask ??= (async () => {
      process.off("SIGHUP", onSighup)
      try {
        await input.cleanup()
      } finally {
        input.unguard?.()
      }
    })()
    return cleanupTask
  }

  const exit = createExit(async (reason, message) => {
    exiting = true
    await cleanup()
    if (!input.renderer.isDestroyed) {
      input.renderer.setTerminalTitle("")
      input.renderer.destroy()
    }
    win32FlushInputBuffer()
    if (reason) {
      const formatted = FormatError(reason) ?? FormatUnknownError(reason)
      if (formatted) process.stderr.write(formatted + "\n")
    }
    const text = message()
    if (text) process.stdout.write(text + "\n")
    completeExit()
  })
  const onSighup = () => {
    void exit()
  }

  input.renderer.once("destroy", () => {
    if (exiting) return
    void cleanup().finally(() => {
      win32FlushInputBuffer()
      completeExit()
    })
  })
  process.on("SIGHUP", onSighup)

  return {
    exit,
    exited,
    async fail(error) {
      exiting = true
      await cleanup().catch(() => {})
      if (!input.renderer.isDestroyed) input.renderer.destroy()
      completeExit()
      throw error
    },
  }
}

async function waitUntilDone(ready: Promise<void>, exited: Promise<void>) {
  await ready
  await exited
}

function App(props: { onSnapshot?: () => Promise<string[]> }) {
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useAiusKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme } = themeState
  const sync = useSync()
  const project = useProject()
  const exit = useExit()
  const promptRef = usePromptRef()
  const routes: RouteMap = new Map()
  const [routeRev, setRouteRev] = createSignal(0)
  const routeView = (name: string) => {
    routeRev()
    return routes.get(name)?.at(-1)?.render
  }
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })

  const api = createTuiApi({
    tuiConfig,
    dialog,
    keymap,
    kv,
    route,
    routes,
    bump: () => setRouteRev((x) => x + 1),
    event,
    sdk,
    sync,
    theme: themeState,
    toast,
    renderer,
    attention,
  })
  const [ready, setReady] = createSignal(false)
  TuiPluginRuntime.init({
    api,
    config: tuiConfig,
    dispose: () => attention.dispose(),
  })
    .catch((error) => {
      console.error("Failed to load TUI plugins", error)
    })
    .finally(() => {
      setReady(true)
    })

  // Let selection copy/dismiss win ahead of normal bindings when the feature flag is on.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.AIUS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.AIUS_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("Aius")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || SessionApi.isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("Aius")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`OC | ${title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`OC | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Provider.parseModel(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  const [dsCreatedAt, setDsCreatedAt] = createSignal<number | undefined>(undefined)
  const [dsLoaded, setDsLoaded] = createSignal(false)
  createEffect(() => {
    const directory = project.instance.path().directory
    if (!directory) {
      setDsLoaded(true)
      return
    }
    void (async () => {
      try {
        const { State } = await import("@/ds/state")
        if (await State.exists(directory)) {
          const state = await State.load(directory).catch(() => undefined)
          if (state) setDsCreatedAt(new Date(state.created_at).getTime())
        }
      } finally {
        setDsLoaded(true)
      }
    })()
  })

  createEffect(() => {
    // Auto-resume the most recently-updated session that belongs to the
    // *current* `.aius` instance. `.aius/project.json#created_at` is the
    // anchor: only sessions created after that timestamp count as part of
    // this instance. When the user deletes `.aius/` and re-runs aius, the
    // anchor moves forward and old sessions no longer auto-resume — so
    // `.aius` truly owns the project's conversational state.
    if (continued || sync.status === "loading") return
    if (args.sessionID || args.fork) return
    if (!dsLoaded()) return
    const cutoff = dsCreatedAt() ?? 0
    const match = sync.data.session
      .filter((x) => x.parentID === undefined && x.time.created >= cutoff)
      .toSorted((a, b) => b.time.updated - a.time.updated)[0]?.id
    if (match) {
      continued = true
      route.navigate({ type: "session", sessionID: match })
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  // First-run / logged-out gate: when no AIUS credential is connected, open the
  // unified account dialog (login / register / paste API key) — NOT the legacy
  // PAT-only onboarding, which would collide with the account dialog opened by
  // the credential check below.
  createEffect(
    on(
      () => sync.ready && !sync.data.provider_next.connected.includes("openrouter"),
      (needsOnboarding, wasNeeded) => {
        if (!needsOnboarding || wasNeeded) return
        dialog.replace(() => <DialogAccount />)
      },
    ),
  )

  // Startup credential check: when a token IS present, verify it against the
  // AIUS API up front. A stale/revoked key (e.g. after a server token-store
  // reset) otherwise only surfaces as the opaque run-loop 1008 once the user
  // tries to run something. On "invalid" we AUTO-LOGOUT (remove the bad token so
  // the UI reflects reality — "Not logged in") and open the account dialog to
  // re-login. "unreachable" is ignored (don't punish a good token when down).
  let credentialChecked = false
  createEffect(
    on(
      () => sync.ready && sync.data.provider_next.connected.includes("openrouter"),
      (connected) => {
        if (!connected || credentialChecked) return
        credentialChecked = true
        void checkStoredCredential().then(async (result) => {
          if (result !== "invalid") return
          // Clear the stale token so the session state is honest, then re-prompt.
          await sdk.client.auth.remove({ providerID: "openrouter" }).catch(() => {})
          await sdk.client.instance.dispose().catch(() => {})
          await sync.bootstrap().catch(() => {})
          toast.show({ message: "Your AIUS session expired — please log in again.", variant: "error" })
          dialog.replace(() => <DialogAccount />)
        })
      },
    ),
  )

  createEffect(
    on(
      () =>
        sync.status === "complete" &&
        sync.data.provider.length === 0 &&
        sync.data.provider_next.connected.includes("openrouter"),
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        // (and only when openrouter is already connected — otherwise the
        // first-run DialogOnboarding effect above is responsible for the gate)
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  const currentWorktreeWorkspace = createMemo(() => {
    const workspaceID = project.workspace.current()
    if (!workspaceID) return
    const workspace = project.workspace.get(workspaceID)
    if (workspace?.type !== "worktree" || !workspace.directory) return
    return workspace
  })
  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: "Show command palette",
        category: "System",
        hidden: true,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "workspace.copy_path",
        title: "Copy worktree path",
        category: "Workspace",
        enabled: () => currentWorktreeWorkspace() !== undefined,
        run: async () => {
          const workspace = currentWorktreeWorkspace()
          if (!workspace?.directory) return
          await Clipboard.copy(workspace.directory)
            .then(() => toast.show({ message: "Copied worktree path", variant: "info" }))
            .catch(toast.error)
          dialog.clear()
        },
      },
      // Model selection is intentionally not user-managed in Aius — every
      // session runs on the single Aius default (claude-opus-4-7, high
      // effort, throughput-routed). The picker/cycle commands are kept off
      // the palette so the user is not tempted to fiddle with something the
      // product owns.
      {
        name: "app.exit",
        title: "Exit the app",
        slashName: "exit",
        slashAliases: ["quit", "q"],
        run: () => exit(),
        category: "System",
      },
      {
        name: "account.open",
        title: "Account (login / register / logout)",
        slashName: "account",
        category: "System",
        run: () => {
          dialog.replace(() => <DialogAccount />)
        },
      },
      {
        name: "terminal.suspend",
        title: "Suspend terminal",
        category: "System",
        hidden: true,
        enabled: process.platform !== "win32",
        run: () => {
          process.once("SIGCONT", () => {
            renderer.resume()
          })

          renderer.suspend()
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
        category: "System",
        run: () => {
          setTerminalTitleEnabled((prev) => {
            const next = !prev
            kv.set("terminal_title_enabled", next)
            if (!next) renderer.setTerminalTitle("")
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
        category: "System",
        run: () => {
          kv.set("animations_enabled", !kv.get("animations_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.file_context",
        title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
        category: "System",
        run: () => {
          kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
        category: "System",
        run: () => {
          const current = kv.get("diff_wrap_mode", "word")
          kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
        category: "System",
        run: () => {
          setPasteSummaryEnabled((prev) => {
            const next = !prev
            kv.set("paste_summary_enabled", next)
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.session_directory_filter",
        title: kv.get("session_directory_filter_enabled", true)
          ? "Disable session directory filtering"
          : "Enable session directory filtering",
        category: "System",
        run: async () => {
          kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
          await sync.session.refresh()
          dialog.clear()
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  )

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: AIUS_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: AIUS_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  event.on(TuiEvent.CommandExecute.type, (evt) => {
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on(TuiEvent.ToastShow.type, (evt) => {
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on(TuiEvent.SessionSelect.type, (evt) => {
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt) => {
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    const render = routeView(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.AIUS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={Flag.AIUS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? undefined : () => Selection.copy(renderer, toast)}
    >
      <Show when={Flag.AIUS_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Session />
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <TuiPluginRuntime.Slot name="app_bottom" />
        </box>
        <TuiPluginRuntime.Slot name="app" />
      </Show>
      <StartupLoading ready={ready} />
    </box>
  )
}
