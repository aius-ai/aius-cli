// Stub: installation service removed in Task 2 prune. Upgrade/update-check is
// a no-op. Files importing this module should continue to compile.
import { Effect, Layer, Context, Schema } from "effect"
import { InstallationChannel, InstallationVersion } from "@aius-ai/core/installation/version"
import { BusEvent } from "@/bus/bus-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `aius/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@aius/Installation") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    info: Effect.fn("Installation.info")(function* () {
      return { version: InstallationVersion, latest: InstallationVersion }
    }),
    method: Effect.fn("Installation.method")(function* () {
      return "unknown" as Method
    }),
    latest: Effect.fn("Installation.latest")(function* (_method?: Method) {
      return InstallationVersion
    }),
    upgrade: Effect.fn("Installation.upgrade")(function* (_method: Method, _target: string) {
      return yield* new UpgradeFailedError({ stderr: "Upgrade not supported in this build" })
    }),
  }),
)

export const defaultLayer = layer

export * as Installation from "."
