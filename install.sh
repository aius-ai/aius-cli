#!/usr/bin/env bash
#
# Aius installer — downloads the prebuilt CLI for your platform and puts it on
# your PATH.
#
#   curl -fsSL https://aius.co/install.sh | bash
#
# Knobs (all optional, set as env vars before running):
#   AIUS_VERSION       version to install, e.g. "v1.15.12" (default: latest release)
#   AIUS_INSTALL_DIR   where to put the binary (default: $HOME/.aius/bin)
#   AIUS_GH_REPO       GitHub repo to pull releases from (default: aius-ai/aius-cli)
#   GITHUB_TOKEN       used for the GitHub API "latest" lookup if you hit rate limits
#
set -euo pipefail

APP="aius"
GH_REPO="${AIUS_GH_REPO:-aius-ai/aius-cli}"
INSTALL_DIR="${AIUS_INSTALL_DIR:-$HOME/.aius/bin}"
REQUESTED_VERSION="${AIUS_VERSION:-latest}"

# ---- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m'); CYAN=$(printf '\033[36m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GREEN=""; CYAN=""; RESET=""
fi
info()  { printf '%s\n' "${DIM}aius${RESET} $*"; }
step()  { printf '%s\n' "${CYAN}==>${RESET} $*"; }
ok()    { printf '%s\n' "${GREEN}✓${RESET} $*"; }
err()   { printf '%s\n' "${RED}error:${RESET} $*" >&2; }
die()   { err "$@"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

# ---- detect platform ---------------------------------------------------------
detect_os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux)  echo "linux" ;;
    *) die "unsupported OS '$(uname -s)'. On Windows use the PowerShell installer: irm https://aius.co/install.ps1 | iex" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64)  echo "x64" ;;
    *) die "unsupported architecture '$(uname -m)'." ;;
  esac
}

# x64 builds ship an avx2 and a "baseline" (no-avx2) variant; pick baseline only
# when the CPU lacks avx2. arm64 has no baseline split.
is_baseline() {
  local os="$1" arch="$2"
  [ "$arch" = "x64" ] || return 1
  if [ "$os" = "linux" ]; then
    grep -qiw avx2 /proc/cpuinfo 2>/dev/null && return 1 || return 0
  elif [ "$os" = "darwin" ]; then
    [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)" = "1" ] && return 1 || return 0
  fi
  return 1
}

# Linux ships glibc (default) and musl (Alpine etc.) variants.
is_musl() {
  [ -f /etc/alpine-release ] && return 0
  if command -v ldd >/dev/null 2>&1; then
    ldd --version 2>&1 | grep -qi musl && return 0
  fi
  return 1
}

# Asset name mirrors packages/aius/script/build.ts:
#   aius-<os>-<arch>[-baseline][-musl]
asset_name() {
  local os="$1" arch="$2" name="${APP}-${os}-${arch}"
  is_baseline "$os" "$arch" && name="${name}-baseline"
  [ "$os" = "linux" ] && is_musl && name="${name}-musl"
  echo "$name"
}

# ---- resolve version ---------------------------------------------------------
resolve_version() {
  if [ "$REQUESTED_VERSION" != "latest" ]; then
    echo "$REQUESTED_VERSION"; return
  fi
  local api="https://api.github.com/repos/${GH_REPO}/releases/latest"
  local body=""
  # No bash arrays here: macOS ships bash 3.2, where expanding an empty array
  # under `set -u` aborts the script.
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    body=$(curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$api" 2>/dev/null) || true
  else
    body=$(curl -fsSL "$api" 2>/dev/null) || true
  fi
  local tag
  tag=$(printf '%s' "$body" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/') || true
  [ -n "$tag" ] || die "could not find a published release for ${GH_REPO}. Set AIUS_VERSION to install a specific tag."
  echo "$tag"
}

# ---- PATH wiring -------------------------------------------------------------
already_on_path() { case ":$PATH:" in *":$INSTALL_DIR:"*) return 0 ;; *) return 1 ;; esac; }

# POSIX single-quote escaping: wrap in '…' and replace each ' with '\''. The
# result is safe to write verbatim into a shell rc even if it held metacharacters
# (belt-and-suspenders with validate_install_dir).
shquote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

add_to_path() {
  already_on_path && return 0
  local q; q=$(shquote "$INSTALL_DIR")
  local line="export PATH=$q:\$PATH"
  local rc=""
  case "$(basename "${SHELL:-}")" in
    zsh)  rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) [ -f "$HOME/.bashrc" ] && rc="$HOME/.bashrc" || rc="$HOME/.bash_profile" ;;
    fish)
      local fish_dir="$HOME/.config/fish"
      mkdir -p "$fish_dir"
      if ! grep -qsF "$INSTALL_DIR" "$fish_dir/config.fish" 2>/dev/null; then
        printf '\n# aius\nfish_add_path %s\n' "$q" >> "$fish_dir/config.fish"
      fi
      PATH_RC="$fish_dir/config.fish"; return 0 ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -n "$rc" ] && ! grep -qsF "$INSTALL_DIR" "$rc" 2>/dev/null; then
    printf '\n# aius\n%s\n' "$line" >> "$rc"
  fi
  PATH_RC="$rc"
}

