<div align="center">

# AIUS

**An autonomous data-science agent in your terminal.**

Point it at a project brief and a dataset; it reads, writes, and runs code to
get the analysis done — all from a fast terminal UI.

![AIUS](docs/assets/aius-banner.png)

[Website](https://aius.co) · [Docs](https://aius.co/docs) · [Install](#install) · [First run](#first-run) · [Account portal](https://aius.co/account)

</div>

---

## What is AIUS?

AIUS is an agent that works like a data scientist sitting in your terminal. You
give it a goal (a short brief) and your data; it explores the dataset, writes
and executes Python, iterates on the results, and produces an analysis — while
you watch and steer from a TUI.

- **Terminal-native.** A fast, keyboard-driven TUI. No browser, no IDE plugin.
  Runs locally or over SSH.
- **Self-contained.** The prebuilt binary ships its own Python toolchain
  (`uv`), so you don't need Python, Node, or Bun installed to run it.
- **Server-backed.** LLM traffic is routed through the AIUS gateway, so you
  authenticate once with an AIUS credential — no juggling provider API keys.
- **Bring your own data.** Drop a brief in `context/` and a dataset in `data/`
  and go.

New here? Create an account at **[aius.co](https://aius.co)**, install the CLI
below, then run `aius` and sign in.

## Install

Prebuilt, self-contained binaries for macOS, Linux, and Windows — no Node,
Bun, or Python required.

**macOS / Linux**

```sh
curl -fsSL https://aius.co/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://aius.co/install.ps1 | iex
```

**npm** (any platform with Node ≥ 18)

```sh
npm install -g @aius-ai/cli
```

The installer drops the `aius` binary (and its `uv` sidecar) into `~/.aius/bin`
and adds that directory to your `PATH`. Open a new terminal afterwards, then run
`aius`.

Installer knobs (env vars, all optional):

| Variable | Default | Purpose |
|---|---|---|
| `AIUS_VERSION` | latest release | Pin a specific version, e.g. `v1.15.11` |
| `AIUS_INSTALL_DIR` | `~/.aius/bin` | Where to install the binary |
| `AIUS_GH_REPO` | `aius-ai/aius-cli` | Release source repo |
| `GITHUB_TOKEN` | — | Used for the GitHub "latest" lookup if you hit API rate limits |

See **[docs/install.md](docs/install.md)** for all install methods, platform
variants (glibc/musl, avx2/baseline), verification, updating, and uninstalling.

## First run

On first launch AIUS asks you to sign in to your **AIUS account** — a single
credential authenticates this client to the AIUS server. You don't need any LLM
provider keys; the gateway holds those server-side.

![First-run sign-in](docs/assets/aius-auth.png)

Ways to sign in (see **[docs/auth.md](docs/auth.md)** for the full reference):

- **Email + password** — sign in with your AIUS account credentials.
- **Two-factor (2FA)** — if your account has 2FA enabled, you'll be prompted
  for your authenticator code (or a recovery code) to finish.
- **Personal access token (PAT)** — paste an `aius_…` key created in the
  [account portal](https://aius.co/account).
- **Register** — create an account directly from the TUI or with
  `aius auth register`.

Don't have an account yet? Register at [aius.co](https://aius.co) (or run
`aius auth register`), then sign in.

Your token is stored at `~/.local/share/aius/auth.json` with mode `0600`.

## Run the agent

```sh
mkdir my-analysis && cd my-analysis
mkdir context data
echo "Predict customer churn and explain the top drivers." > context/brief.md
cp ~/path/to/customers.csv data/

aius            # starts the TUI in the current directory
# or
aius ./my-analysis
```

AIUS reads everything in `context/` (your brief) and `data/` (your dataset),
sets up an isolated Python environment on first run, then starts working toward
the goal. Type to chat with the agent, and watch it plan, run code, and report
results inline.

See **[docs/usage.md](docs/usage.md)** for the full workflow and keybindings,
**[docs/cli.md](docs/cli.md)** for every command and flag, and
**[docs/configuration.md](docs/configuration.md)** for config and environment
variables.

## Documentation

- **[Install](docs/install.md)** — all install methods, updating, uninstalling.
- **[Usage](docs/usage.md)** — day-to-day workflow and the interface.
- **[CLI reference](docs/cli.md)** — every `aius` command, subcommand, and flag.
- **[Authentication](docs/auth.md)** — PAT, email + password, 2FA, recovery codes.
- **[Configuration](docs/configuration.md)** — config files, env vars, file paths.
- **[Account portal](docs/account.md)** — clients, API keys, and 2FA at aius.co.
- **[Troubleshooting](docs/troubleshooting.md)** — common issues and fixes.

Online docs: **[aius.co/docs](https://aius.co/docs)**.

## Key features

- **Autonomous data-science loop** — explores data, writes/executes Python,
  and iterates on results.
- **Terminal UI** — fast, keyboard-driven, runs over SSH.
- **Zero local toolchain** — Python comes bundled via `uv`; the binary is
  self-contained.
- **One credential** — authenticate to the AIUS gateway; no provider keys to
  manage.
- **Cross-platform** — macOS (arm64/x64), Linux (glibc/musl, arm64/x64),
  Windows.

## License

MIT — see [LICENSE](LICENSE).
</content>
</invoke>
