import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountModelKey, accountModelsTestHooks, loadAccountModelSnapshots, refreshAccountModelAvailability } from "./account-models";
import { refreshAccessToken } from "./token";
import { ensureProjectContext } from "./project";
import type { PluginClient } from "./types";

vi.mock("./token", () => ({ refreshAccessToken: vi.fn() }));
vi.mock("./project", () => ({ ensureProjectContext: vi.fn() }));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "account-models-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", directory);
  vi.mocked(refreshAccessToken).mockResolvedValue({ type: "oauth", refresh: "secret", access: "access", expires: Date.now() + 10000 });
  vi.mocked(ensureProjectContext).mockResolvedValue({ auth: { type: "oauth", refresh: "secret", access: "access" }, effectiveProjectId: "project" });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const account = { refreshToken: "secret", email: "example@example.test", addedAt: 1, lastUsed: 1 };
const client = {} as PluginClient;

describe("per-account model discovery", () => {
  it("persists catalog independently without rewriting account administration or credentials", async () => {
    const path = join(directory, "antigravity-accounts.json");
    const original = JSON.stringify({ version: 4, accounts: [{ ...account, enabled: false }] });
    await writeFile(path, original);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ models: { "gemini-4-argon-disabled": {}, "claude-sonnet-4-6": {} } })));
    await refreshAccountModelAvailability([account], client, "google");
    expect(await readFile(path, "utf8")).toBe(original);
    const catalog = await loadAccountModelSnapshots();
    expect(catalog[accountModelKey("secret")]?.models).toEqual(["gemini-4-argon-disabled", "claude-sonnet-4-6"]);
    const contents = await readFile(join(directory, "antigravity-account-models.json"), "utf8");
    expect(contents).not.toContain("secret");
    expect(contents).not.toContain(account.email);
  });

  it("refreshes on each startup and replaces old entitlements on plan changes", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ models: { "claude-sonnet-4-6": {} } }))
      .mockResolvedValueOnce(Response.json({ models: { "claude-sonnet-5-5-high": {} } }));
    vi.stubGlobal("fetch", fetch);
    await refreshAccountModelAvailability([account], client, "google");
    await refreshAccountModelAvailability([account], client, "google");
    expect((await loadAccountModelSnapshots())[accountModelKey("secret")]?.models).toEqual(["claude-sonnet-5-5-high"]);
  });

  it("marks failed discovery unknown instead of keeping stale denials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ models: { "gemini-4-argon-disabled": {} } }))
      .mockRejectedValueOnce(new Error("offline")));
    await refreshAccountModelAvailability([account], client, "google");
    await refreshAccountModelAvailability([account], client, "google");
    expect((await loadAccountModelSnapshots())[accountModelKey("secret")]?.models).toBeUndefined();
  });

  it("merges parallel account updates and rejects an older in-flight generation", async () => {
    const { updateCatalog } = accountModelsTestHooks;
    await Promise.all(["a", "b"].map((key) => updateCatalog((catalog) => {
      catalog.accounts[key] = { generation: "new", startedAt: 2, models: [key] };
    })));
    await updateCatalog((catalog) => {
      if (catalog.accounts.a?.generation === "old") catalog.accounts.a.models = ["stale"];
    });
    const catalog = await loadAccountModelSnapshots();
    expect(catalog.a?.models).toEqual(["a"]);
    expect(catalog.b?.models).toEqual(["b"]);
  });
});
