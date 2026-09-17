import { Credential, Plugin } from "@opencode/plugin"

import { ANTIGRAVITY_PROVIDER_ID } from "./constants"
import { createAntigravityPlugin } from "./plugin"
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth"
import type {
  AuthMethod,
  AuthDetails,
  PluginClient,
  PluginContext,
  Provider,
} from "./plugin/types"

const PLUGIN_ID = "opencode-antigravity-auth"
const OAUTH_METHOD_ID = "antigravity"

interface LegacyRequestLoader {
  apiKey: string
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
}

function hasRequestLoader(value: object): value is LegacyRequestLoader {
  return "fetch" in value && typeof value.fetch === "function"
}

function logLegacyMessage(level: string, message: string): void {
  const output = level === "error"
    ? console.error
    : level === "warn"
      ? console.warn
      : console.log
  output(`[${PLUGIN_ID}] ${message}`)
}

function createLegacyClient(ctx: Plugin.Context): PluginClient {
  const client = {
    app: {
      log: async (input: { body: { level: string; message: string } }) => {
        logLegacyMessage(input.body.level, input.body.message)
      },
    },
    auth: {
      // V2 credentials are managed through integrations. The legacy runtime
      // also persists its account pool, so writes from its V1-only paths can
      // safely be ignored by this compatibility client.
      set: async () => undefined,
    },
    session: {
      abort: async (input: { path: { id: string } }) => {
        await ctx.session.interrupt({
          sessionID: input.path.id,
          resume: false,
        })
      },
      messages: async (input: { path: { id: string } }) => {
        const data = await ctx.session.context({ sessionID: input.path.id })
        return { data }
      },
      prompt: async (input: {
        path: { id: string }
        body: { parts: Array<{ type: string; text?: string }> }
      }) => {
        const text = input.body.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n")
        const data = await ctx.session.prompt({
          sessionID: input.path.id,
          text,
        })
        return { data }
      },
    },
    tui: {
      showToast: async (input: {
        body: { title?: string; message: string; variant?: string }
      }) => {
        const title = input.body.title ? `${input.body.title}: ` : ""
        logLegacyMessage(input.body.variant ?? "info", `${title}${input.body.message}`)
      },
    },
  }

  return client as unknown as PluginClient
}

async function resolveLegacyAuth(ctx: Plugin.Context): Promise<AuthDetails> {
  const connection = await ctx.integration.connection.active(ANTIGRAVITY_PROVIDER_ID)
  if (!connection) return { type: "api", key: "" }

  const credential = await ctx.integration.connection.resolve(connection)
  if (!credential) return { type: "api", key: "" }
  if (credential.type === "oauth") {
    return {
      type: "oauth",
      refresh: credential.refresh,
      access: credential.access,
      expires: credential.expires,
    }
  }
  return { type: "api", key: credential.key }
}

function toOAuthCredential(result: AntigravityTokenExchangeResult): Credential.OAuth {
  if (result.type === "failed") {
    throw new Error(result.error)
  }

  return {
    type: "oauth",
    methodID: OAUTH_METHOD_ID as Credential.OAuth["methodID"],
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    metadata: {
      email: result.email,
      projectId: result.projectId,
    },
  }
}

async function authorizeV2(method: AuthMethod) {
  if (!method.authorize) {
    throw new Error("Antigravity OAuth method has no authorization handler")
  }

  const authorization = await method.authorize()
  if (authorization.method === "auto") {
    return {
      url: authorization.url,
      instructions: authorization.instructions,
      mode: "auto" as const,
      callback: authorization.callback().then(toOAuthCredential),
    }
  }

  return {
    url: authorization.url,
    instructions: authorization.instructions,
    mode: "code" as const,
    callback: async (code: string) => toOAuthCredential(await authorization.callback(code)),
  }
}

function eventProperties(event: object): unknown {
  return "data" in event ? event.data : undefined
}

async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const client = createLegacyClient(ctx)
  const legacyContext: PluginContext = {
    client,
    directory: ctx.location.directory,
  }
  const legacy = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)(legacyContext)
  const provider: Provider = { id: ANTIGRAVITY_PROVIDER_ID, models: {} }
  const loader = await legacy.auth.loader(() => resolveLegacyAuth(ctx), provider)
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const controller = new AbortController()

  registrations.push(
    await ctx.provider.transform((editor) => {
      editor.update(ANTIGRAVITY_PROVIDER_ID, (current) => {
        current.activation = "enabled"
        current.settings = {
          ...current.settings,
          apiKey: current.settings?.apiKey ?? "antigravity-oauth",
        }
      })
    }),
  )

  if (hasRequestLoader(loader)) {
    registrations.push(
      await ctx.aisdk.hook(
        "sdk",
        (event) => {
          event.options.apiKey ??= loader.apiKey || "antigravity-oauth"
          event.options.fetch = loader.fetch
        },
        { providerID: ANTIGRAVITY_PROVIDER_ID },
      ),
    )
  }

  const oauthMethod = legacy.auth.methods.find((method) => method.type === "oauth")
  if (oauthMethod) {
    registrations.push(
      await ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: ANTIGRAVITY_PROVIDER_ID,
          method: {
            id: OAUTH_METHOD_ID,
            type: "oauth",
            label: oauthMethod.label,
          },
          authorize: () => authorizeV2(oauthMethod),
          label: (credential) => {
            const email = credential.metadata?.email
            return typeof email === "string" ? email : undefined
          },
        })
      }),
    )
  }

  const eventTask = legacy.event
    ? (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            await legacy.event?.({
              event: {
                type: event.type,
                properties: eventProperties(event),
              },
            })
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error
        }
      })()
    : Promise.resolve()

  return async () => {
    controller.abort()
    await Promise.all(registrations.map((registration) => registration.dispose()))
    await eventTask
  }
}

export const OpenCodeV2Plugin = Plugin.define({
  id: PLUGIN_ID,
  setup,
})
