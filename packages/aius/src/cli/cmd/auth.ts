import type { CommandModule } from "yargs"
import { Effect } from "effect"
import { Auth } from "@/auth"
import { completeTwoFactorLogin, loginWithPassword, registerWithPassword } from "@/auth/password"
import { UI } from "@/cli/ui"
import { errorMessage } from "@/util/error"

// ── pretty output ────────────────────────────────────────────────────────────
const { Style } = UI
const RESET = Style.TEXT_NORMAL
const BRAND = "\x1b[38;2;222;123;255m" // brand violet #de7bff

const heading = (m: string) => UI.println(`${BRAND}\x1b[1m${m}${RESET}`)
const ok = (m: string) => UI.println(`${Style.TEXT_SUCCESS_BOLD}✓${RESET} ${m}`)
const bad = (m: string) => UI.println(`${Style.TEXT_DANGER_BOLD}✗${RESET} ${m}`)
const warn = (m: string) => UI.println(`${Style.TEXT_WARNING_BOLD}!${RESET} ${m}`)
const note = (m: string) => UI.println(`${Style.TEXT_DIM}${m}${RESET}`)

function mask(key: string): string {
  if (key.length <= 10) return key.slice(0, 2) + "…"
  return key.slice(0, 8) + "…" + key.slice(-4)
}

// Run an Auth-service program with the default (file-backed) layer.
const runAuth = <A, E>(program: Effect.Effect<A, E, Auth.Service>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(Auth.defaultLayer)))

// Persist a minted aius_ token using the existing PAT (Api) auth entry, so
// email/password and OAuth all converge on the same stored credential.
const saveToken = (key: string) =>
  runAuth(
    Effect.gen(function* () {
      yield* (yield* Auth.Service).set(Auth.AIUS_AUTH_KEY, new Auth.Api({ type: "api", key }))
    }),
  )

// Minimal hidden-input prompt for passwords (no echo). Falls back to UI.input
// if stdin isn't a TTY.
async function promptPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY) return UI.input(label)
  process.stderr.write(label)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  let value = ""
  return await new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      const ch = buf.toString("utf8")
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.off("data", onData)
        process.stderr.write("\n")
        resolve(value)
      } else if (ch === "\u0003") {
        // Ctrl-C
        stdin.setRawMode(false)
        stdin.pause()
        process.stderr.write("\n")
        process.exit(130)
      } else if (ch === "\u007f" || ch === "\b") {
        // Backspace / DEL
        value = value.slice(0, -1)
      } else {
        value += ch
      }
    }
    stdin.on("data", onData)
  })
}

// ── overview (bare `aius auth`) ──────────────────────────────────────────────
function printAuthOverview() {
  UI.empty()
  heading("AIUS authentication")
  UI.empty()
  UI.println(`  ${Style.TEXT_NORMAL_BOLD}aius auth login${RESET}            Log in (email + password, or --key for a PAT)`)
  UI.println(`  ${Style.TEXT_NORMAL_BOLD}aius auth register${RESET}         Create an account (email + password)`)
  UI.println(`  ${Style.TEXT_NORMAL_BOLD}aius auth status${RESET}           Show the current login`)
  UI.println(`  ${Style.TEXT_NORMAL_BOLD}aius auth logout${RESET}           Remove the saved token`)
  UI.empty()
  note("Run `aius auth <command> --help` for details.")
  UI.empty()
}

const SAVED = "Logged in. Token saved to ~/.local/share/aius/auth.json (mode 0600)."

// ── login ────────────────────────────────────────────────────────────────────
// PAT path: validate the pasted key, then store it.
async function patLogin(key: string | undefined, force: boolean): Promise<void> {
  if (!key) key = await UI.input("AIUS API key: ")
  key = key?.trim()
  if (!key) {
    bad("No API key provided.")
    process.exitCode = 1
    return
  }
  const result = await runAuth(Effect.gen(function* () {
    return yield* (yield* Auth.Service).verify(key!)
  }))
  if (result === "invalid") {
    bad("That API key was rejected by the AIUS API (401). Check the key and try again.")
    process.exitCode = 1
    return
  }
  if (result === "unreachable" && !force) {
    warn("Could not reach the AIUS API to verify the key — saving anyway.")
    note("Set AIUS_API_URL or pass --force to silence this.")
  }
  await saveToken(key)
  UI.empty()
  ok(SAVED)
  UI.empty()
}

// Email/password path: login (or register) -> mint an aius_ token -> store it.
async function passwordLogin(email: string | undefined, password: string | undefined): Promise<void> {
  if (!email) email = (await UI.input("Email: ")).trim()
  if (!password) password = await promptPassword("Password: ")
  if (!email || !password) {
    bad("Email and password are required.")
    process.exitCode = 1
    return
  }
  let res = await loginWithPassword(email, password)
  // Account has 2FA enabled: prompt for a code and finish the challenge.
  if (!res.ok && "twoFactor" in res) {
    const code = (await UI.input("Two-factor code (or recovery code): ")).trim()
    if (!code) {
      bad("A verification code is required.")
      process.exitCode = 1
      return
    }
    res = await completeTwoFactorLogin(res.twoFactor.challengeToken, code)
  }
  if (!res.ok) {
    bad("error" in res ? res.error : "Verification failed.")
    process.exitCode = 1
    return
  }
  await saveToken(res.token)
  UI.empty()
  ok(SAVED)
  UI.empty()
}

