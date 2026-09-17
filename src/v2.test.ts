import { describe, expect, it, vi } from "vitest"

import type { Plugin } from "@opencode/plugin"

const state = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response("ok")),
  loader: vi.fn(),
}))

vi.mock("./plugin", () => ({
  createAntigravityPlugin: () => async () => ({
    auth: {
      provider: "google",
      loader: state.loader.mockImplementation(async () => ({
        apiKey: "",
        fetch: state.fetch,
      })),
      methods: [
        {
          label: "OAuth with Google (Antigravity)",
          type: "oauth",
          authorize: async () => ({
            url: "https://example.com/oauth",
            instructions: "Sign in",
            method: "code",
            callback: async () => ({
              type: "success",
              refresh: "refresh-token",
              access: "access-token",
              expires: 123,
              email: "user@example.com",
              projectId: "project",
            }),
          }),
        },
      ],
    },
    tool: {
      google_search: {
        description: "Search Google",
        execute: async () => "result",
      },
    },
  }),
}))

import { OpenCodeV2Plugin } from "./v2"

describe("OpenCodeV2Plugin", () => {
  it("registers the legacy fetch pipeline and OAuth method", async () => {
    const dispose = vi.fn(async () => undefined)
    let sdkHook: ((event: { options: Record<string, unknown> }) => void) | undefined
    let oauthRegistration: {
      authorize: () => Promise<{
        mode: "code"
        callback: (code: string) => Promise<{
          type: string
          refresh: string
          access: string
          metadata?: Record<string, unknown>
        }>
      }>
    } | undefined
    let googleSearch: {
      execute: (input: unknown, context: {
        sessionID: string
        messageID: string
        agent: string
      }) => Promise<{ content?: string }>
    } | undefined

    const context = {
      location: { directory: "/workspace" },
      provider: {
        transform: async (callback: (editor: {
          update: (id: string, update: (provider: {
            activation: string
            settings?: Record<string, unknown>
          }) => void) => void
        }) => void) => {
          callback({
            update: (_id, update) => update({ activation: "auto" }),
          })
          return { dispose }
        },
      },
      aisdk: {
        hook: async (_name: string, callback: typeof sdkHook) => {
          sdkHook = callback
          return { dispose }
        },
      },
      integration: {
        connection: {
          active: async () => undefined,
          resolve: async () => undefined,
        },
        transform: async (callback: (editor: {
          method: { update: (registration: typeof oauthRegistration) => void }
        }) => void) => {
          callback({ method: { update: (registration) => { oauthRegistration = registration } } })
          return { dispose }
        },
      },
      event: {
        subscribe: async function* () {},
      },
      tool: {
        transform: async (callback: (editor: {
          add: (definition: typeof googleSearch) => void
        }) => void) => {
          callback({ add: (definition) => { googleSearch = definition } })
          return { dispose }
        },
      },
    } as unknown as Plugin.Context

    const cleanup = await OpenCodeV2Plugin.setup(context)
    const event = { options: {} as Record<string, unknown> }
    sdkHook?.(event)

    expect(state.loader).toHaveBeenCalledOnce()
    expect(event.options.fetch).toBe(state.fetch)
    expect(event.options.apiKey).toBe("antigravity-oauth")
    expect(oauthRegistration).toBeDefined()
    expect(googleSearch).toBeDefined()

    const authorization = await oauthRegistration?.authorize()
    expect(authorization?.mode).toBe("code")
    const credential = await authorization?.callback("code")
    expect(credential).toMatchObject({
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      metadata: { email: "user@example.com", projectId: "project" },
    })

    const toolResult = await googleSearch?.execute(
      { query: "OpenCode" },
      { sessionID: "session", messageID: "message", agent: "build" },
    )
    expect(toolResult).toEqual({ content: "result" })

    await cleanup?.()
    expect(dispose).toHaveBeenCalledTimes(4)
  })
})
