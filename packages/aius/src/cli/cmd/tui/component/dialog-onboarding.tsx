import { createSignal, Show } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { apiBaseUrlTrimmed } from "@/config/api-url"

export function DialogOnboarding(props: { onComplete: () => void }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [error, setError] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)

  function validate(input: string): string | null {
    // The AIUS key authenticates this client to the AIUS server (a static
    // AIUS_API_KEY or an `aius_…` token) — not an LLM provider key, so no fixed
    // prefix/length to enforce.
    if (!input) return "Enter your AIUS API key"
    return null
  }

  async function submit(value: string) {
    const input = value.trim()
    const validationError = validate(input)
    if (validationError) {
      setError(validationError)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      // Verify the key against the AIUS server before saving so typos are caught
      // immediately. If the server is unreachable, don't block — save anyway.
      const base = apiBaseUrlTrimmed()
      let rejected = false
      try {
        const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${input}` } })
        rejected = res.status === 401 || res.status === 403
      } catch {
        // unreachable — fall through and save
      }
      if (rejected) {
        setError("That key was rejected by the AIUS server (401). Check it and try again.")
        setSubmitting(false)
        return
      }
      await sdk.client.auth.set({
        providerID: "openrouter",
        auth: { type: "api", key: input },
      })
      await sdk.client.instance.dispose()
      await sync.bootstrap()
      dialog.clear()
      props.onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key")
      setSubmitting(false)
    }
  }

  return (
    <DialogPrompt
      title="Welcome to Aius"
      placeholder="aius_..."
      busy={submitting()}
      busyText="Saving key..."
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>Enter your AIUS API key to get started.</text>
          <text fg={theme.textMuted}>
            It authenticates this client to the AIUS server — no LLM provider key needed.
          </text>
          <Show when={error()}>
            <text fg={theme.error}>{error()}</text>
          </Show>
          <text fg={theme.textMuted}>
            Stored at ~/.local/share/aius/auth.json (mode 0600).
          </text>
          <text fg={theme.textMuted}>Coming soon: sign in with Google or GitHub.</text>
        </box>
      )}
      onConfirm={submit}
    />
  )
}
