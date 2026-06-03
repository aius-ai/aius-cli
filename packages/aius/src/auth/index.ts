import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@aius-ai/core/schema"
import { Global } from "@aius-ai/core/global"
import { AppFileSystem } from "@aius-ai/core/filesystem"
import { apiBaseUrlTrimmed } from "@/config/api-url"
import * as OAuth from "@/auth/oauth"

export const OAUTH_DUMMY_KEY = "aius-oauth-dummy-key"

// The auth-store slot the AIUS bearer (PAT) lives under. It is the OpenRouter
// proxy provider id, so the TUI onboarding gate and the CLI `auth` commands all
// read/write the same entry. Import this instead of hardcoding the literal.
export const AIUS_AUTH_KEY = "openrouter"

export type VerifyResult = "valid" | "invalid" | "unreachable"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly verify: (token: string) => Effect.Effect<VerifyResult>
  readonly getAccessToken: () => Effect.Effect<string | undefined, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@aius/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.AIUS_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.AIUS_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    // Validate a bearer against the AIUS api by hitting the bearer-protected
    // GET {AIUS_API_URL}/models. ok -> valid, 401/403 -> invalid, anything else
    // (incl. network error / api down) -> unreachable, so an outage never
    // rejects a good token. Covers both aius_… tokens and a static AIUS_API_KEY.
    const verify = Effect.fn("Auth.verify")(function* (token: string) {
      const base = apiBaseUrlTrimmed()
      return yield* Effect.tryPromise(() =>
        fetch(base + "/models", {
          headers: { Authorization: `Bearer ${token}` },
          // Bound the call so a slow/hung API can never block startup.
          signal: AbortSignal.timeout(4000),
        }),
      ).pipe(
        Effect.map((res): VerifyResult =>
          res.ok ? "valid" : res.status === 401 || res.status === 403 ? "invalid" : "unreachable",
        ),
        Effect.orElseSucceed((): VerifyResult => "unreachable"),
      )
    })

    // Get a valid access token, refreshing if necessary
    const getAccessToken = Effect.fn("Auth.getAccessToken")(function* () {
      const info = yield* get(AIUS_AUTH_KEY)
      
      if (!info) {
        return undefined
      }
      
      if (info.type === "api") {
        return info.key
      }
      
      if (info.type === "oauth") {
        const now = Math.floor(Date.now() / 1000)
        // Refresh if token expires in less than 5 minutes
        if (info.expires - now < 300) {
          const tokens = yield* Effect.tryPromise(() =>
            OAuth.refreshAccessToken(info.refresh),
          ).pipe(Effect.mapError(fail("Failed to refresh access token")))
          const typedTokens = tokens as { access_token: string; refresh_token: string; expires_in: number }
          yield* set(AIUS_AUTH_KEY, {
            type: "oauth",
            access: typedTokens.access_token,
            refresh: typedTokens.refresh_token,
            expires: now + typedTokens.expires_in,
          } as Oauth)
          return typedTokens.access_token
        }
        
        return info.access
      }
      
      return undefined
    })

    return Service.of({ get, all, set, remove, verify, getAccessToken })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
