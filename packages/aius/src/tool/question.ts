import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // Enforced contract: every question has a preselected default so the
          // user can confirm with one click. Move the `recommended` option to
          // the front (the TUI preselects index 0); if none is marked, the first
          // option is the default. Questions with no options are rejected.
          const questions = params.questions.map((q) => {
            if (!q.options || q.options.length === 0) {
              throw new Error(`question "${q.question}" has no options — provide options with one recommended default`)
            }
            const recIdx = q.options.findIndex((o) => o.recommended)
            if (recIdx <= 0) return q
            const reordered = [q.options[recIdx], ...q.options.filter((_, i) => i !== recIdx)]
            return { ...q, options: reordered }
          })

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
