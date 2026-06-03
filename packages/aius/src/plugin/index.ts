import type { Hooks } from "@aius-ai/plugin"
import { Effect, Layer, Context } from "effect"

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@aius/Plugin") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(_name: Name, _input: Input, output: Output) {
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      return [] as Hooks[]
    })

    const init = Effect.fn("Plugin.init")(function* () {
      return
    })

    return Service.of({ trigger, list, init })
  }),
)

export const defaultLayer = layer

export * as Plugin from "."
