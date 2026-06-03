import { expect, test } from "bun:test"
import { Effect } from "effect"
import { RunWsExecutor } from "@/session/run-ws/executor"

const sig = () => new AbortController().signal

test("dispatches to the named tool and returns its output", async () => {
  const tools = { read: { execute: async (args: any) => ({ output: `read ${args.path}` }) } } as any
  const exec = RunWsExecutor.fromTools(tools, sig(), [])
  const result = await Effect.runPromise(exec("read", { path: "a.txt" }))
  expect(result).toMatchObject({ output: "read a.txt" })
})

test("parses JSON-string arguments before invoking the tool", async () => {
  // The backend sends `arguments` as a raw JSON string; the tool must receive a parsed object.
  let seenArgs: any
  const tools = {
    read: {
      execute: async (args: any) => {
        seenArgs = args
        return { output: "ok" }
      },
    },
  } as any
  const exec = RunWsExecutor.fromTools(tools, sig(), [])
  await Effect.runPromise(exec("read", '{"path":"a.txt"}'))
  expect(seenArgs).toEqual({ path: "a.txt" })
})

test("surfaces the tool's real error message (not a generic tryPromise error)", async () => {
  const tools = {
    boom: {
      execute: async () => {
        throw new Error("disk is full")
      },
    },
  } as any
  const exec = RunWsExecutor.fromTools(tools, sig(), [])
  const exit = await Effect.runPromiseExit(exec("boom", {}))
  expect(exit._tag).toBe("Failure")
  const err = await Effect.runPromise(exec("boom", {}).pipe(Effect.flip))
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toContain("disk is full")
})

test("unknown tool fails", async () => {
  const exec = RunWsExecutor.fromTools({} as any, sig(), [])
  const exit = await Effect.runPromiseExit(exec("nope", {}))
  expect(exit._tag).toBe("Failure")
})

test("tool present but execute missing fails", async () => {
  const exec = RunWsExecutor.fromTools({ read: {} } as any, sig(), [])
  const exit = await Effect.runPromiseExit(exec("read", {}))
  expect(exit._tag).toBe("Failure")
})

test("forwards the run's abort signal and messages to the tool (cancellation can propagate)", async () => {
  let seen: any
  const tools = {
    read: {
      execute: async (_args: any, options: any) => {
        seen = options
        return { output: "ok" }
      },
    },
  } as any
  const controller = new AbortController()
  const messages = [{ role: "user", content: "hi" }] as any
  const exec = RunWsExecutor.fromTools(tools, controller.signal, messages)
  await Effect.runPromise(exec("read", {}))
  expect(typeof seen.toolCallId).toBe("string")
  // The exact run-scoped signal is handed through (not a throwaway one), so an
  // abort on the run reaches the tool.
  expect(seen.abortSignal).toBe(controller.signal)
  expect(seen.abortSignal.aborted).toBe(false)
  controller.abort()
  expect(seen.abortSignal.aborted).toBe(true)
  // The run's messages are passed through, not an empty array.
  expect(seen.messages).toBe(messages)
})
