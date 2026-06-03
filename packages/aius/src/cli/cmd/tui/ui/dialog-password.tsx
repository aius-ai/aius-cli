import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { useAiusKeymap } from "../keymap"

export type DialogPasswordProps = {
  title: string
  description?: () => JSX.Element
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

/**
 * Single-line password prompt with a hide/show toggle.
 *
 * opentui's <input> insists on drawing its own buffer, so neither recolouring
 * nor off-screen layout reliably hid the text. Instead we own input entirely:
 * a raw key interceptor builds the password string, and WE render the only
 * visible representation (bullets, or cleartext when revealed). The cleartext
 * never lives in any drawn widget, so it cannot leak.
 *
 *   printable keys → appended    backspace → delete last
 *   enter → submit               ctrl+s → toggle reveal     esc → cancel
 */
export function DialogPassword(props: DialogPasswordProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keymap = useAiusKeymap()
  const [value, setValue] = createSignal("")
  const [reveal, setReveal] = createSignal(false)

  onMount(() => {
    dialog.setSize("medium")
    // Highest-priority raw key interceptor while this dialog is open. Consume
    // every key we handle so it never reaches the focused input layer.
    const off = keymap.intercept(
      "key",
      (ctx) => {
        const e = ctx.event as { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }
        const name = e.name ?? ""

        if (name === "escape") {
          ctx.consume()
          props.onCancel?.()
          return
        }
        if (name === "return" || name === "enter") {
          ctx.consume()
          props.onConfirm?.(value())
          return
        }
        if (e.ctrl && name === "s") {
          ctx.consume()
          setReveal((r) => !r)
          return
        }
        if (name === "backspace") {
          ctx.consume()
          setValue((v) => v.slice(0, -1))
          return
        }
        // Printable character: a single-char sequence with no ctrl/meta.
        const seq = e.sequence ?? ""
        if (!e.ctrl && !e.meta && seq.length === 1 && seq >= " ") {
          ctx.consume()
          setValue((v) => v + seq)
        }
      },
      { priority: 100 },
    )
    onCleanup(off)
  })

  const bullets = () => "•".repeat(value().length)

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description}
        {/* The ONLY visible representation — fully controlled by us. */}
        <Show when={value().length > 0} fallback={<text fg={theme.textMuted}>type your password…</text>}>
          <text fg={theme.text}>
            {reveal() ? value() : bullets()}
            <span style={{ fg: theme.primary }}>█</span>
          </text>
        </Show>
      </box>
      <box paddingBottom={1} flexDirection="row" gap={2}>
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>submit</span>
        </text>
        <text fg={theme.text}>
          ctrl+s <span style={{ fg: theme.textMuted }}>{reveal() ? "hide" : "show"}</span>
        </text>
      </box>
    </box>
  )
}

DialogPassword.show = (dialog: DialogContext, title: string, options?: Omit<DialogPasswordProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPassword
          title={title}
          {...options}
          onConfirm={(value) => resolve(value)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
