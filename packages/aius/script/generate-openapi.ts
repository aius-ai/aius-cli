#!/usr/bin/env bun
// Dump the instance HTTP API's OpenAPI spec to stdout. This is exactly what the
// server serves at `GET /doc` (`Server.openapi()` / `OpenApi.fromApi(PublicApi)`),
// so the generated SDK stays in sync with the live routes. Consumed by
// `packages/sdk/js/script/build.ts`. (Replaces the old `bun dev generate`
// subcommand, which was dropped in the foundation prune.)
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../src/server/routes/instance/httpapi/public"

process.stdout.write(JSON.stringify(OpenApi.fromApi(PublicApi), null, 2))
