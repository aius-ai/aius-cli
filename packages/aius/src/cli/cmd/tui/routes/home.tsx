import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast, useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useLocal } from "../context/local"
import { useBindings, useCommandShortcut } from "../keymap"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { useEditorContext } from "@tui/context/editor"
import { setFreshSessionID, markEngaged } from "./session/fresh"
import { AIUS_AUTH_KEY } from "@/auth"
import { useDialog } from "@tui/ui/dialog"
import { DialogAccount } from "@tui/component/dialog-account"

const BEGIN_COMMAND = "home.begin"

// Hint line showing the account keybinding + current login state, so the user
// can discover how to log in / out (the combo opens the account dialog).
function AccountHint() {
  const { theme } = useTheme()
  const sync = useSync()
  const shortcut = useCommandShortcut("account.open")
  const loggedIn = createMemo(() => !!sync.data?.provider_next?.connected?.includes(AIUS_AUTH_KEY))
  return (
    <Show when={shortcut()}>
      <text fg={theme.textMuted}>
        {loggedIn() ? "Logged in · " : "Not logged in · "}
        <span style={{ fg: theme.text, bold: true }}>{shortcut()}</span> account (login / register / logout)
      </text>
    </Show>
  )
}

function BeginButton() {
  const sdk = useSDK()
  const route = useRoute()
  const local = useLocal()
  const toast = useToast()
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const loggedIn = createMemo(() => !!sync.data?.provider_next?.connected?.includes(AIUS_AUTH_KEY))
  const [pressing, setPressing] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)

  const accent = createMemo(() => {
    if (pressing() || submitting()) return theme.accent
    return theme.primary
  })

  async function begin() {
    if (submitting()) return
    // Login is required before anything else — without a valid AIUS session the
    // run can't reach the server, so prompt to log in rather than complaining
    // about a model the user can't use yet.
    if (!loggedIn()) {
      dialog.replace(() => <DialogAccount />)
      return
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      toast.show({ message: "Pick a model first", variant: "warning" })
      return
    }
    const agent = local.agent.current()
    if (!agent) {
      toast.show({ message: "No agent available", variant: "warning" })
      return
    }
    setSubmitting(true)
    try {
      const variant = local.model.variant.current()
      const res = await sdk.client.session.create({
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          id: selectedModel.modelID,
          ...(variant ? { variant } : {}),
        },
      })
      if (res.error || !res.data) {
        toast.show({ message: "Failed to start session", variant: "error" })
        setSubmitting(false)
        return
      }
      // mark this as a freshly-created, engaged session so the session view
      // auto-kicks the pipeline and treats later interrupts as Continue/Chat
      // (not a cold resume)
      setFreshSessionID(res.data.id)
      markEngaged(res.data.id)
      route.navigate({ type: "session", sessionID: res.data.id })
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : "Failed to start session", variant: "error" })
      setSubmitting(false)
    }
  }

  useBindings(() => ({
    // Disable the home Enter/Space binding while any dialog is open — otherwise
    // it competes with the dialog's own keys (e.g. the account dialog), so the
    // first Enter fires `begin()` here (which just re-opens the account dialog)
    // and the user has to press Enter twice to actually select an option.
    enabled: dialog.stack.length === 0,
    commands: [
      {
        name: BEGIN_COMMAND,
        title: "Start a new session",
        run: () => {
          void begin()
        },
      },
    ],
    bindings: [{ key: "enter,return,space", cmd: BEGIN_COMMAND, desc: "Start a new session" }],
  }))

  const ready = () => sync.ready && local.model.ready && Boolean(local.model.current())

  return (
    <box
      border={["top", "bottom", "left", "right"]}
      borderColor={ready() ? accent() : theme.borderSubtle}
      paddingLeft={4}
      paddingRight={4}
      paddingTop={1}
      paddingBottom={1}
      onMouseDown={() => {
        setPressing(true)
      }}
      onMouseUp={() => {
        setPressing(false)
        void begin()
      }}
    >
      <text fg={ready() ? theme.text : theme.textMuted}>
        <Show when={submitting()} fallback={
          <>
            Press <span style={{ fg: accent(), bold: true }}>[ENTER]</span> to process dataset
          </>
        }>
          <span style={{ fg: theme.textMuted }}>Starting…</span>
        </Show>
      </text>
    </box>
  )
}

export function Home() {
  const editor = useEditorContext()

  onMount(() => {
    editor.clearSelection()
  })

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <Logo gradient idle />
          </TuiPluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box paddingTop={2} flexShrink={0}>
          <BeginButton />
        </box>
        <box paddingTop={1} flexShrink={0} alignItems="center">
          <AccountHint />
        </box>
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
