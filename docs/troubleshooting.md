# Troubleshooting

Common issues and fixes. For sign-in problems see also
[auth.md](auth.md#troubleshooting).

- [macOS: "zsh: killed aius"](#macos-zsh-killed-aius)
- [`aius: command not found`](#aius-command-not-found)
- [Windows: "running scripts is disabled"](#windows-running-scripts-is-disabled)
- ["Cannot reach the AIUS server"](#cannot-reach-the-aius-server)
- [API key rejected (401)](#api-key-rejected-401)
- [Lost your authenticator (2FA)](#lost-your-authenticator-2fa)
- [First run is slow](#first-run-is-slow)
- [Download failed / no asset for my platform](#download-failed--no-asset-for-my-platform)
- [Checksum mismatch](#checksum-mismatch)
- [Getting logs](#getting-logs)

## macOS: "zsh: killed aius"

Copying a Bun single-file executable invalidates its code signature, so
Gatekeeper `SIGKILL`s it on first run. The installer re-applies an ad-hoc
signature automatically, but if you installed manually (or it was skipped),
re-sign it yourself:

```sh
codesign -s - --force ~/.aius/bin/aius
```

If macOS still blocks it ("cannot be opened because the developer cannot be
verified"), remove the quarantine attribute and try again:

```sh
xattr -d com.apple.quarantine ~/.aius/bin/aius 2>/dev/null
codesign -s - --force ~/.aius/bin/aius
```

## `aius: command not found`

The install directory isn't on your `PATH` yet — usually because you haven't
opened a new shell since installing. Either:

```sh
exec $SHELL -l          # start a fresh login shell
# or source the profile the installer edited, e.g.
source ~/.zshrc
```

Or run it by full path once: `~/.aius/bin/aius`. The installer prints which
profile file it edited; if you use a non-standard shell, add
`export PATH="$HOME/.aius/bin:$PATH"` to your rc file.

## Windows: "running scripts is disabled"

If `irm … | iex` fails with an execution-policy error, allow signed/remote
scripts for the current user, then retry:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
irm https://aius.co/install.ps1 | iex
```

Open a new terminal after install so the updated `PATH` is picked up.

## "Cannot reach the AIUS server"

The gateway at the configured `AIUS_API_URL` isn't reachable (the agent loop
runs server-side, so this is checked at startup). Check your network/VPN, or
point at a reachable proxy:

```sh
export AIUS_API_URL=https://your-proxy.example.com/v1
aius
```

To skip the reachability check (e.g. for offline UI inspection):

```sh
AIUS_SKIP_PREFLIGHT=1 aius
```

## API key rejected (401)

Your stored token is wrong, expired, or revoked. Re-authenticate:

```sh
aius auth status     # inspect the current state
aius auth login      # sign in again
```

If you're using a PAT, create a fresh key in the
[account portal](https://aius.co/account) and revoke the old one.

## Lost your authenticator (2FA)

At the CLI's `Two-factor code (or recovery code):` prompt, enter one of your
**recovery codes** instead of a 6-digit code. Then sign in to the
[account portal](https://aius.co/account) and reset/regenerate 2FA. See
[account.md](account.md#recovery-codes).

## First run is slow

The first run does a one-time database migration and sets up an isolated Python
environment (downloading data-science libraries via the bundled `uv`). This can
take a few minutes once per machine/project; later runs are fast.

## Download failed / no asset for my platform

The installer maps your OS/arch to a release asset
(`aius-<os>-<arch>[-baseline][-musl]`). If the download fails:

- The asset may not exist for that exact `AIUS_VERSION` — try the latest, or pin
  a known-good tag with `AIUS_VERSION=vX.Y.Z`.
- Check the [releases page](https://github.com/aius-ai/aius-cli/releases) for
  the assets that actually shipped for your platform.
- Behind a proxy/firewall, ensure GitHub releases and `api.github.com` are
  reachable; set `GITHUB_TOKEN` if you hit API rate limits.

## Checksum mismatch

The installer verifies the SHA-256 of the download and **aborts on a mismatch**
rather than run an unverified binary. A mismatch usually means a corrupted or
interrupted download — re-run the installer. If it persists, file an issue at
[aius-ai/aius-cli](https://github.com/aius-ai/aius-cli/issues).

## Getting logs

```sh
aius --print-logs --log-level DEBUG
```

Logs are also written under `~/.local/share/aius/log/`. On a fatal error AIUS
prints the path to the log file. Include relevant log output when filing an
issue.
</content>
