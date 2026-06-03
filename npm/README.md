# @aius-ai/cli

**An autonomous data-science agent in your terminal.**

```sh
npm install -g @aius-ai/cli
aius
```

This package installs the `aius` command. On install it fetches the prebuilt,
self-contained binary for your platform (macOS / Linux / Windows, arm64 / x64,
glibc / musl) — no Node, Bun, or Python required at runtime.

- Website: https://aius.co
- Docs: https://aius.co/docs
- Project home: https://github.com/aius-ai/aius-cli

After installing, run `aius` and sign in. See the [docs](https://aius.co/docs)
for usage, the full CLI reference, authentication (including 2FA), and
configuration.

## How it works

`@aius-ai/cli` is a thin launcher. It declares the per-platform binary packages
(`aius-<os>-<arch>`) as `optionalDependencies`; npm installs only the one that
matches your machine. A `postinstall` step then materializes the correct binary
next to the `bin/aius` launcher (and, on macOS, re-applies an ad-hoc code
signature so Gatekeeper doesn't kill the copied binary).

See `../PUBLISHING.md` for the release/publish flow.
