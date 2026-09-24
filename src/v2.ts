import { Credential, Model, Plugin, Provider } from "@opencode/plugin"

import { ANTIGRAVITY_PROVIDER_ID } from "./constants"
import { createAntigravityPlugin } from "./plugin"
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth"
import { OPENCODE_MODEL_DEFINITIONS } from "./plugin/config/models"
import type {
  AuthMethod,
  AuthDetails,
  PluginClient,
  PluginContext,
  Provider as LegacyProvider,
  ProviderModel,
} from "./plugin/types"

const PLUGIN_ID = "opencode-antigravity-auth"
const OAUTH_METHOD_ID = "antigravity"
const PUBLIC_MODEL_IDS = new Set(
  Object.keys(OPENCODE_MODEL_DEFINITIONS).filter((id) => id.startsWith("antigravity-")),
)
function isUnavailableModel(id: string): boolean {
  return id === "antigravity-gemini-3-pro"
    || id.startsWith("antigravity-gemini-3.5-flash")
}

function isPublicModel(id: string): boolean {
  return PUBLIC_MODEL_IDS.has(id) && !isUnavailableModel(id)
}

interface LegacyRequestLoader {
  apiKey: string
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
}

const INTERCEPT_URL_PREFIX = "data:application/octet-stream,opencode-antigravity-"

interface LegacyTool {
  description: string
  execute(
    input: Record<string, unknown>,
    context: {
      sessionID: string
      messageID: string
      agent: string
      abort: AbortSignal
    },
  ): Promise<string>
}

function hasRequestLoader(value: object): value is LegacyRequestLoader {
  return "fetch" in value && typeof value.fetch === "function"
}

function isLegacyTool(value: unknown): value is LegacyTool {
  return typeof value === "object"
    && value !== null
    && "description" in value
    && typeof value.description === "string"
    && "execute" in value
    && typeof value.execute === "function"
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

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string")
  }
  if (!value || typeof value !== "object") return []
  return Object.entries(value)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name)
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function modelVariants(value: unknown): Model.Variant[] {
  if (!value) return []
  const entries = Array.isArray(value)
    ? value
        .filter((variant): variant is Record<string, unknown> => !!variant && typeof variant === "object")
        .map((variant) => [variant.id, variant.settings ?? variant.options ?? {}] as const)
    : typeof value === "object"
      ? Object.entries(value)
      : []

  return entries.flatMap(([id, settings]) => {
    if (typeof id !== "string" || !id) return []
    const variantSettings = settings && typeof settings === "object"
      ? settings as Record<string, unknown>
      : {}
    const thinkingLevel = variantSettings.thinkingLevel
    const thinkingConfig = variantSettings.thinkingConfig
    const body = typeof thinkingLevel === "string"
      ? {
          generationConfig: {
            thinkingConfig: { thinkingLevel },
          },
        }
      : thinkingConfig && typeof thinkingConfig === "object"
        ? {
            generationConfig: {
              thinkingConfig,
            },
          }
        : undefined
    return [{
      id: Model.VariantID.make(id),
      settings: variantSettings,
      ...(body ? { body } : {}),
    }]
  })
}

function modelCost(value: unknown): Model.Cost[] {
  if (!value || typeof value !== "object") return []
  const cost = value as Record<string, unknown>
  const cache = cost.cache && typeof cost.cache === "object"
    ? cost.cache as Record<string, unknown>
    : {}
  return [{
    input: numberValue(cost.input, 0) as Model.Cost["input"],
    output: numberValue(cost.output, 0) as Model.Cost["output"],
    cache: {
      read: numberValue(cache.read, 0) as Model.Cost["cache"]["read"],
      write: numberValue(cache.write, 0) as Model.Cost["cache"]["write"],
    },
  }]
}

