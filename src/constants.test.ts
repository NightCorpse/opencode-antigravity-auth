import { describe, it, expect } from "vitest"
import {
  ANTIGRAVITY_CLI_USER_AGENT,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  getRandomizedHeaders,
  type HeaderSet,
} from "./constants.ts"

describe("Antigravity CLI identity", () => {
  it("includes the CLI product and consumer auth method", () => {
    expect(ANTIGRAVITY_CLI_USER_AGENT).toMatch(/^antigravity\/cli\/1\.1\.24 /)
    expect(ANTIGRAVITY_CLI_USER_AGENT).toContain("auth_method=consumer")
  })
})

describe("Antigravity generation endpoints", () => {
  it("uses only the current Daily endpoint", () => {
    expect(ANTIGRAVITY_ENDPOINT_FALLBACKS).toEqual([
      ANTIGRAVITY_ENDPOINT_DAILY,
    ])
    expect(ANTIGRAVITY_ENDPOINT_DAILY).toBe("https://daily-cloudcode-pa.googleapis.com")
  })
})

describe("getRandomizedHeaders", () => {
  describe("antigravity style", () => {
    it("returns all three headers", () => {
      const headers = getRandomizedHeaders("antigravity")
      expect(headers["User-Agent"]).toBeDefined()
      expect(headers["X-Goog-Api-Client"]).toBeDefined()
      expect(headers["Client-Metadata"]).toBeDefined()
    })

    it("returns User-Agent in antigravity format", () => {
      const headers = getRandomizedHeaders("antigravity")
      expect(headers["User-Agent"]).toMatch(/^antigravity\//)
    })

    it("aligns Client-Metadata platform with User-Agent platform", () => {
      for (let i = 0; i < 50; i++) {
        const headers = getRandomizedHeaders("antigravity")
        const ua = headers["User-Agent"]!
        const metadata = JSON.parse(headers["Client-Metadata"]!)
        if (ua.includes("windows/")) {
          expect(metadata.platform).toBe("WINDOWS")
        } else {
          expect(metadata.platform).toBe("MACOS")
        }
      }
    })

    it("never produces a linux User-Agent", () => {
      for (let i = 0; i < 50; i++) {
        const headers = getRandomizedHeaders("antigravity")
        expect(headers["User-Agent"]).not.toMatch(/linux\//)
      }
    })
  })
})

describe("HeaderSet type", () => {
  it("allows omitting X-Goog-Api-Client and Client-Metadata", () => {
    const headers: HeaderSet = {
      "User-Agent": "test",
    }
    expect(headers["User-Agent"]).toBe("test")
    expect(headers["X-Goog-Api-Client"]).toBeUndefined()
    expect(headers["Client-Metadata"]).toBeUndefined()
  })

  it("allows including all three headers", () => {
    const headers: HeaderSet = {
      "User-Agent": "test",
      "X-Goog-Api-Client": "test-client",
      "Client-Metadata": "test-metadata",
    }
    expect(headers["User-Agent"]).toBe("test")
    expect(headers["X-Goog-Api-Client"]).toBe("test-client")
    expect(headers["Client-Metadata"]).toBe("test-metadata")
  })
})
