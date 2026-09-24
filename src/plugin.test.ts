import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginClient } from "./plugin/types";
import { AccountManager } from "./plugin/accounts";
import { DEFAULT_CONFIG } from "./plugin/config";

vi.mock("@opencode-ai/plugin", () => ({
  tool: Object.assign(
    (definition: unknown) => definition,
    {
      schema: {
        string: () => ({ describe: () => ({}) }),
        boolean: () => ({ optional: () => ({ default: () => ({ describe: () => ({}) }) }) }),
        array: () => ({ optional: () => ({ describe: () => ({}) }) }),
      },
    },
  ),
}));

// Mock storage so disk reads/writes are isolated from real config files.
// Per-test we override `loadAccounts` to simulate "OAuth accounts on disk".
vi.mock("./plugin/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plugin/storage")>();
  return {
    ...original,
    loadAccounts: vi.fn(async () => null),
    saveAccounts: vi.fn(async () => undefined),
    saveAccountsReplace: vi.fn(async () => undefined),
    removeAccountFromStorage: vi.fn(async () => undefined),
    clearAccounts: vi.fn(async () => undefined),
  };
});

// Keep tests independent from the user's ~/.config/opencode/antigravity.json
// while still allowing individual tests to point at their own config directory.
process.env.OPENCODE_CONFIG_DIR = join(tmpdir(), `opencode-antigravity-test-${process.pid}`);

const { createAntigravityPlugin, loopEscapeTestHooks, __testExports } = await import("./plugin");
const storageModule = await import("./plugin/storage");
const { resetPublicGeminiApiModelCatalogForTests } = await import("./plugin/model-catalog");
const { resetAgySdkCredentialStateForTests } = await import("./plugin/api-key");

const client = {
  tui: { showToast: vi.fn(async () => undefined) },
  app: { log: vi.fn(async () => undefined) },
} as unknown as PluginClient;

// provider.models() discovery (exercised by some tests below) populates the
// module-level live model catalog as a side effect. Reset it after every test
// so one test's (possibly sparse, mock-driven) discovery fetch can't leak
// into another test's agy-sdk routing assertions.
afterEach(() => {
  resetPublicGeminiApiModelCatalogForTests();
});



