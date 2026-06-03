# Installing AIUS

AIUS ships as a prebuilt, self-contained binary. You do **not** need Node, Bun,
or Python installed — the binary bundles its own Python toolchain (`uv`).

- [Quick install](#quick-install)
- [Installer knobs](#installer-knobs)
- [What the installer does](#what-the-installer-does)
- [Platform variants](#platform-variants)
- [Install via npm](#install-via-npm)
- [Manual install](#manual-install-from-a-release)
- [Verifying the install](#verifying-the-install)
- [Updating](#updating)
- [Uninstalling](#uninstalling)

## Quick install

**macOS / Linux**

```sh
curl -fsSL https://aius.co/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://aius.co/install.ps1 | iex
```

Open a new terminal afterwards (so the updated `PATH` is picked up), then run
`aius`.

## Installer knobs

All optional — set as environment variables before running the installer.

| Variable | Default | Purpose |
|---|---|---|
| `AIUS_VERSION` | latest release | Pin a specific version, e.g. `v1.15.12` |
| `AIUS_INSTALL_DIR` | `~/.aius/bin` | Where to install the binary |
| `AIUS_GH_REPO` | `aius-ai/aius-cli` | GitHub repo to pull releases from |
| `GITHUB_TOKEN` | — | Used for the "latest" lookup if you hit GitHub API rate limits |

Examples:

```sh
# Pin a specific version
AIUS_VERSION=v1.15.12 curl -fsSL https://aius.co/install.sh | sh

# Install somewhere else
AIUS_INSTALL_DIR="$HOME/bin" curl -fsSL https://aius.co/install.sh | sh
```

```powershell
# Windows: pin a version
$env:AIUS_VERSION = "v1.15.12"; irm https://aius.co/install.ps1 | iex
```

## What the installer does

1. Detects your OS and CPU architecture and picks the right release asset.
2. Downloads the archive from the [aius-ai/aius-cli releases](https://github.com/aius-ai/aius-cli/releases).
3. **Verifies the SHA-256 checksum** against the published `.sha256` and refuses
   to install on a mismatch (fail-closed).
4. Checks the archive for unsafe paths (zip-slip protection) before extracting.
5. Installs `aius` plus its `uv`/`uvx` sidecars into `~/.aius/bin` (the runtime
   resolves `uv` next to the binary).
6. **macOS only:** re-applies an ad-hoc code signature to the copied binary so
   Gatekeeper doesn't kill it on first run (see
   [Troubleshooting](troubleshooting.md#macos-zsh-killed-aius)).
7. Adds the install directory to your `PATH` in the appropriate shell profile
   (`.zshrc`, `.bashrc`/`.bash_profile`, fish `config.fish`, or `.profile`).

## Platform variants

The installer picks the correct asset automatically; you rarely need to care.
Asset names follow `aius-<os>-<arch>[-baseline][-musl]`:

- **macOS** — `arm64` (Apple Silicon) and `x64` (Intel).
- **Linux** — `arm64` and `x64`, each in **glibc** (default) and **musl**
  (Alpine etc.) variants. The installer detects musl automatically.
- **Windows** — `arm64` and `x64`.
- **x64 baseline** — x64 builds ship an `avx2` build and a `-baseline` (no-AVX2)
  build. The installer detects AVX2 support and falls back to baseline on older
  CPUs.

## Install via npm

If you already have Node ≥ 18:

```sh
npm install -g @aius-ai/cli
```

`@aius-ai/cli` is a thin launcher that declares the per-platform binary packages
as `optionalDependencies`; npm installs only the one matching your platform.
Update with `npm install -g @aius-ai/cli@latest`.

## Manual install (from a release)

1. Go to the [releases page](https://github.com/aius-ai/aius-cli/releases) and
   download the archive for your platform plus its `.sha256`.
2. Verify the checksum:
   ```sh
   shasum -a 256 -c aius-darwin-arm64.zip.sha256   # macOS
   sha256sum -c aius-linux-x64.tar.gz.sha256        # Linux
   ```
3. Unpack and move `aius` (and the `uv`/`uvx` siblings) somewhere on your
   `PATH`.
4. **macOS:** re-sign the copied binary so Gatekeeper allows it:
   ```sh
   codesign -s - --force /path/to/aius
   ```

## Verifying the install

```sh
aius --version      # prints the installed version
aius --help         # lists commands and flags
which aius          # confirms it's on your PATH (macOS/Linux)
```

If `aius` isn't found, open a new terminal or `source` your shell profile (the
installer prints the exact file it edited).

## Updating

Re-run the installer to get the latest release:

```sh
curl -fsSL https://aius.co/install.sh | sh           # macOS / Linux
```
```powershell
irm https://aius.co/install.ps1 | iex                # Windows
```

Or, if you installed via npm:

```sh
npm install -g @aius-ai/cli@latest
```

To pin/downgrade, set `AIUS_VERSION` (script installer) or use an `@version` tag
(npm).

## Uninstalling

The CLI keeps everything under a couple of well-known locations; removing them
fully uninstalls it.

```sh
# 1. Remove the binary + sidecars
rm -rf ~/.aius

# 2. Remove saved auth + local state (optional)
rm -rf ~/.local/share/aius      # data: auth.json, db, logs
rm -rf ~/.config/aius           # config (if present)
rm -rf ~/.cache/aius            # cache

# 3. Remove the PATH line the installer added (edit your shell profile)
#    look for the "# aius" comment in ~/.zshrc / ~/.bashrc / ~/.profile /
#    ~/.config/fish/config.fish and delete it.
```

If you installed via npm: `npm uninstall -g @aius-ai/cli`.

On Windows, delete `%USERPROFILE%\.aius`, remove the install dir from your user
`PATH` (System → Environment Variables), and optionally delete the app data
under `%LOCALAPPDATA%` / `%APPDATA%`.

See [docs/configuration.md](configuration.md#file-locations) for the full list of
file locations.
</content>
