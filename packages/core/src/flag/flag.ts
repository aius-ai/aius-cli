import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const AIUS_EXPERIMENTAL = truthy("AIUS_EXPERIMENTAL")
const copy = process.env["AIUS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? AIUS_EXPERIMENTAL : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  AIUS_AUTO_HEAP_SNAPSHOT: truthy("AIUS_AUTO_HEAP_SNAPSHOT"),
  AIUS_GIT_BASH_PATH: process.env["AIUS_GIT_BASH_PATH"],
  AIUS_CONFIG: process.env["AIUS_CONFIG"],
  AIUS_CONFIG_CONTENT: process.env["AIUS_CONFIG_CONTENT"],
  AIUS_DISABLE_AUTOUPDATE: truthy("AIUS_DISABLE_AUTOUPDATE"),
  AIUS_ALWAYS_NOTIFY_UPDATE: truthy("AIUS_ALWAYS_NOTIFY_UPDATE"),
  AIUS_DISABLE_PRUNE: truthy("AIUS_DISABLE_PRUNE"),
  AIUS_DISABLE_TERMINAL_TITLE: truthy("AIUS_DISABLE_TERMINAL_TITLE"),
  AIUS_SHOW_TTFD: truthy("AIUS_SHOW_TTFD"),
  AIUS_DISABLE_AUTOCOMPACT: truthy("AIUS_DISABLE_AUTOCOMPACT"),
  AIUS_DISABLE_MODELS_FETCH: truthy("AIUS_DISABLE_MODELS_FETCH"),
  AIUS_DISABLE_MOUSE: truthy("AIUS_DISABLE_MOUSE"),
  AIUS_FAKE_VCS: process.env["AIUS_FAKE_VCS"],
  AIUS_SERVER_PASSWORD: process.env["AIUS_SERVER_PASSWORD"],
  AIUS_SERVER_USERNAME: process.env["AIUS_SERVER_USERNAME"],

  // Experimental
  AIUS_EXPERIMENTAL_FILEWATCHER: Config.boolean("AIUS_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  AIUS_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("AIUS_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  AIUS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("AIUS_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  AIUS_MODELS_URL: process.env["AIUS_MODELS_URL"],
  AIUS_MODELS_PATH: process.env["AIUS_MODELS_PATH"],
  AIUS_DB: process.env["AIUS_DB"],

  AIUS_WORKSPACE_ID: process.env["AIUS_WORKSPACE_ID"],
  AIUS_EXPERIMENTAL_WORKSPACES: enabledByExperimental("AIUS_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get AIUS_DISABLE_PROJECT_CONFIG() {
    return truthy("AIUS_DISABLE_PROJECT_CONFIG")
  },
  get AIUS_TUI_CONFIG() {
    return process.env["AIUS_TUI_CONFIG"]
  },
  get AIUS_CONFIG_DIR() {
    return process.env["AIUS_CONFIG_DIR"]
  },
  get AIUS_PURE() {
    return truthy("AIUS_PURE")
  },
  get AIUS_PERMISSION() {
    return process.env["AIUS_PERMISSION"]
  },
  get AIUS_PLUGIN_META_FILE() {
    return process.env["AIUS_PLUGIN_META_FILE"]
  },
  get AIUS_CLIENT() {
    return process.env["AIUS_CLIENT"] ?? "cli"
  },
}
