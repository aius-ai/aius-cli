import { createMemo, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { TextPart } from "@aius-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import * as Clipboard from "../../util/clipboard"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
}) {
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          // Selecting a timeline entry copies the message text to the
          // clipboard, matching the session-stream click behaviour.
          const parts = sync.data.part[message.id] ?? []
          const text = parts.reduce((agg, part) => {
            if (part.type === "text" && !part.synthetic) return agg + part.text
            return agg
          }, "")
          if (text) {
            Clipboard.copy(text)
              .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
              .catch(toast.error)
          }
          dialog.clear()
        },
      })
    }
    result.reverse()
    return result
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Timeline" options={options()} />
}
