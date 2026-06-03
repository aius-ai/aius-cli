import { createMemo, createSignal, onMount } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogPassword } from "@tui/ui/dialog-password"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogSelect } from "@tui/ui/dialog-select"
import { completeTwoFactorLogin, loginWithPassword, registerWithPassword } from "@/auth/password"
import { validateEmail, validateName, validatePassword } from "@/auth/validate"
import { AIUS_AUTH_KEY } from "@/auth"
import { apiBaseUrlTrimmed } from "@/config/api-url"
import { hasStoredToken } from "@tui/util/auth-check"

// Persist a minted aius_ token via the SDK, reset the instance, and resync so
// the rest of the TUI picks up the new credential (mirrors onboarding).
async function persistToken(
  sdk: ReturnType<typeof useSDK>,
  sync: ReturnType<typeof useSync>,
  token: string,
): Promise<void> {
  await sdk.client.auth.set({ providerID: AIUS_AUTH_KEY, auth: { type: "api", key: token } })
  await sdk.client.instance.dispose()
  await sync.bootstrap()
}

/**
 * Account menu: opened via a keybinding. When no credential is stored it offers
 * login / register / paste-key; once a token exists it offers only logout.
 * Multi-field flows are collected by chaining
 * the single-input DialogPrompt (email -> name -> password), which keeps us on
 * the existing primitives rather than a bespoke multi-input widget.
 */
export function DialogAccount() {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()

  // Treat "a credential exists" the same as "logged in": once a token is stored
  // locally, the only relevant action is Log out. This is a fast, network-free
  // check, so the menu settles immediately. Until it resolves we assume no token
  // (show the sign-in options) — the common first-run case.
  const [hasToken, setHasToken] = createSignal(false)
  onMount(() => {
    void hasStoredToken().then(setHasToken)
  })

  async function doLogin() {
    const email = await DialogPrompt.show(dialog, "Log in — email", { placeholder: "you@company.com" })
    if (!email) return
    const emailErr = validateEmail(email)
    if (emailErr) return openError(emailErr)
    const password = await DialogPassword.show(dialog, "Log in — password")
    if (!password) return
    const work = openWorking("Logging in…")
    const res = await loginWithPassword(email.trim(), password)
    work()
    if (!res.ok) {
      // Account has 2FA: prompt for a TOTP/recovery code and finish.
      if ("twoFactor" in res) return doTwoFactor(res.twoFactor.challengeToken)
      return openError(res.error)
    }
    await persistToken(sdk, sync, res.token)
    dialog.clear()
  }

  async function doTwoFactor(challengeToken: string) {
    const code = await DialogPrompt.show(dialog, "Two-factor code", {
      placeholder: "6-digit code or recovery code",
    })
    if (!code) return
    const work = openWorking("Verifying…")
    const res = await completeTwoFactorLogin(challengeToken, code.trim())
    work()
    if (!res.ok) return openError("error" in res ? res.error : "Verification failed")
    await persistToken(sdk, sync, res.token)
    dialog.clear()
  }

  async function doRegister() {
    const email = await DialogPrompt.show(dialog, "Create account — email", { placeholder: "you@company.com" })
    if (!email) return
    const emailErr = validateEmail(email)
    if (emailErr) return openError(emailErr)
    const name = await DialogPrompt.show(dialog, "Create account — name", { placeholder: "Your name" })
    if (!name) return
    const nameErr = validateName(name)
    if (nameErr) return openError(nameErr)
    const password = await DialogPassword.show(dialog, "Create account — password")
    if (!password) return
    const pwErr = validatePassword(password)
    if (pwErr) return openError(pwErr)
    const work = openWorking("Creating account…")
    const res = await registerWithPassword(email.trim(), name.trim(), password)
    work()
    if (!res.ok) return openError("error" in res ? res.error : "Registration failed")
    await persistToken(sdk, sync, res.token)
    dialog.clear()
  }

  async function doPasteToken() {
    const key = await DialogPrompt.show(dialog, "Paste your AIUS API key", { placeholder: "aius_..." })
    if (!key) return
    const token = key.trim()
    if (!token) return
    // Verify before saving so a typo is caught immediately; if the API is
    // unreachable, save anyway rather than block the user.
    const work = openWorking("Verifying key…")
    let rejected = false
    try {
      const res = await fetch(apiBaseUrlTrimmed() + "/models", {
        headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(4000),
      })
      rejected = res.status === 401 || res.status === 403
    } catch {
      // unreachable — fall through and save
    }
    work()
    if (rejected) return openError("That API key was rejected by the AIUS server (401).")
    await persistToken(sdk, sync, token)
    dialog.clear()
  }

  async function doLogout() {
    await sdk.client.auth.remove({ providerID: AIUS_AUTH_KEY })
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.clear()
  }

  // Small helpers that reuse existing dialogs for transient states.
  function openWorking(text: string): () => void {
    dialog.replace(() => <DialogPrompt title={text} busy busyText={text} />)
    return () => {}
  }
  function openError(message: string) {
    dialog.replace(() => (
      <DialogConfirm title="Authentication failed" message={message} label="ok" onConfirm={() => dialog.clear()} />
    ))
  }

  // Once a credential exists (logged in, or a pasted/static key), the only
  // relevant action is Log out. The sign-in options (login / register / paste)
  // appear only when there is no stored token, so the menu never mixes "log in"
  // with "log out".
  const options = createMemo(() =>
    hasToken()
      ? [{ value: "logout", title: "Log out" }]
      : [
          { value: "login", title: "Log in", description: "email + password" },
          { value: "register", title: "Create account", description: "email + password" },
          { value: "pat", title: "Paste API key", description: "use an existing aius_… token" },
        ],
  )

  return (
    <DialogSelect
      title="AIUS account"
      skipFilter
      renderFilter={false}
      options={options()}
      onSelect={(option) => {
        if (option.value === "login") void doLogin()
        else if (option.value === "register") void doRegister()
        else if (option.value === "pat") void doPasteToken()
        else if (option.value === "logout") void doLogout()
      }}
    />
  )
}
