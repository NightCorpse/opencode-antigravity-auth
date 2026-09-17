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
    provider: {
      models: async () => ({
        "antigravity-gemini-3-pro": {
          name: "Gemini 3 Pro (Antigravity)",
        },
        "antigravity-gemini-3.8-flash-tiered": {
          name: "Internal Gemini 3.8 backend",
        },
        "antigravity-gemini-3.8-flash": {
          name: "Gemini 3.8 Flash (Antigravity)",
          status: "active",
          limit: { context: 1048576, output: 65536 },
          capabilities: {
            toolcall: true,
            input: { text: true, image: true, pdf: true },
            output: { text: true },
          },
          variants: {
            low: { thinkingLevel: "low" },
            medium: { thinkingLevel: "medium" },
            high: { thinkingLevel: "high" },
          },
        },
      }),
    },
  }),
}))

import { OpenCodeV2Plugin } from "./v2"

describe("OpenCodeV2Plugin", () => {
  it("registers the legacy fetch pipeline and OAuth method", async () => {
    const dispose = vi.fn(async () => undefined)
    let requestHook: ((event: { request: Request }) => Promise<void>) | undefined
    let responseHook: ((event: { request: Request; response: Response }) => void) | undefined
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
    let providerModels: Array<{
      id: string
      name: string
      variants: Array<{ id: string; settings?: Record<string, unknown> }>
    }> = []
    const removedModels: string[] = []

    const context = {
      location: { directory: "/workspace" },
      provider: {
        transform: async (callback: (editor: {
          get: (id: string) => { models: Map<string, typeof providerModels[number]> }
          update: (id: string, update: (provider: {
            activation: string
            settings?: Record<string, unknown>
          }) => void) => void
          models: { set: (id: string, models: typeof providerModels) => void }
        }) => void) => {
          callback({
            get: () => ({ models: new Map<string, typeof providerModels[number]>() }),
            update: (_id, update) => update({ activation: "auto" }),
            models: { set: (_id, models) => { providerModels = models } },
          })
          return { dispose }
        },
      },
      model: {
        transform: async (callback: (editor: {
          list: (id: string) => Array<{ id: string }>
          remove: (providerID: string, modelID: string) => void
        }) => void) => {
          callback({
            list: () => [
              { id: "antigravity-gemini-3-pro" },
              { id: "antigravity-gemini-3.5-flash-low" },
              { id: "antigravity-gemini-3.8-flash" },
            ],
            remove: (_providerID, modelID) => { removedModels.push(modelID) },
          })
          return { dispose }
        },
      },
      session: {
        hook: async (name: string, callback: typeof requestHook | typeof responseHook) => {
          if (name === "http.request") requestHook = callback as typeof requestHook
          if (name === "http.response") responseHook = callback as typeof responseHook
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
    const requestEvent = {
      request: new Request("https://generativelanguage.googleapis.com/v1/models/test"),
    }
    await requestHook?.(requestEvent)
    const responseEvent = {
      request: requestEvent.request,
      response: new Response("placeholder"),
    }
    responseHook?.(responseEvent)

    expect(state.loader).toHaveBeenCalledOnce()
    expect(state.fetch).toHaveBeenCalledOnce()
    expect(requestEvent.request.url).toContain("opencode-antigravity-")
    expect(await responseEvent.response.text()).toBe("ok")
    expect(oauthRegistration).toBeDefined()
    expect(googleSearch).toBeDefined()
    expect(providerModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "antigravity-gemini-3.8-flash",
        name: "Gemini 3.8 Flash (Antigravity)",
        variants: [
          expect.objectContaining({ id: "low", settings: { thinkingLevel: "low" } }),
          expect.objectContaining({ id: "medium", settings: { thinkingLevel: "medium" } }),
          expect.objectContaining({ id: "high", settings: { thinkingLevel: "high" } }),
        ],
      }),
    ]))
    expect(providerModels).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "antigravity-gemini-3-pro" }),
      expect.objectContaining({ id: "antigravity-gemini-3.8-flash-tiered" }),
    ]))
    expect(removedModels).toEqual([
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3.5-flash-low",
    ])

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
    expect(dispose).toHaveBeenCalledTimes(6)
  })
})
