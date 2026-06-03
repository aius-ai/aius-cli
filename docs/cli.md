# CLI reference

Every `aius` command, subcommand, and flag. Run `aius --help` or
`aius <command> --help` for the same information at the terminal.

- [Synopsis](#synopsis)
- [Global options](#global-options)
- [`aius` — start the agent (TUI)](#aius--start-the-agent-tui)
- [`aius auth` — authentication](#aius-auth--authentication)
- [`aius completion` — shell completion](#aius-completion--shell-completion)

## Synopsis

```
aius [project] [options]      # start the TUI (default command)
aius auth <subcommand>        # manage authentication
aius completion               # print a shell-completion script
aius --help | --version
```

## Global options

These work with any command.

| Flag | Alias | Description |
|---|---|---|
| `--help` | `-h` | Show help (for the command it follows) |
| `--version` | `-v` | Print the installed version number |
| `--print-logs` | | Print logs to stderr |
| `--log-level LEVEL` | | Log verbosity: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `--pure` | | Run without external plugins |
| `--reset` | | Wipe local session/conversation state before starting (your auth is preserved) |

> `--reset` rolls the project back to the AIUS baseline: it moves `data/raw/*`
> back to `data/`, drops generated artefacts (e.g. a generated `CONTEXT.md`), and
> wipes scaffolding. It then exits — it does not start the TUI. Your saved login
> is untouched.

## `aius` — start the agent (TUI)

The default command. Starts the terminal UI in a project directory.

```
aius [project] [options]
```

| Argument | Description |
|---|---|
| `project` | Path to start AIUS in (default: the current directory) |

### Options

| Flag | Alias | Type | Description |
|---|---|---|---|
| `--model <provider/model>` | `-m` | string | Model to use, in `provider/model` form |
| `--continue` | `-c` | boolean | Continue the last session |
| `--session <id>` | `-s` | string | Continue a specific session by id |
| `--fork` | | boolean | Fork the session when continuing (use with `--continue` or `--session`) |
| `--prompt <text>` | | string | Initial prompt to send (also reads piped stdin) |
| `--agent <name>` | | string | Agent to use |
| `--force` | | boolean | Skip prompts for non-canonical project files at init |

### Networking / server options

By default the TUI runs an in-process server reachable only by itself. These
flags expose it on the network (e.g. to attach another client or for service
discovery):

| Flag | Type | Default | Description |
|---|---|---|---|
| `--port <n>` | number | `0` (in-process) | Port to listen on |
| `--hostname <host>` | string | `127.0.0.1` | Hostname to bind |
| `--mdns` | boolean | `false` | Enable mDNS service discovery (defaults hostname to `0.0.0.0`) |
| `--mdns-domain <domain>` | string | `aius.local` | Custom mDNS domain |
| `--cors <domain>` | string (repeatable) | — | Additional domains to allow for CORS |

### Examples

```sh
aius                                   # start in the current directory
aius ./my-analysis                     # start in a specific project
aius -c                                # continue the last session
aius --session ses_123 --fork          # fork an existing session
aius --model openrouter/anthropic/claude-3.5-sonnet
echo "summarise data/sales.csv" | aius # send a prompt from stdin
aius --pure                            # run without external plugins
aius --reset                           # reset project state and exit
aius --print-logs --log-level DEBUG    # verbose logging to stderr
```

## `aius auth` — authentication

Manage how this client authenticates to the AIUS server. Run bare `aius auth`
for an overview. See [auth.md](auth.md) for the complete flow.

```
aius auth login      Log in (email + password, or --key for a PAT)
aius auth register   Create an account (email + password)
aius auth status     Show the current login
aius auth logout     Remove the saved token
```

### `aius auth login`

Log in and save a durable `aius_` token. Email + password by default; `--key`
selects PAT mode.

| Flag | Type | Description |
|---|---|---|
| `--email <email>` | string | Account email (email/password login) |
| `--password <pw>` | string | Account password (omit to be prompted securely, no echo) |
| `--key <aius_…>` | string | Log in with an existing API key (PAT); skips email/password |
| `--force` | boolean | With `--key`, save even if the AIUS API can't be reached to verify it |

If your account has 2FA enabled, after the password is accepted you're prompted
for a one-time **or recovery** code to finish.

```sh
aius auth login                          # interactive email + password
aius auth login --email you@co.com       # login, prompt for password
aius auth login --key aius_xxx           # PAT login
aius auth login --key aius_xxx --force   # save without verifying
```

### `aius auth register`

Create a new AIUS account and save a freshly minted token.

| Flag | Type | Description |
|---|---|---|
| `--email <email>` | string | Account email |
| `--name <name>` | string | Your name |
| `--password <pw>` | string | Account password (omit to be prompted securely) |

```sh
aius auth register
aius auth register --email you@co.com --name "You"   # prompt for password
```

### `aius auth status`

Show the current login: whether a token is stored, a masked view of the key, and
whether the AIUS API currently considers it valid.

```sh
aius auth status
```

### `aius auth logout`

Remove the saved token from this machine.

```sh
aius auth logout
```

## `aius completion` — shell completion

Print a shell-completion script you can source or install.

```sh
aius completion >> ~/.zshrc        # or your shell's rc / completions dir
```
</content>
