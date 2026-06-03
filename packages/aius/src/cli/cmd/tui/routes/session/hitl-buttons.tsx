import { createSignal, For, Show } from "solid-js"
import { useTheme, tint } from "@tui/context/theme"
import { useBindings } from "@tui/keymap"

type Props = {
  hardGate: boolean
  busy: boolean
  onContinue: () => void
  onChat: () => void
}

const CMD_CONTINUE = "aius.gate.continue"
const CMD_CHAT = "aius.gate.chat"

// A chunky horizontal-gradient button: a fixed-width gradient block, 3 rows
// tall, with the label (and its inline shortcut) on the middle row. Every cell
// gets a background interpolated from `from`→`to` across the width so the whole
// pill reads as a brand gradient.
function GradientButton(props: {
  label: string
  from: import("@opentui/core").RGBA
  to: import("@opentui/core").RGBA
  fg: import("@opentui/core").RGBA
  hover: boolean
  onPress: () => void
}) {
  const PAD = 4
  const width = () => props.label.length + PAD * 2
  // center the label on a row of `width` cells
  const rowChars = (withLabel: boolean) => {
    const w = width()
    const cells = new Array(w).fill(" ")
    if (withLabel) {
      const start = Math.floor((w - props.label.length) / 2)
      for (let i = 0; i < props.label.length; i++) cells[start + i] = props.label[i]
    }
    return cells.map((ch, i) => ({ ch, t: w <= 1 ? 0 : i / (w - 1), key: i }))
  }
  const renderRow = (withLabel: boolean) => (
    <text>
      <For each={rowChars(withLabel)}>
        {(cell) => {
          const base = tint(props.from, props.to, cell.t)
          return (
            <span style={{ bg: props.hover ? tint(base, props.fg, 0.25) : base, fg: props.fg, bold: true }}>
              {cell.ch}
            </span>
          )
        }}
      </For>
    </text>
  )
  return (
    <box flexDirection="column" onMouseDown={() => props.onPress()} onMouseUp={() => props.onPress()}>
      {renderRow(false)}
      {renderRow(true)}
      {renderRow(false)}
    </box>
  )
}

// A ghost/outline button: just a colored border around the label, no fill — for
// secondary actions that shouldn't compete with the filled primary button. Same
// 3-row height as GradientButton (border-top / label / border-bottom) so they
// align side by side.
function OutlineButton(props: {
  label: string
  color: import("@opentui/core").RGBA
  hover: boolean
  onPress: () => void
}) {
  const { theme } = useTheme()
  return (
    <box
      border={["top", "bottom", "left", "right"]}
      borderColor={props.color}
      paddingLeft={3}
      paddingRight={3}
      backgroundColor={props.hover ? tint(theme.backgroundPanel, props.color, 0.18) : undefined}
      onMouseDown={() => props.onPress()}
      onMouseUp={() => props.onPress()}
    >
      <text fg={props.color} attributes={1}>
        {props.label}
      </text>
    </box>
  )
}