describe("createAntigravityPlugin provider models", () => {
  it("returns runtime-shaped discovered models with static fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com/v1beta/models")) {
        return new Response(JSON.stringify({
          models: [
            {
              name: "models/gemini-driver",
              displayName: "Gemini Driver",
              inputTokenLimit: 123,
              outputTokenLimit: 45,
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }));
      }
      return new Response("1.2.3");
    }));

    try {
      const plugin = await createAntigravityPlugin("google")({
        client,
        directory: process.cwd(),
      });

      const models = await plugin.provider?.models?.(
        {
          id: "google",
          api: "https://generativelanguage.googleapis.com/v1beta",
          npm: "@ai-sdk/google",
          models: {},
        },
        { auth: { type: "api", key: "secret" } },
      );

      expect(models?.["gemini-driver"]).toMatchObject({
        id: "gemini-driver",
        providerID: "google",
        api: {
          id: "gemini-driver",
          url: "https://generativelanguage.googleapis.com/v1beta",
          npm: "@ai-sdk/google",
        },
        limit: { context: 123, output: 45 },
        status: "active",
      });
      expect(models?.["gemini-driver"]?.capabilities).toMatchObject({
        toolcall: true,
        input: { text: true, image: true, pdf: true },
        output: { text: true },
      });
      expect(models?.["antigravity-gemini-3-pro"]).toMatchObject({
        id: "antigravity-gemini-3-pro",
        providerID: "google",
        api: { id: "antigravity-gemini-3-pro" },
      });
      expect(models?.["antigravity-gemini-3.6-flash"]?.capabilities).toMatchObject({
        temperature: false,
        reasoning: true,
      });
      expect(models?.["antigravity-gemini-3.7-flash"]?.capabilities).toMatchObject({
        reasoning: true,
      });
      expect(models?.["antigravity-gemini-3.8-flash"]?.capabilities).toMatchObject({
        temperature: false,
        reasoning: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pulls dynamically discovered models from the Antigravity registry and caches them", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({
          models: {
            "gemini-3.7-flash": {
              displayName: "Gemini 3.7 Flash",
              modelName: "gemini-3.7-flash",
            },
            "gemini-3.9-flash": {
              displayName: "Gemini 3.9 Flash (Registry)",
              modelName: "gemini-3.9-flash",
            },
          },
        }));
      }
      return new Response("1.2.3");
    }));

    try {
      const plugin = await createAntigravityPlugin("google")({
        client,
        directory: process.cwd(),
      });

      const models = await plugin.provider?.models?.(
        {
          id: "google",
          api: "https://generativelanguage.googleapis.com/v1beta",
          npm: "@ai-sdk/google",
          models: {},
        },
        {
          auth: {
            type: "oauth",
            access: "valid-token",
            refresh: "refresh-token|project=proj-1",
            expires: Date.now() + 3600_000,
          },
        },
      );

      expect(models?.["antigravity-gemini-3.7-flash"]).toBeDefined();
      expect(models?.["antigravity-gemini-3.9-flash"]).toMatchObject({
        id: "antigravity-gemini-3.9-flash",
        name: "Gemini 3.9 Flash (Registry) (Antigravity)",
        capabilities: {
          reasoning: true,
          toolcall: true,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not expose API-key auth secret as loader apiKey", async () => {
    const plugin = await createAntigravityPlugin("google")({
      client,
      directory: process.cwd(),
    });

    const loader = await plugin.auth.loader(
      async () => ({ type: "api", key: "secret" }),
      {},
    );

    expect(loader).toMatchObject({ apiKey: "" });
  });
});