# ---- integrity ---------------------------------------------------------------
sha256_of() {
  if   command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else die "need 'sha256sum' or 'shasum' to verify the download"; fi
}

# Fail closed: a missing or mismatched checksum aborts rather than running an
# unverified binary.
verify_checksum() {
  local file="$1" sumurl="$2" expected actual
  expected=$(curl -fsSL "$sumurl" 2>/dev/null | awk 'NR==1{print $1}')
  [ -n "$expected" ] || die "could not fetch checksum ($sumurl) — refusing to install an unverified binary"
  actual=$(sha256_of "$file")
  [ "$expected" = "$actual" ] || die "checksum mismatch — expected $expected, got $actual. Aborting."
}

# Defense-in-depth against a path-traversal ("zip slip") archive: reject any
# member with an absolute path or a `..` component before we extract.
assert_safe_archive() {
  local file="$1" ext="$2" list
  if [ "$ext" = "tar.gz" ]; then
    list=$(tar -tzf "$file") || die "could not read archive contents"
  else
    list=$(unzip -Z1 "$file" 2>/dev/null) || list=$(unzip -l "$file" | awk 'NR>3{$1=$2=$3=""; sub(/^ +/,""); print}')
  fi
  if printf '%s\n' "$list" | grep -Eq '^/|(^|/)\.\.(/|$)'; then
    die "archive contains unsafe paths (path traversal) — aborting"
  fi
}

# The install dir is written verbatim into your shell rc, so reject any value
# with shell metacharacters that could inject commands run at shell startup.
validate_install_dir() {
  case "$INSTALL_DIR" in
    "") die "install dir is empty" ;;
    *[!A-Za-z0-9_\ ./~+-]*) die "AIUS_INSTALL_DIR has unsupported characters: $INSTALL_DIR" ;;
  esac
}

# ---- main --------------------------------------------------------------------
main() {
  need curl
  validate_install_dir
  local os arch asset version ext url tmp archive

  os=$(detect_os); arch=$(detect_arch)
  asset=$(asset_name "$os" "$arch")
  version=$(resolve_version)
  if [ "$os" = "linux" ]; then ext="tar.gz"; need tar; else ext="zip"; need unzip; fi
  url="https://github.com/${GH_REPO}/releases/download/${version}/${asset}.${ext}"

  step "Installing ${BOLD}${APP} ${version}${RESET} (${asset}) → ${INSTALL_DIR}"

  tmp=$(mktemp -d); trap 'rm -rf "${tmp:-}"' EXIT
  archive="$tmp/${asset}.${ext}"
  step "Downloading ${DIM}${url}${RESET}"
  curl -fSL --progress-bar "$url" -o "$archive" \
    || die "download failed. Asset may not exist for this platform/version: ${asset}.${ext}"

  step "Verifying checksum"
  verify_checksum "$archive" "${url}.sha256"
  assert_safe_archive "$archive" "$ext"

  step "Unpacking"
  if [ "$ext" = "tar.gz" ]; then tar -xzf "$archive" -C "$tmp"; else unzip -q -o "$archive" -d "$tmp"; fi

  [ -f "$tmp/aius" ] || die "archive did not contain an 'aius' binary"

  mkdir -p "$INSTALL_DIR"
  # The binary needs uv/uvx as siblings (the runtime resolves them next to it).
  for f in aius uv uvx; do
    [ -f "$tmp/$f" ] && install -m 0755 "$tmp/$f" "$INSTALL_DIR/$f"
  done

  # macOS: copying a Bun single-file executable invalidates its code signature,
  # so Gatekeeper SIGKILLs it on first run ("zsh: killed aius"). Re-apply an
  # ad-hoc signature in place. No-op if codesign is missing (best effort).
  if [ "$os" = "darwin" ] && command -v codesign >/dev/null 2>&1; then
    codesign -s - --force "$INSTALL_DIR/aius" >/dev/null 2>&1 || true
  fi

  local installed_version
  installed_version=$("$INSTALL_DIR/aius" --version 2>/dev/null || echo "$version")
  ok "Installed ${BOLD}${APP}${RESET} ${installed_version} to ${INSTALL_DIR}/aius"

  add_to_path
  echo ""
  if already_on_path; then
    info "Run: ${BOLD}aius${RESET}"
  else
    info "Added ${INSTALL_DIR} to your PATH in ${PATH_RC:-your shell profile}."
    info "Open a new terminal (or 'source ${PATH_RC:-~/.profile}'), then run: ${BOLD}aius${RESET}"
    info "Or run it now: ${BOLD}${INSTALL_DIR}/aius${RESET}"
  fi
}

main "$@"
