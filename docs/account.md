# The account portal

Your AIUS account lives at **[aius.co/account](https://aius.co/account)**. The
portal is where you create your account, manage **API keys**, set up
**two-factor authentication**, and manage your **clients / projects** — the same
credential you then use to sign in from the CLI.

- [Creating an account](#creating-an-account)
- [API keys](#api-keys)
- [Two-factor authentication (2FA)](#two-factor-authentication-2fa)
- [Recovery codes](#recovery-codes)
- [Clients & projects](#clients--projects)

> You can do almost everything from the terminal too — `aius auth register`,
> `aius auth login`, and the TUI account menu cover sign-up and sign-in. The
> portal is the place for API-key management and 2FA setup.

## Creating an account

Go to **[aius.co](https://aius.co)** and sign up with your email, name, and a
password. (Or run `aius auth register`.) After signing up you can sign in from
the CLI immediately — see [auth.md](auth.md).

Sign in to the portal at **[aius.co/account/signin](https://aius.co/account/signin)**.

## API keys

API keys are durable `aius_…` tokens that authenticate the CLI (and any other
client) to the AIUS gateway.

- **Create a key** in the portal, give it a name, and copy it — you'll see the
  full value once, so save it somewhere safe.
- **Use it** with `aius auth login --key aius_…`, by pasting it into the
  first-run / account-menu prompt, or via `AIUS_API_KEY=aius_… aius`.
- **Revoke a key** in the portal at any time; revoked keys stop working
  immediately (the CLI then gets a `401` and you re-authenticate).

The email/password and 2FA sign-in flows also mint an `aius_` key under the hood
(named `aius-cli-<date>`) so every sign-in method ends up with the same kind of
token.

## Two-factor authentication (2FA)

Enable 2FA in the portal to require a one-time code in addition to your
password:

1. In the portal, start 2FA setup. You'll get a QR code / secret.
2. Scan it with an authenticator app (Google Authenticator, 1Password, Authy,
   etc.).
3. Confirm by entering a generated 6-digit code.
4. **Save your recovery codes** (see below).

After that, signing in from the CLI prompts for your code:

```
Two-factor code (or recovery code):
```

Enter the 6-digit code from your app to finish. See
[auth.md](auth.md#2-two-factor-authentication-2fa).

## Recovery codes

When you enable 2FA the portal gives you a set of **single-use recovery codes**.
Store them somewhere safe (a password manager). If you ever lose access to your
authenticator app, enter a recovery code at the CLI's 2FA prompt instead of a
6-digit code — it's accepted at the same prompt.

Each recovery code works once. Regenerate the set from the portal if you run low
or suspect they've leaked; regenerating invalidates the old set.

## Clients & projects

The portal also manages your **clients** and **data projects** (project list,
run history, traces, usage). These features are evolving — check
[aius.co/account](https://aius.co/account) for the current capabilities. For
running analyses day to day you only need an account and a way to sign in; the
CLI handles the rest.
</content>
