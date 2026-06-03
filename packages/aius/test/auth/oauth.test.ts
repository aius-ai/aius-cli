import { describe, expect, it } from "bun:test"
import * as OAuth from "../../src/auth/oauth"

describe("OAuth", () => {
  describe("OAuth module structure", () => {
    it("should have getOAuthConfig function", () => {
      expect(typeof OAuth.getOAuthConfig).toBe("function")
    })

    it("should have getAuthorizationUrl function", () => {
      expect(typeof OAuth.getAuthorizationUrl).toBe("function")
    })

    it("should have exchangeCodeForTokens function", () => {
      expect(typeof OAuth.exchangeCodeForTokens).toBe("function")
    })

    it("should have refreshAccessToken function", () => {
      expect(typeof OAuth.refreshAccessToken).toBe("function")
    })

    it("should have storeOAuthTokens function", () => {
      expect(typeof OAuth.storeOAuthTokens).toBe("function")
    })

    it("should have getStoredOAuthTokens function", () => {
      expect(typeof OAuth.getStoredOAuthTokens).toBe("function")
    })

    it("should have loginWithOAuth function", () => {
      expect(typeof OAuth.loginWithOAuth).toBe("function")
    })
  })

  describe("getOAuthConfig", () => {
    it("should return OAuth configuration from environment", async () => {
      const config = await OAuth.getOAuthConfig()
      expect(config.client_id).toBe("cli_f12391458360404d99ce9815")
      expect(config.client_secret).toBe("D2rAmqmOwXQVM-ngsHW7gBwZTj7igVfdK2XfFgCDnNE")
      expect(config.redirect_uri).toBe("http://localhost:3000/callback")
      expect(config.scopes).toContain("openid")
      expect(config.scopes).toContain("profile")
      expect(config.auth_url).toContain("/oauth/authorize")
      expect(config.token_url).toContain("/oauth/token")
    })
  })

  describe("getAuthorizationUrl", () => {
    it("should generate authorization URL with PKCE parameters", async () => {
      const { url, code_verifier, state } = await OAuth.getAuthorizationUrl()
      
      expect(url).toContain("response_type=code")
      expect(url).toContain("client_id=cli_f12391458360404d99ce9815")
      expect(url).toContain("redirect_uri=")
      expect(url).toContain("scope=")
      expect(url).toContain("state=")
      expect(url).toContain("code_challenge=")
      expect(url).toContain("code_challenge_method=S256")
      expect(url).toContain("nonce=")
      
      expect(code_verifier).toBeDefined()
      expect(code_verifier.length).toBeGreaterThan(0)
      expect(state).toBeDefined()
      expect(state.length).toBeGreaterThan(0)
    })

    it("should generate unique state and nonce for each call", async () => {
      const result1 = await OAuth.getAuthorizationUrl()
      const result2 = await OAuth.getAuthorizationUrl()
      
      expect(result1.state).not.toBe(result2.state)
      expect(result1.code_verifier).not.toBe(result2.code_verifier)
    })
  })

  describe("PKCE implementation", () => {
    it("should generate code verifier with correct length", async () => {
      const { code_verifier } = await OAuth.getAuthorizationUrl()
      expect(code_verifier.length).toBeGreaterThan(30)
      expect(code_verifier.length).toBeLessThan(100)
    })

    it("should generate code challenge that is base64url encoded", async () => {
      const { url } = await OAuth.getAuthorizationUrl()
      const urlObj = new URL(url)
      const codeChallenge = urlObj.searchParams.get("code_challenge")
      
      expect(codeChallenge).toBeDefined()
      // Base64url encoding should not have +, /, or = at the end
      expect(codeChallenge).not.toMatch(/[+\/=]/)
    })
  })
})