function toV2Model(id: string, model: ProviderModel): Model.Info {
  const providerID = Provider.ID.make(ANTIGRAVITY_PROVIDER_ID)
  const modelID = Model.ID.make(id)
  const base = Model.Info.default(providerID, modelID)
  const capabilities = model.capabilities && typeof model.capabilities === "object"
    ? model.capabilities as Record<string, unknown>
    : {}
  const limit = model.limit && typeof model.limit === "object"
    ? model.limit as Record<string, unknown>
    : {}
  const released = typeof model.release_date === "string"
    ? Date.parse(model.release_date)
    : 0
  const status = model.status === "alpha"
    || model.status === "beta"
    || model.status === "deprecated"
    || model.status === "active"
    ? model.status
    : "active"

  return {
    ...base,
    name: typeof model.name === "string" ? model.name : id,
    capabilities: {
      tools: capabilities.tools === true || capabilities.toolcall !== false,
      input: stringArray(capabilities.input),
      output: stringArray(capabilities.output),
    },
    variants: modelVariants(model.variants),
    time: { released: Number.isFinite(released) ? released : 0 },
    cost: modelCost(model.cost),
    status,
    enabled: status !== "deprecated",
    limit: {
      context: numberValue(limit.context, base.limit.context),
      ...(typeof limit.input === "number" ? { input: limit.input } : {}),
      output: numberValue(limit.output, base.limit.output),
    },
    ...(model.options && typeof model.options === "object"
      ? { settings: model.options as Record<string, unknown> }
      : {}),
    ...(model.headers && typeof model.headers === "object"
      ? { headers: model.headers as Record<string, string> }
      : {}),
  }
}

async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const client = createLegacyClient(ctx)
  const legacyContext: PluginContext = {
    client,
    directory: ctx.location.directory,
  }
  const legacy = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)(legacyContext)
  const provider: LegacyProvider = { id: ANTIGRAVITY_PROVIDER_ID, models: {} }
  const loader = await legacy.auth.loader(() => resolveLegacyAuth(ctx), provider)
  const discoveredModels = legacy.provider?.models
    ? await legacy.provider.models(provider, { auth: await resolveLegacyAuth(ctx) })
    : {}
  const v2Models = Object.entries(discoveredModels)
    .filter(([id]) => isPublicModel(id))
    .map(([id, model]) => toV2Model(id, model))
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
      const existing = editor.get(ANTIGRAVITY_PROVIDER_ID)
      if (existing && v2Models.length > 0) {
        const models = new Map(existing.models)
        for (const id of models.keys()) {
          if (isUnavailableModel(id)) models.delete(id)
        }
        for (const model of v2Models) models.set(model.id, model)
        editor.models.set(ANTIGRAVITY_PROVIDER_ID, [...models.values()])
      }
    }),
    await ctx.model.transform((editor) => {
      for (const model of editor.list(ANTIGRAVITY_PROVIDER_ID)) {
        const modelID = String(model.id)
        if (isUnavailableModel(modelID)) {
          editor.remove(ANTIGRAVITY_PROVIDER_ID, modelID)
        }
      }
    }),
  )

  if (hasRequestLoader(loader)) {
    const responses = new Map<string, Response>()
    registrations.push(
      await ctx.session.hook(
        "http.request",
        async (event) => {
          const id = crypto.randomUUID()
          const response = await loader.fetch(event.request)
          responses.set(id, response)
          event.request = new Request(`${INTERCEPT_URL_PREFIX}${id}`)
        },
        { providerID: ANTIGRAVITY_PROVIDER_ID },
      ),
      await ctx.session.hook(
        "http.response",
        (event) => {
          if (!event.request.url.startsWith(INTERCEPT_URL_PREFIX)) return
          const id = event.request.url.slice(INTERCEPT_URL_PREFIX.length)
          const response = responses.get(id)
          if (!response) {
            throw new Error("Missing intercepted Antigravity response")
          }
          responses.delete(id)
          event.response = response
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

  const googleSearch = legacy.tool?.google_search
  if (isLegacyTool(googleSearch)) {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "google_search",
          description: googleSearch.description,
          input: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query or question to answer using web search",
              },
              urls: {
                type: "array",
                items: { type: "string" },
                description: "Specific URLs to fetch and analyze",
              },
              thinking: {
                type: "boolean",
                description: "Enable deep thinking for a more thorough analysis",
                default: true,
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
          async execute(input, tool) {
            const content = await googleSearch.execute(
              input as Record<string, unknown>,
              {
                sessionID: tool.sessionID,
                messageID: tool.messageID,
                agent: tool.agent,
                abort: new AbortController().signal,
              },
            )
            return { content }
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
