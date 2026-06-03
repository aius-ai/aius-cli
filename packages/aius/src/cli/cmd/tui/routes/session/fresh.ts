import { createSignal } from "solid-js"

// Tracks the session id the user just created via the home BeginButton this
// launch. The session view auto-kicks the pipeline ONLY for that session.
export const [freshSessionID, setFreshSessionID] = createSignal<string | undefined>(undefined)

// Sessions the user has actively engaged with THIS launch — either freshly
// created, or resumed-then-acted-on (clicked Continue/Chat). The distinction
// drives which gate shows when the session is idle mid-pipeline:
//   • engaged  → interrupted this launch → Continue / Chat about it
//   • not yet  → just auto-resumed on boot → Continue / Reset
const [engagedSet, setEngagedSet] = createSignal<ReadonlySet<string>>(new Set())

export const engaged = engagedSet

export function markEngaged(id: string) {
  if (engagedSet().has(id)) return
  const next = new Set(engagedSet())
  next.add(id)
  setEngagedSet(next)
}
