# Releasing & publishing AIUS

There are two distribution channels, both fed by the same per-platform binaries
produced by the build:

1. **GitHub Releases** — consumed by `install.sh` / `install.ps1`.
2. **npm** — the `@aius-ai/cli` global package.

## 1. Build the binaries

From the repo root (requires Bun ≥ 1.3):

```sh
bun install
# Builds all platform targets into packages/aius/dist/*
# The production gateway URL (https://aius.co/api/v1) is baked in by default;
# only set AIUS_API_URL at build time for special builds.
AIUS_VERSION=<x.y.z> AIUS_RELEASE=1 GH_REPO=aius-ai/aius-cli bun run packages/aius/script/build.ts
```

This emits, for each target, a `dist/<name>/bin/aius` binary plus, when
`AIUS_RELEASE` is set, a `<name>.zip` / `<name>.tar.gz` archive and a
`<name>.<ext>.sha256` checksum. Target names match what the installers expect:
`aius-darwin-arm64`, `aius-linux-x64`, `aius-windows-x64-baseline`, etc.

## 2. Cut a GitHub Release (for install.sh / install.ps1)

The installers download `https://github.com/aius-ai/aius-cli/releases/download/<tag>/<asset>.<ext>`
and verify it against `<asset>.<ext>.sha256`.

```sh
gh release create v1.15.11 \
  ./packages/aius/dist/*.zip \
  ./packages/aius/dist/*.tar.gz \
  ./packages/aius/dist/*.sha256 \
  --repo aius-ai/aius-cli \
  --title v1.15.11 --generate-notes
```

> `packages/aius/script/build.ts` can also upload assets automatically when
> `Script.release` is set and `GH_REPO` points at `aius-ai/aius-cli`.

Once a release exists, the one-liners work:

```sh
curl -fsSL https://aius.co/install.sh | sh
```

## 3. Publish to npm (`@aius-ai/cli`)

The npm distribution is **scoped and public**. The launcher package lives in
`npm/`; the per-platform binary packages are published from
`packages/aius/dist/<name>/`.

> Requires an npm account with publish rights to the `@aius-ai` scope
> (`npm login` first). Not done automatically — no credentials are stored here.

```sh
# a) publish each platform package (each contains one compiled binary)
for d in packages/aius/dist/aius-*/; do
  npm publish "$d" --access public
done

# b) bump the version + optionalDependencies in npm/package.json to match,
#    then publish the launcher
cd npm
npm publish        # publishConfig.access=public is already set
```

After this, `npm install -g @aius-ai/cli` resolves the launcher, pulls the one
matching `aius-<os>-<arch>` optional dependency, and the `postinstall` wires up
the binary.

### Keep versions in sync

`npm/package.json` `version` and every entry under `optionalDependencies` must
equal the binary version (`packages/aius/package.json` `version`). A release
script should rewrite all three together.
