import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("AIUS_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@aius/RuntimeFlags", {
  autoShare: bool("AIUS_AUTO_SHARE"),
  pure: bool("AIUS_PURE"),
  disableDefaultPlugins: bool("AIUS_DISABLE_DEFAULT_PLUGINS"),
  disableChannelDb: bool("AIUS_DISABLE_CHANNEL_DB"),
  disableEmbeddedWebUi: bool("AIUS_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("AIUS_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("AIUS_DISABLE_LSP_DOWNLOAD"),
  skipMigrations: bool("AIUS_SKIP_MIGRATIONS"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("AIUS_DISABLE_CLAUDE_CODE"),
    direct: bool("AIUS_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("AIUS_DISABLE_CLAUDE_CODE"),
    direct: bool("AIUS_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("AIUS_ENABLE_EXA"),
    legacy: bool("AIUS_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("AIUS_ENABLE_PARALLEL"),
    legacy: bool("AIUS_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("AIUS_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("AIUS_ENABLE_QUESTION_TOOL"),
  experimentalScout: enabledByExperimental("AIUS_EXPERIMENTAL_SCOUT"),
  experimentalBackgroundSubagents: enabledByExperimental("AIUS_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("AIUS_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("AIUS_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("AIUS_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("AIUS_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("AIUS_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("AIUS_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("AIUS_EXPERIMENTAL_ICON_DISCOVERY"),
  acpNext: bool("AIUS_ACP_NEXT"),
  outputTokenMax: positiveInteger("AIUS_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("AIUS_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("AIUS_EXPERIMENTAL_NATIVE_LLM"),
  client: Config.string("AIUS_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as RuntimeFlags from "./runtime-flags"
