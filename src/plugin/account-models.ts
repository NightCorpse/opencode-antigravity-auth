import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { ANTIGRAVITY_ARGON_CLI_USER_AGENT, ANTIGRAVITY_ENDPOINT_DAILY } from "../constants";
import { formatRefreshParts } from "./auth";
import { ensureProjectContext } from "./project";
import { getStoragePath, loadAccounts } from "./storage";
import type { AccountMetadataV3 } from "./storage";
import { refreshAccessToken } from "./token";
import type { PluginClient } from "./types";
import { createLogger } from "./logger";
import { resolveModelWithTier } from "./transform/model-resolver";

const log = createLogger("account-models");
export const ACCOUNT_MODELS_TTL_MS = 5 * 60 * 1000;

export interface AccountModelSnapshot {
  generation: string;
  startedAt: number;
  checkedAt?: number;
  /** Undefined means unknown (including failed discovery), never denied. */
  models?: string[];
}

/** Unknown catalogs fail open; only fresh successful discovery can exclude an account. */
export function accountModelAvailability(snapshot: AccountModelSnapshot | undefined, model: string): "available" | "unavailable" | "unknown" {
  if (!snapshot?.models || !snapshot.checkedAt || Date.now() - snapshot.checkedAt > ACCOUNT_MODELS_TTL_MS) return "unknown";
  const id = model.toLowerCase().replace(/^models\//, "").replace(/^antigravity-/, "");
  const models = new Set(snapshot.models.map((entry) => entry.toLowerCase()));
  if (models.has(id)) return id.endsWith("-disabled") ? "unavailable" : "available";
  // Public base IDs may select any advertised reasoning tier. Exact backend IDs
  // are checked again after request lowering, before any generation/warmup.
  if (!/-(minimal|low|medium|high|max)$/.test(id) &&
      [...models].some((entry) => entry.startsWith(`${id}-`) && /-(low|medium|high)$/.test(entry))) return "available";
  const resolved = resolveModelWithTier(model).actualModel.toLowerCase();
  return models.has(resolved) && !resolved.endsWith("-disabled") ? "available" : "unavailable";
}

interface CatalogFile {
  version: 1;
  accounts: Record<string, AccountModelSnapshot>;
}

export function accountModelKey(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function cachePath(): string {
  return join(dirname(getStoragePath()), "antigravity-account-models.json");
}

async function readCatalog(path: string): Promise<CatalogFile> {
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8")) as CatalogFile | null;
    if (value?.version === 1 && value.accounts && typeof value.accounts === "object" && !Array.isArray(value.accounts)) {
      const accounts: Record<string, AccountModelSnapshot> = {};
      for (const [key, snapshot] of Object.entries(value.accounts)) {
        if (!snapshot || typeof snapshot !== "object" || typeof snapshot.generation !== "string" ||
            !Number.isFinite(snapshot.startedAt) ||
            (snapshot.checkedAt !== undefined && !Number.isFinite(snapshot.checkedAt)) ||
            (snapshot.models !== undefined && (!Array.isArray(snapshot.models) || !snapshot.models.every((id) => typeof id === "string")))) continue;
        accounts[key] = snapshot;
      }
      return { version: 1, accounts };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("Unable to read model availability cache");
  }
  return { version: 1, accounts: {} };
}

export async function loadAccountModelSnapshots(): Promise<Record<string, AccountModelSnapshot>> {
  return (await readCatalog(cachePath())).accounts;
}

async function updateCatalog(change: (catalog: CatalogFile) => void): Promise<void> {
  const path = cachePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, {
    realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const catalog = await readCatalog(path);
    change(catalog);
    await fs.writeFile(temporary, JSON.stringify(catalog), { mode: 0o600 });
    await fs.rename(temporary, path);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") log.warn("Unable to clean model availability temporary file");
    });
    await release();
  }
}

const inFlight = new Map<string, Promise<void>>();

async function refreshAccount(account: AccountMetadataV3, client: PluginClient, providerId: string): Promise<void> {
  const key = accountModelKey(account.refreshToken);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = (async () => {
    const generation = randomUUID();
    // Reserve before network I/O. A newer attempt supersedes this generation,
    // even when the older response arrives last. No account file is rewritten.
    await updateCatalog((catalog) => {
      catalog.accounts[key] = { ...catalog.accounts[key], generation, startedAt: Date.now() };
    });
    let models: string[] | undefined;
    try {
      const auth = await refreshAccessToken({
        type: "oauth", refresh: formatRefreshParts(account), access: undefined, expires: undefined,
      }, client, providerId);
      if (!auth?.access) throw new Error("Token refresh failed");
      const project = await ensureProjectContext(auth);
      const response = await fetch(`${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${project.auth.access ?? auth.access}`,
          "Content-Type": "application/json", "User-Agent": ANTIGRAVITY_ARGON_CLI_USER_AGENT,
        },
        body: JSON.stringify({ project: project.effectiveProjectId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`);
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("models" in data) ||
          !data.models || typeof data.models !== "object" || Array.isArray(data.models)) {
        throw new Error("Invalid model catalog");
      }
      models = Object.keys(data.models);
      if (models.length === 0) throw new Error("Empty model catalog");
    } catch {
      log.warn("Account model discovery failed; availability is unknown");
    }
    await updateCatalog((catalog) => {
      if (catalog.accounts[key]?.generation === generation) {
        catalog.accounts[key] = { generation, startedAt: catalog.accounts[key]!.startedAt, checkedAt: Date.now(), models };
      }
    });
  })();
  inFlight.set(key, task);
  try { await task; } finally { inFlight.delete(key); }
}

/** Refresh at host/CLI startup, independently of administrative account writes. */
export async function refreshAccountModelAvailability(
  accounts: AccountMetadataV3[], client: PluginClient, providerId: string,
): Promise<void> {
  // Bounded parallelism; include disabled accounts so enabling one has fresh data.
  const pending = accounts.filter((account) => !account.reauthRequired);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (cursor < pending.length) {
      const account = pending[cursor++];
      if (!account) continue;
      try { await refreshAccount(account, client, providerId); }
      catch { log.warn("Unable to persist account model discovery"); }
    }
  }));
}

export async function refreshStoredAccountModels(client: PluginClient, providerId: string): Promise<void> {
  const storage = await loadAccounts();
  if (storage) await refreshAccountModelAvailability(storage.accounts, client, providerId);
}

export const accountModelsTestHooks = { updateCatalog, readCatalog };
