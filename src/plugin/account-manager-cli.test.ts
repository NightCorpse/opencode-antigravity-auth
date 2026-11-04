import { describe, it, expect, vi } from "vitest";
import { createDummyClient, displayAccountsQuota, persistAccountPoolHelper } from "./account-manager-cli";
import { checkAccountsQuota } from "./quota";
import type { AccountStorageV4 } from "./storage";
import * as storage from "./storage";

vi.mock("./storage", () => ({
  loadAccounts: vi.fn(),
  saveAccounts: vi.fn(),
  removeAccountFromStorage: vi.fn(),
  clearAccounts: vi.fn(),
}));

vi.mock("./quota", () => ({ checkAccountsQuota: vi.fn() }));

describe("account-manager-cli", () => {
  it("renders all official windows without replacing the rotation cache", async () => {
    const pool: AccountStorageV4 = {
      version: 4, activeIndex: 0, activeIndexByFamily: {},
      accounts: [{ refreshToken: "test", addedAt: 1, lastUsed: 1,
        cachedQuota: { "gemini-flash": { remainingFraction: 0.4, modelCount: 1 } },
        cachedQuotaUpdatedAt: 123 }],
    };
    vi.mocked(checkAccountsQuota).mockResolvedValueOnce([{
      index: 0, status: "ok", quota: { groups: {}, modelCount: 0, description: "Verbose plan explanation", usageGroups: [{
        displayName: "Gemini Models", description: "Models within this group: Flash and Pro", buckets: [
          { bucketId: "weekly", displayName: "Weekly Limit Remaining", description: "Verbose reset explanation", window: "weekly", remainingFraction: 0.9864 },
          { bucketId: "5h", displayName: "Five Hour", window: "5h", remainingFraction: 1 },
        ],
      }] },
    }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const saves = vi.mocked(storage.saveAccounts).mock.calls.length;
    try {
      await displayAccountsQuota(pool, createDummyClient(), "google");
      const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(output).toContain("Gemini Flash and Pro");
      expect(output).toContain("[weekly]");
      expect(output).toContain("[5h]");
      expect(output.indexOf("[5h]")).toBeLessThan(output.indexOf("[weekly]"));
      expect(output).toContain("98.64%");
      expect(output).not.toContain("Verbose");
      expect(output).not.toContain("Models within this group");
      expect(output).not.toContain("Weekly Limit Remaining");
      expect(pool.accounts[0]?.cachedQuotaUpdatedAt).toBe(123);
      expect(storage.saveAccounts).toHaveBeenCalledTimes(saves);
    } finally {
      log.mockRestore();
    }
  });
  it("creates a dummy client for CLI operations", () => {
    const client = createDummyClient();
    expect(client).toBeDefined();
    expect(typeof client.app.log).toBe("function");
    expect(typeof client.auth.set).toBe("function");
  });

  it("persists accounts to storage via persistAccountPoolHelper", async () => {
    vi.mocked(storage.loadAccounts).mockResolvedValueOnce(null);
    vi.mocked(storage.saveAccounts).mockResolvedValueOnce();

    await persistAccountPoolHelper([
      {
        type: "success",
        email: "test@example.com",
        access: "acc",
        refresh: "ref1|proj1",
        expires: Date.now() + 3600000,
        projectId: "proj1",
      },
    ]);

    expect(storage.saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 4,
        accounts: [
          expect.objectContaining({
            email: "test@example.com",
            refreshToken: "ref1",
            projectId: "proj1",
          }),
        ],
      }),
    );
  });
});
