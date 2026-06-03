#!/usr/bin/env bun
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { runSeed } from "@/agent-seed/seed"
import { apiBaseUrl } from "@/config/api-url"

// Seeds the "build" agent's prompt, tool schemas, and agent record into the
// backend via the admin API. Runs under AppRuntime — the same runtime the TUI
// worker uses — so the ToolRegistry resolves identically to the running app.
// The admin client prepends `/v1/admin/...`, so strip a trailing `/v1` from the
// base (the default and AIUS_API_URL both include it) to avoid a double `/v1`.
const base = apiBaseUrl().replace(/\/v1\/?$/, "")
const token = process.env.AIUS_API_KEY
if (!token) {
  process.stderr.write("AIUS_API_KEY is required\n")
  process.exit(1)
}

// collectTools resolves instance-scoped services, so seed inside an instance
// context bound to the current working directory.
const { verifiedToolCount } = await AppRuntime.runPromise(
  InstanceStore.Service.use((store) => store.provide({ directory: process.cwd() }, runSeed({ base, token }))),
)

process.stdout.write(`Seeded "build" agent — verified ${verifiedToolCount} tools.\n`)
process.exit(0)