// A compact single-row Continue pill that sits to the RIGHT of the prompt
// input — shown once the full gate is dismissed (Chat about it) or the agent
// was interrupted (Ctrl+C) while at a review stage, so the user can still
// advance without retyping "continue".
export function InlineContinueButton(props: { busy: boolean; onContinue: () => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  useBindings(() => ({
    commands: [
      {
        name: "aius.gate.continue.inline",
        title: "Continue past the review gate",
        run: () => {
          if (!props.busy) props.onContinue()
        },
      },
    ],
    bindings: [{ key: "tab", cmd: "aius.gate.continue.inline", desc: "Continue" }],
  }))

  const PAD = 2
  const label = "▶ Continue  [Tab]"
  const cells = () => {
    const w = label.length + PAD * 2
    const arr = new Array(w).fill(" ")
    for (let i = 0; i < label.length; i++) arr[PAD + i] = label[i]
    return arr.map((ch, i) => ({ ch, t: w <= 1 ? 0 : i / (w - 1) }))
  }
  return (
    <box
      flexShrink={0}
      marginLeft={1}
      onMouseDown={() => setHover(true)}
      onMouseUp={() => {
        setHover(false)
        if (!props.busy) props.onContinue()
      }}
    >
      <text>
        <For each={cells()}>
          {(cell) => {
            const base = tint(theme.success, tint(theme.success, theme.secondary, 0.4), cell.t)
            return (
              <span style={{ bg: hover() ? tint(base, theme.background, 0.2) : base, fg: theme.background, bold: true }}>
                {cell.ch}
              </span>
            )
          }}
        </For>
      </text>
    </box>
  )
}

// Shown when the user relaunches into an existing, mid-pipeline session. Rather
// than silently re-firing the stage prompt, offer an explicit choice: Continue
// (green) picks up where the agent left off; Reset (red) wipes the analysis and
// starts over from context_build.
export function ResumeGate(props: { stageLabel: string; onContinue: () => void; onReset: () => void }) {
  const { theme } = useTheme()
  const [hoverC, setHoverC] = createSignal(false)
  const [hoverR, setHoverR] = createSignal(false)
  const [confirmReset, setConfirmReset] = createSignal(false)

  useBindings(() => ({
    commands: [
      { name: "aius.resume.continue", title: "Resume the pipeline", run: () => props.onContinue() },
      {
        name: "aius.resume.reset",
        title: "Reset the analysis and start over",
        run: () => {
          if (confirmReset()) props.onReset()
          else setConfirmReset(true)
        },
      },
    ],
    bindings: [
      { key: "tab", cmd: "aius.resume.continue", desc: "Continue" },
      { key: "ctrl+r", cmd: "aius.resume.reset", desc: "Reset" },
    ],
  }))

  // 3 rows tall (blank / label / blank) so the resume buttons are the same
  // chunky pills as the in-session HITL gate (GradientButton) instead of a
  // thin single-row strip.
  const pill = (label: string, from: import("@opentui/core").RGBA, to: import("@opentui/core").RGBA, hover: boolean) => {
    const PAD = 4
    const w = label.length + PAD * 2
    const row = (withLabel: boolean) => {
      const arr = new Array(w).fill(" ")
      if (withLabel) {
        const start = Math.floor((w - label.length) / 2)
        for (let i = 0; i < label.length; i++) arr[start + i] = label[i]
      }
      return (
        <text>
          <For each={arr.map((ch, i) => ({ ch, t: w <= 1 ? 0 : i / (w - 1) }))}>
            {(cell) => {
              const base = tint(from, to, cell.t)
              return (
                <span style={{ bg: hover ? tint(base, theme.background, 0.2) : base, fg: theme.background, bold: true }}>
                  {cell.ch}
                </span>
              )
            }}
          </For>
        </text>
      )
    }
    return (
      <box flexDirection="column">
        {row(false)}
        {row(true)}
        {row(false)}
      </box>
    )
  }

  return (
    <box paddingLeft={3} paddingRight={3} paddingTop={1} paddingBottom={1} flexDirection="column" backgroundColor={theme.backgroundPanel}>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Resuming at <span style={{ fg: theme.secondary, bold: true }}>{props.stageLabel}</span>.{" "}
          {confirmReset() ? <span style={{ fg: theme.error, bold: true }}>Press Reset again to confirm — this wipes all analysis.</span> : "Continue where you left off, or reset and start over."}
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <box
          flexDirection="column"
          onMouseDown={() => setHoverC(true)}
          onMouseUp={() => {
            setHoverC(false)
            props.onContinue()
          }}
        >
          {pill("▶ Continue  [Tab]", theme.success, tint(theme.success, theme.secondary, 0.4), hoverC())}
        </box>
        <box
          flexDirection="column"
          onMouseDown={() => setHoverR(true)}
          onMouseUp={() => {
            setHoverR(false)
            if (confirmReset()) props.onReset()
            else setConfirmReset(true)
          }}
        >
          {pill(confirmReset() ? "⟲ Reset — confirm  [⌃R]" : "⟲ Reset  [⌃R]", theme.error, tint(theme.error, theme.accent, 0.4), hoverR())}
        </box>
      </box>
    </box>
  )
}

export function HITLGateButtons(props: Props) {
  const { theme } = useTheme()
  const [pressContinue, setPressContinue] = createSignal(false)
  const [pressChat, setPressChat] = createSignal(false)

  useBindings(() => ({
    commands: [
      {
        name: CMD_CONTINUE,
        title: "Continue past the review gate",
        run: () => {
          if (!props.busy) props.onContinue()
        },
      },
      {
        name: CMD_CHAT,
        title: "Dismiss the gate so you can reply",
        run: () => props.onChat(),
      },
    ],
    bindings: [
      { key: "tab", cmd: CMD_CONTINUE, desc: "Continue" },
      { key: "ctrl+n", cmd: CMD_CHAT, desc: "Chat about it" },
    ],
  }))

  return (
    <box
      paddingLeft={3}
      paddingRight={3}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
    >
      <Show when={props.hardGate}>
        <box paddingBottom={1}>
          <text fg={theme.accent} attributes={1}>
            ▸ goal_review — your contract approval is required
          </text>
        </box>
      </Show>
      <box flexDirection="row" gap={2}>
        <GradientButton
          label="▶ Continue  [Tab]"
          from={theme.success}
          to={tint(theme.success, theme.secondary, 0.4)}
          fg={theme.background}
          hover={pressContinue()}
          onPress={() => {
            setPressContinue(true)
            if (!props.busy) props.onContinue()
          }}
        />
        <OutlineButton
          label="✎ Chat about it  [⌃N]"
          color={theme.secondary}
          hover={pressChat()}
          onPress={() => {
            setPressChat(true)
            props.onChat()
          }}
        />
      </box>
    </box>
  )
}