const login: CommandModule = {
  command: "login",
  describe: "Log in to AIUS (email + password, or --key for a PAT)",
  builder: (yargs) =>
    yargs
      .option("email", { type: "string", describe: "account email (email/password login)" })
      .option("password", { type: "string", describe: "account password (omit to be prompted securely)" })
      .option("key", { type: "string", describe: "AIUS API key for PAT login (skips email/password)" })
      .option("force", {
        type: "boolean",
        describe: "with --key, save even if the AIUS API can't be reached to verify it",
      })
      .example("aius auth login", "interactive email + password login")
      .example("aius auth login --email you@co.com", "login, prompt for password")
      .example("aius auth login --key aius_xxx", "log in with an existing API key (PAT)"),
  handler: async (raw) => {
    const args = raw as unknown as { email?: string; password?: string; key?: string; force?: boolean }
    try {
      // --key selects PAT mode; otherwise email/password.
      if (args.key) {
        await patLogin(args.key, !!args.force)
      } else {
        await passwordLogin(args.email, args.password)
      }
    } catch (e) {
      bad(errorMessage(e))
      process.exitCode = 1
    }
  },
}

const register: CommandModule = {
  command: "register",
  describe: "Create a new AIUS account (email + password)",
  builder: (yargs) =>
    yargs
      .option("email", { type: "string", describe: "account email" })
      .option("name", { type: "string", describe: "your name" })
      .option("password", { type: "string", describe: "account password (omit to be prompted securely)" })
      .example("aius auth register", "interactive account creation")
      .example("aius auth register --email you@co.com --name 'You'", "register, prompt for password"),
  handler: async (raw) => {
    const args = raw as unknown as { email?: string; name?: string; password?: string }
    try {
      const email = (args.email ?? (await UI.input("Email: "))).trim()
      const name = (args.name ?? (await UI.input("Name: "))).trim()
      const password = args.password ?? (await promptPassword("Password: "))
      if (!email || !name || !password) {
        bad("Email, name, and password are required.")
        process.exitCode = 1
        return
      }
      const res = await registerWithPassword(email, name, password)
      if (!res.ok) {
        bad("error" in res ? res.error : "Registration failed.")
        process.exitCode = 1
        return
      }
      await saveToken(res.token)
      UI.empty()
      ok("Account created. " + SAVED)
      UI.empty()
    } catch (e) {
      bad(errorMessage(e))
      process.exitCode = 1
    }
  },
}

// ── logout ───────────────────────────────────────────────────────────────────
const logout: CommandModule = {
  command: "logout",
  describe: "Remove the saved AIUS token from this machine",
  builder: (yargs) => yargs.example("aius auth logout", "remove the saved token"),
  handler: async () => {
    try {
      await runAuth(Effect.gen(function* () {
        yield* (yield* Auth.Service).remove(Auth.AIUS_AUTH_KEY)
      }))
      ok("Logged out. Local AIUS token removed.")
    } catch (e) {
      bad(errorMessage(e))
      process.exitCode = 1
    }
  },
}

// ── status ───────────────────────────────────────────────────────────────────
const status: CommandModule = {
  command: "status",
  describe: "Show the current AIUS login and whether the token is valid",
  builder: (yargs) => yargs.example("aius auth status", "show the current login"),
  handler: async () => {
    try {
      const info = await runAuth(Effect.gen(function* () {
        return yield* (yield* Auth.Service).get(Auth.AIUS_AUTH_KEY)
      }))

      UI.empty()
      heading("AIUS authentication")
      UI.empty()
      if (!info || info.type !== "api") {
        note("Not logged in. Run `aius auth login` to add an API key.")
        UI.empty()
        return
      }

      const verify = await runAuth(Effect.gen(function* () {
        return yield* (yield* Auth.Service).verify((info as { key: string }).key)
      }))
      const validity =
        verify === "valid"
          ? `${Style.TEXT_SUCCESS}valid${RESET}`
          : verify === "invalid"
            ? `${Style.TEXT_DANGER}invalid — run \`aius auth login\`${RESET}`
            : `${Style.TEXT_DIM}unverified (AIUS API unreachable)${RESET}`

      UI.println(`  Status   ${Style.TEXT_SUCCESS_BOLD}logged in${RESET}`)
      UI.println(`  Key      ${mask((info as { key: string }).key)}`)
      UI.println(`  Token    ${validity}`)
      UI.empty()
    } catch (e) {
      bad(errorMessage(e))
      process.exitCode = 1
    }
  },
}

// ── group ────────────────────────────────────────────────────────────────────
export const AuthCommand: CommandModule = {
  command: "auth",
  describe: "Manage AIUS authentication (login / register / logout / status)",
  builder: (yargs) =>
    yargs
      .command(login)
      .command(register)
      .command(logout)
      .command(status)
      .example("aius auth login", "email + password login")
      .example("aius auth register", "create an account")
      .example("aius auth login --key aius_xxx", "log in with an existing API key"),
  handler: () => printAuthOverview(),
}
