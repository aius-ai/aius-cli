import { expect, test } from "bun:test"
import { isLoopbackOrSecure } from "@/util/transport"

test("allows TLS to any host and plaintext only to loopback", () => {
  // secure transport — fine anywhere
  expect(isLoopbackOrSecure("https://api.dev.aius.co/v1")).toBe(true)
  expect(isLoopbackOrSecure("wss://api.dev.aius.co/v1/runs/ws")).toBe(true)
  // plaintext to loopback — fine for local dev
  expect(isLoopbackOrSecure("http://localhost:8000/v1")).toBe(true)
  expect(isLoopbackOrSecure("ws://127.0.0.1:8000/v1/runs/ws")).toBe(true)
  expect(isLoopbackOrSecure("http://[::1]:8000/v1")).toBe(true)
  // plaintext to a remote host — refused (would leak the token)
  expect(isLoopbackOrSecure("http://api.dev.aius.co/v1")).toBe(false)
  expect(isLoopbackOrSecure("ws://evil.example:8000/v1/runs/ws")).toBe(false)
})
