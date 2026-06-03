// Guard against leaking credentials over an untrusted transport. A bearer/admin
// token may only be sent over TLS (https/wss) OR to a loopback host (local dev).
// Plaintext (http/ws) to a remote host would expose the token to on-path
// interception or a redirected AIUS_API_URL.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

export const isLoopbackOrSecure = (url: string): boolean => {
  const u = new URL(url)
  if (u.protocol === "https:" || u.protocol === "wss:") return true
  return LOOPBACK.has(u.hostname)
}

export * as Transport from "./transport"
