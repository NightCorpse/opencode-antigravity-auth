import { describe, expect, it, vi } from "vitest";
import { AccountManager } from "./accounts";
import { accountModelAvailability, accountModelKey, ACCOUNT_MODELS_TTL_MS } from "./account-models";
import type { AccountModelSnapshot } from "./account-models";

vi.mock("./storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("./storage")>(),
  saveAccountsRuntimeState: vi.fn(async () => {}),
}));

function snapshot(models: string[], checkedAt = Date.now()): AccountModelSnapshot {
  return { generation: "test", startedAt: checkedAt, checkedAt, models };
}

describe("account-aware model routing", () => {
  it.each(["sticky", "round-robin", "hybrid"] as const)("never selects a known incompatible account using %s", (strategy) => {
    const manager = new AccountManager(undefined, {
      version: 4, activeIndex: 0, activeIndexByFamily: {}, accounts: [
        { refreshToken: "starter", addedAt: 1, lastUsed: 1 },
        { refreshToken: "pro", addedAt: 1, lastUsed: 1 },
      ],
    });
    manager.setModelAvailability({
      [accountModelKey("starter")]: snapshot(["claude-sonnet-4-6", "gemini-4-argon-disabled"]),
      [accountModelKey("pro")]: snapshot(["claude-sonnet-5-5-high", "gemini-4-argon-high"]),
    });
    expect(manager.getCurrentOrNextForFamily("claude", "antigravity-claude-sonnet-5-5-high", strategy)?.parts.refreshToken).toBe("pro");
    expect(manager.getCurrentOrNextForFamily("gemini", "antigravity-gemini-4-argon", strategy)?.parts.refreshToken).toBe("pro");
    expect(manager.getCurrentOrNextForFamily("claude", "antigravity-claude-sonnet-4-6", strategy)?.parts.refreshToken).toBe("starter");
    expect(manager.getCurrentOrNextForFamily("claude", "claude-missing", strategy)).toBeNull();
  });

  it("distinguishes base IDs, exact tiers, disabled, stale and unknown catalogs", () => {
    const data = snapshot(["gemini-4-argon-high"]);
    expect(accountModelAvailability(data, "antigravity-gemini-4-argon")).toBe("available");
    expect(accountModelAvailability(data, "gemini-4-argon-low")).toBe("unavailable");
    expect(accountModelAvailability(snapshot(["gemini-4-argon-disabled"]), "gemini-4-argon")).toBe("unavailable");
    expect(accountModelAvailability(undefined, "gemini-4-argon")).toBe("unknown");
    expect(accountModelAvailability(snapshot([], Date.now() - ACCOUNT_MODELS_TTL_MS - 1), "gemini-4-argon")).toBe("unknown");
  });

  it("observes refreshed entitlements without recreating a live manager", () => {
    const manager = new AccountManager(undefined, { version: 4, activeIndex: 0, accounts: [
      { refreshToken: "account", addedAt: 1, lastUsed: 1 },
    ] });
    manager.setModelAvailability({ [accountModelKey("account")]: snapshot(["gemini-4-argon-disabled"]) });
    expect(manager.hasModelCandidate("gemini-4-argon")).toBe(false);
    manager.setModelAvailability({ [accountModelKey("account")]: snapshot(["gemini-4-argon-medium"]) });
    expect(manager.hasModelCandidate("gemini-4-argon")).toBe(true);
  });
});
