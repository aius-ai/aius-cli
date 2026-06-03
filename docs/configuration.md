# Configuration

AIUS works out of the box with no configuration — you only need to sign in. This
page documents the environment variables and file locations for when you want to
customise behaviour, point at a different server, or script setup.

- [Environment variables](#environment-variables)
- [File locations](#file-locations)
- [The config directory](#the-config-directory)

## Environment variables

Set these before running `aius`.

### Server & auth

| Variable | Purpose |
|---|---|
| `AIUS_API_URL` | Override the AIUS gateway base URL (include the `/v1` suffix), e.g. a self-hosted proxy or a dev environment. Defaults to the URL baked into the build. |
| `AIUS_API_KEY` | Provide an `aius_…` key non-interactively; skips the sign-in prompt. Handy for CI/scripts. |

### Config & state locations

| Variable | Purpose |
|---|---|
| `AIUS_CONFIG_DIR` | Override the directory AIUS loads/stores config from. |
| `AIUS_CONFIG` | Path to a specific config file to load. |
| `AIUS_CONFIG_CONTENT` | Inline config content (instead of a file). |
| `AIUS_DB` | Override the path to the local SQLite database. |
| `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | Standard XDG base dirs; AIUS stores its files under `<xdg>/aius`. |

### Behaviour toggles

| Variable | Purpose |
|---|---|
| `AIUS_PURE=1` | Run without external plugins (same as `--pure`). |
| `AIUS_DISABLE_AUTOUPDATE=1` | Don't check for / prompt about updates. |
| `AIUS_DISABLE_MOUSE=1` | Disable mouse handling in the TUI. |
| `AIUS_DISABLE_TERMINAL_TITLE=1` | Don't set the terminal title. |
| `AIUS_DISABLE_AUTOCOMPACT=1` | Disable automatic conversation compaction. |
| `AIUS_DISABLE_MODELS_FETCH=1` | Don't fetch the remote model catalog. |
| `AIUS_SKIP_PREFLIGHT=1` | Skip the "is the gateway reachable?" check at startup. |

### Networking (exposing the in-process server)

These have equivalent flags (see [cli.md](cli.md#networking--server-options));
the flags take precedence when explicitly passed.

| Variable | Purpose |
|---|---|
| `AIUS_SERVER_USERNAME` | Basic-auth username for the exposed server. |
| `AIUS_SERVER_PASSWORD` | Basic-auth password for the exposed server. |

> The variables above are the ones most users need. Additional
> `AIUS_EXPERIMENTAL_*` toggles exist for development and may change without
> notice; they're intentionally undocumented here.

## File locations

AIUS follows the XDG base-directory spec. On a typical Linux/macOS setup
(`$HOME` expanded), files live under:

| Path | Contents |
|---|---|
| `~/.aius/bin/` | The `aius` binary and its `uv`/`uvx` sidecars (default install dir) |
| `~/.local/share/aius/auth.json` | Your saved `aius_` token (mode `0600`) |
| `~/.local/share/aius/aius.db` | Local SQLite database (sessions, conversations) |
| `~/.local/share/aius/log/` | Log files |
| `~/.config/aius/` | Config (if you create one) |
| `~/.cache/aius/` | Cache |
| `~/.local/state/aius/` | Runtime state |

> Exact base directories follow `XDG_DATA_HOME` / `XDG_CONFIG_HOME` /
> `XDG_CACHE_HOME` / `XDG_STATE_HOME` when those are set. On Windows the
> equivalents resolve under `%APPDATA%` / `%LOCALAPPDATA%`.

To find the active log file, run with `--print-logs`; the error path prints the
log file location on a fatal error.

## The config directory

By default AIUS loads config from the standard config dir (above). Override it
with `AIUS_CONFIG_DIR`, point at a single file with `AIUS_CONFIG`, or pass inline
content with `AIUS_CONFIG_CONTENT`. A project-local `.aius/` directory is also
recognised.
</content>