describe("createAntigravityPlugin auth.loader disk OAuth promotion", () => {
  beforeEach(() => {
    vi.mocked(storageModule.loadAccounts).mockReset();
    vi.mocked(storageModule.saveAccountsReplace).mockReset();
    vi.mocked(storageModule.removeAccountFromStorage).mockReset();
  });

  it("routes through the OAuth path when OpenCode reports API-key auth but OAuth accounts exist on disk", async () => {
    // Simulate ~/.config/opencode/antigravity-accounts.json holding a usable OAuth account.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "test@example.com",
          refreshToken: "fake-refresh-token",
          projectId: "fake-project",
          addedAt: 0,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    // Mock global fetch:
    //   - version check / model discovery → safe defaults
    //   - oauth2.googleapis.com (token refresh) → invalid_grant so the OAuth
    //     loop exits fast (account removed, no infinite retry)
    //   - anything else → 500 (won't be reached on the happy assertion path)
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "test-stop" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ models: [] }));
      }
      return new Response("1.2.3");
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const plugin = await createAntigravityPlugin("google")({
        client,
        directory: process.cwd(),
      });

      const loader = await plugin.auth.loader(
        async () => ({ type: "api", key: "secret" }),
        {
          id: "google",
          api: "https://generativelanguage.googleapis.com/v1beta",
          npm: "@ai-sdk/google",
          models: {},
        },
      );

      // Both branches return apiKey: "" — this only confirms loader was constructed.
      expect(loader).toMatchObject({ apiKey: "" });
      expect(loader).toHaveProperty("fetch");

      // Before the fix: this URL took the API-key-only branch and returned a
      // synthetic 404 with the "API-key path forwarded" guidance (no fetch made).
      // After the fix: disk OAuth is promoted, the OAuth path is taken, and the
      // first thing it does is refresh the access token against oauth2.googleapis.com.
      let responseBody = "";
      try {
        const response = await (loader as { fetch: typeof fetch }).fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro:generateContent",
          { method: "POST", body: "{}" },
        );
        responseBody = await response.text();
      } catch {
        // OAuth path may throw after the invalid_grant exhausts the only account.
        // That's the expected failure mode for this test setup.
      }

      // Hard proof we took the OAuth path: a token-refresh request was issued.
      const tokenRefreshCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("oauth2.googleapis.com"),
      );
      expect(tokenRefreshCalls.length).toBeGreaterThan(0);

      // Negative assertion: we did NOT short-circuit through the API-key-only
      // synthetic 404. That synthetic message is unique to the api-key path.
      expect(responseBody).not.toContain("API-key path forwarded the request");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps API-key-only behavior when disk has no OAuth accounts", async () => {
    // No accounts on disk — must NOT promote, must short-circuit Antigravity-only
    // models with the synthetic 404 guidance.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue(null);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ models: [] }));
      }
      return new Response("1.2.3");
    }));

    try {
      const plugin = await createAntigravityPlugin("google")({
        client,
        directory: process.cwd(),
      });

      const loader = await plugin.auth.loader(
        async () => ({ type: "api", key: "secret" }),
        {
          id: "google",
          api: "https://generativelanguage.googleapis.com/v1beta",
          npm: "@ai-sdk/google",
          models: {},
        },
      );

      const response = await (loader as { fetch: typeof fetch }).fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-sonnet-4-6:generateContent",
        { method: "POST", body: "{}" },
      );
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).toContain("API-key path forwarded the request");
    } finally {
      vi.unstubAllGlobals();
    }
  });



  it("does NOT call client.auth.set when promoted-from-disk OAuth hits invalid_grant", async () => {
    // Disk holds an OAuth account; OpenCode hands us api-key auth. After my fix,
    // when the (only) promoted OAuth account fails with invalid_grant, the plugin
    // must NOT call client.auth.set — OpenCode is in api-key mode for this provider
    // and clearing OAuth credentials would corrupt that state.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "test@example.com",
          refreshToken: "fake-refresh-token",
          projectId: "fake-project",
          addedAt: 0,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      // Force token refresh to fail with invalid_grant so the cleanup path runs.
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "test-stop" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ models: [] }));
      }
      return new Response("1.2.3");
    });
    vi.stubGlobal("fetch", fetchMock);

    // Local client with auth.set as a spy so we can assert it was NOT called.
    const authSetSpy = vi.fn(async () => undefined);
    const localClient = {
      tui: { showToast: vi.fn(async () => undefined) },
      app: { log: vi.fn(async () => undefined) },
      auth: { set: authSetSpy },
    } as unknown as PluginClient;

    try {
      const plugin = await createAntigravityPlugin("google")({
        client: localClient,
        directory: process.cwd(),
      });

      const loader = await plugin.auth.loader(
        async () => ({ type: "api", key: "secret" }),
        {
          id: "google",
          api: "https://generativelanguage.googleapis.com/v1beta",
          npm: "@ai-sdk/google",
          models: {},
        },
      );

      // Drive the OAuth fetch handler through the invalid_grant cleanup path.
      // It will throw "All Antigravity accounts have invalid refresh tokens...".
      try {
        await (loader as { fetch: typeof fetch }).fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro:generateContent",
          { method: "POST", body: "{}" },
        );
      } catch {
        // Expected.
      }

      // First, prove the invalid_grant cleanup path was actually exercised — the
      // OAuth fetch handler must have attempted a token refresh against Google.
      const tokenRefreshCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("oauth2.googleapis.com"),
      );
      expect(tokenRefreshCalls.length).toBeGreaterThan(0);

      // CRITICAL: client.auth.set must NOT have been called — doing so would
      // wipe OpenCode's api-key auth for the google provider.
      expect(authSetSpy).not.toHaveBeenCalled();
      expect(storageModule.removeAccountFromStorage).toHaveBeenCalledWith("fake-refresh-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// 404-fallback block: when the Antigravity backend returns NOT_FOUND for a
// model that the public Gemini API can serve, the plugin must route to the
// api-key path (agy-sdk) instead of returning the raw 404 to the caller.
// ---------------------------------------------------------------------------
import { formatRefreshParts } from "./plugin/auth";

describe("createAntigravityPlugin auth.loader 404→agy-sdk fallback", () => {
  // Isolated XDG_CONFIG_HOME so the real user config file is never loaded.
  // Without a config file, schema defaults apply: agy_sdk.enabled=true,
  // agy_sdk.api_key_fallback=true.
  let tmpConfigHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Create a fresh, empty temp dir for each test.
    tmpConfigHome = join(tmpdir(), `opencode-antigravity-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmpConfigHome, { recursive: true });

    // Save env vars we may touch.
    savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    savedEnv.OPENCODE_ANTIGRAVITY_API_KEYS = process.env.OPENCODE_ANTIGRAVITY_API_KEYS;
    savedEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    savedEnv.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

    // Point XDG_CONFIG_HOME at the empty temp dir so no real config is read.
    process.env.XDG_CONFIG_HOME = tmpConfigHome;

    // Reset the storage mock state.
    vi.mocked(storageModule.loadAccounts).mockReset();
    vi.mocked(storageModule.saveAccounts).mockReset();
  });

  afterEach(() => {
    // Restore saved env vars (undefined means delete).
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    vi.unstubAllGlobals();
  });

  /**
   * Build a valid OAuth auth string that makes ensureProjectContext() return
   * immediately (no network call) by embedding a managedProjectId.
   */
  function buildOAuthGetAuth() {
    const refresh = formatRefreshParts({
      refreshToken: "r",
      projectId: "p",
      managedProjectId: "managed-proj",
    });
    const auth = {
      type: "oauth" as const,
      refresh,
      access: "valid-access-token",
      expires: Date.now() + 3_600_000,
    };
    return async () => auth;
  }

  /**
   * Build a fetch mock that:
   * - Returns 404 for ALL Antigravity backend endpoints.
   * - Returns 200 with SSE body for `generativelanguage.googleapis.com` calls
   *   that carry an `x-goog-api-key` header (the agy-sdk fallback path).
   * - Returns `{models:[]}` for model-list GETs to generativelanguage.googleapis.com.
   * - Returns a token JSON for oauth2.googleapis.com (safety; may not be hit).
   * - Returns a benign 200 for anything else.
   */
  function buildFetchMock({
    hasFallbackKey,
    backendStatus = 404,
    backendMessage,
  }: {
    hasFallbackKey: boolean;
    backendStatus?: number;
    backendMessage?: string;
  }) {
    const SSE_BODY =
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"},"finishReason":"STOP","index":0}]}\n\n';

    return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;

      // Antigravity backend endpoints → return the configured status (default 404).
      if (url.includes("daily-cloudcode-pa")) {
        const backendBody = backendStatus === 403
          ? { error: { code: 403, message: backendMessage ?? "Permission denied.", status: "PERMISSION_DENIED" } }
          : { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } };
        return new Response(JSON.stringify(backendBody), {
          status: backendStatus,
          headers: { "content-type": "application/json" },
        });
      }

      // Gemini public API.
      if (url.includes("generativelanguage.googleapis.com")) {
        // Model-list GET (no :streamGenerateContent / :generateContent action).
        if (url.includes("/models") && !url.includes(":")) {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        // Check for the api-key header — this is what the agy-sdk path injects.
        let hasApiKey = false;
        const headersArg = init?.headers ?? (input instanceof Request ? input.headers : undefined);
        if (headersArg) {
          if (headersArg instanceof Headers) {
            hasApiKey = headersArg.has("x-goog-api-key");
          } else if (typeof headersArg === "object") {
            hasApiKey = "x-goog-api-key" in (headersArg as Record<string, string>);
          }
        }

        if (hasApiKey && hasFallbackKey) {
          // This is the agy-sdk fallback call — return 200.
          return new Response(SSE_BODY, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        // Fallback key not configured or not an api-key call — 200 generic.
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Token refresh endpoint (safety net; may not be reached since access token is pre-supplied).
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "valid-access-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Version check / anything else → benign 200.
      return new Response("1.2.3");
    });
  }

  it("falls back to agy-sdk when Antigravity backend returns 404 for a routable Gemini model", async () => {
    // Provide a fallback key so getAgySdkCredentials() returns a credential.
    process.env.OPENCODE_ANTIGRAVITY_API_KEYS = "test-fallback-key";

    // Disk holds one usable OAuth account.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "t@example.com",
          refreshToken: "r",
          projectId: "p",
          addedAt: 0,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    const fetchMock = buildFetchMock({ hasFallbackKey: true });
    vi.stubGlobal("fetch", fetchMock);

    const plugin = await createAntigravityPlugin("google")({
      client,
      directory: process.cwd(),
    });

    const getAuth = buildOAuthGetAuth();
    const loader = await plugin.auth.loader(getAuth, {
      id: "google",
      api: "https://generativelanguage.googleapis.com/v1beta",
      npm: "@ai-sdk/google",
      models: {},
    });

    // antigravity-gemini-3.5-flash is routable (strips to gemini-3.5-flash which is
    // a public API model), so isAgySdkSupportedRequest returns true.
    const requestUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:streamGenerateContent?alt=sse";

    const res = await (loader as { fetch: typeof fetch }).fetch(requestUrl, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });

    // The fallback must succeed and return 200.
    expect(res.status).toBe(200);

    // Verify that a request to generativelanguage.googleapis.com with an
    // x-goog-api-key header was made (that's the agy-sdk fallback path).
    const apiKeyFallbackCalls = fetchMock.mock.calls.filter(([inputArg, initArg]) => {
      const u = typeof inputArg === "string" ? inputArg : (inputArg as Request).url;
      if (!u.includes("generativelanguage.googleapis.com")) return false;
      const hdrs = (initArg as RequestInit | undefined)?.headers;
      if (!hdrs) return false;
      if (hdrs instanceof Headers) return hdrs.has("x-goog-api-key");
      return "x-goog-api-key" in (hdrs as Record<string, string>);
    });
    expect(apiKeyFallbackCalls.length).toBeGreaterThan(0);
  });

  it("returns the 404 Response without throwing when no api-key fallback is configured", async () => {
    // Ensure NO credentials are available so tryAgySdkFallbackForRequest returns null.
    delete process.env.OPENCODE_ANTIGRAVITY_API_KEYS;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    // Disk holds one usable OAuth account.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "t@example.com",
          refreshToken: "r",
          projectId: "p",
          addedAt: 0,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    const fetchMock = buildFetchMock({ hasFallbackKey: false });
    vi.stubGlobal("fetch", fetchMock);

    const plugin = await createAntigravityPlugin("google")({
      client,
      directory: process.cwd(),
    });

    const getAuth = buildOAuthGetAuth();
    const loader = await plugin.auth.loader(getAuth, {
      id: "google",
      api: "https://generativelanguage.googleapis.com/v1beta",
      npm: "@ai-sdk/google",
      models: {},
    });

    const requestUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:streamGenerateContent?alt=sse";

    // Must RESOLVE (not throw) — status 404 because no api-key fallback is available.
    const res = await (loader as { fetch: typeof fetch }).fetch(requestUrl, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });

    expect(res.status).toBe(404);
  });

  it("does NOT fall back to agy-sdk on a generic 403 from the Antigravity backend (stays on Antigravity)", async () => {
    // A generic 403 is a permission/credential signal (expired token, IP/ACL/
    // verification denial), NOT "model unavailable". Even with a fallback key
    // configured, the plugin must surface the 403 rather than silently routing
    // to the api-key path — doing so would mask a real account-access problem
    // and shift the user onto their API key unknowingly. Only 404 NOT_FOUND and
    // the specific "permission denied on resource project" 403 (see the test
    // below) trigger the agy-sdk fallback.
    process.env.OPENCODE_ANTIGRAVITY_API_KEYS = "test-fallback-key";

    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        { email: "t@example.com", refreshToken: "r", projectId: "p", addedAt: 0, lastUsed: 0, enabled: true },
      ],
      activeIndex: 0,
    });

    const fetchMock = buildFetchMock({ hasFallbackKey: true, backendStatus: 403 });
    vi.stubGlobal("fetch", fetchMock);

    const plugin = await createAntigravityPlugin("google")({
      client,
      directory: process.cwd(),
    });

    const getAuth = buildOAuthGetAuth();
    const loader = await plugin.auth.loader(getAuth, {
      id: "google",
      api: "https://generativelanguage.googleapis.com/v1beta",
      npm: "@ai-sdk/google",
      models: {},
    });

    const requestUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:streamGenerateContent?alt=sse";

    const res = await (loader as { fetch: typeof fetch }).fetch(requestUrl, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });

    // The backend 403 must be surfaced — NOT replaced by the fallback's 200.
    expect(res.status).toBe(403);

    // And the agy-sdk fallback must NOT have been invoked (no x-goog-api-key request).
    const apiKeyFallbackCalls = fetchMock.mock.calls.filter(([inputArg, initArg]) => {
      const u = typeof inputArg === "string" ? inputArg : (inputArg as Request).url;
      if (!u.includes("generativelanguage.googleapis.com")) return false;
      const hdrs = (initArg as RequestInit | undefined)?.headers;
      if (!hdrs) return false;
      if (hdrs instanceof Headers) return hdrs.has("x-goog-api-key");
      return "x-goog-api-key" in (hdrs as Record<string, string>);
    });
    expect(apiKeyFallbackCalls.length).toBe(0);
  });

  it("falls back to agy-sdk on a 403 'permission denied on resource project' from the Antigravity backend", async () => {
    // Some 403s are a project-scoped entitlement gate on the resolved backend
    // model id (e.g. a staged Google rollout of a new variant like the Gemini
    // 3.5 Flash "agent"/high-tier backend) rather than a credential problem.
    // Retrying other Antigravity endpoints can't help, but the public Gemini
    // API can still serve the model — so this specific 403 should fall back
    // just like a 404 does.
    process.env.OPENCODE_ANTIGRAVITY_API_KEYS = "test-fallback-key";

    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        { email: "t@example.com", refreshToken: "r", projectId: "p", addedAt: 0, lastUsed: 0, enabled: true },
      ],
      activeIndex: 0,
    });

    const fetchMock = buildFetchMock({
      hasFallbackKey: true,
      backendStatus: 403,
      backendMessage: "Permission denied on resource project ata-watch-481914-b3.",
    });
    vi.stubGlobal("fetch", fetchMock);

    const plugin = await createAntigravityPlugin("google")({
      client,
      directory: process.cwd(),
    });

    const getAuth = buildOAuthGetAuth();
    const loader = await plugin.auth.loader(getAuth, {
      id: "google",
      api: "https://generativelanguage.googleapis.com/v1beta",
      npm: "@ai-sdk/google",
      models: {},
    });

    const requestUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:streamGenerateContent?alt=sse";

    const res = await (loader as { fetch: typeof fetch }).fetch(requestUrl, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });

    // The fallback must succeed and return 200, not the raw 403.
    expect(res.status).toBe(200);

    // Verify the agy-sdk fallback path (x-goog-api-key header) was used.
    const apiKeyFallbackCalls = fetchMock.mock.calls.filter(([inputArg, initArg]) => {
      const u = typeof inputArg === "string" ? inputArg : (inputArg as Request).url;
      if (!u.includes("generativelanguage.googleapis.com")) return false;
      const hdrs = (initArg as RequestInit | undefined)?.headers;
      if (!hdrs) return false;
      if (hdrs instanceof Headers) return hdrs.has("x-goog-api-key");
      return "x-goog-api-key" in (hdrs as Record<string, string>);
    });
    expect(apiKeyFallbackCalls.length).toBeGreaterThan(0);
  });
});
