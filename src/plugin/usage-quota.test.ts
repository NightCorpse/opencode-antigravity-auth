import { afterEach, describe, expect, it, vi } from "vitest";
import { __testExports, fetchAccountQuotaSummary } from "./quota";
import { ANTIGRAVITY_ARGON_CLI_USER_AGENT } from "../constants";

const summary = {
  groups: [
    { displayName: "Gemini Models", description: "Flash and Pro", buckets: [
      { bucketId: "gemini-weekly", displayName: "Weekly", window: "weekly", remainingFraction: 0.9864 },
      { bucketId: "gemini-5h", displayName: "Five Hour", window: "5h", remainingFraction: 1 },
    ] },
    { displayName: "Gemini 4 Argon", buckets: [
      { bucketId: "argon-weekly", displayName: "Argon Weekly", window: "weekly", remainingFraction: 0 },
    ] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("official usage quota", () => {
  it("preserves server groups, simultaneous windows and exhausted buckets", () => {
    const result = __testExports.parseUsageSummary(summary);
    expect(result.usageGroups?.[0]?.buckets).toHaveLength(2);
    expect(result.usageGroups?.[1]?.buckets[0]?.remainingFraction).toBe(0);
    expect(result.groups).toEqual({});
  });

  it("does not synthesize a separate Argon group on shared-plan responses", () => {
    const result = __testExports.parseUsageSummary({ groups: [summary.groups[0]] });
    expect(result.usageGroups).toHaveLength(1);
  });

  it("preserves absolute, disabled and unknown quota without inventing percentages", () => {
    const result = __testExports.parseUsageSummary({ buckets: [
      { bucketId: "a", displayName: "Credits", remainingAmount: "9007199254740993", window: "monthly" },
      { bucketId: "b", displayName: "Disabled", disabled: true },
      { bucketId: "c", displayName: "Unknown", resetTime: "invalid" },
    ] });
    const buckets = result.usageGroups![0]!.buckets;
    expect(buckets[0]?.remainingAmount).toBe("9007199254740993");
    expect(buckets[1]?.disabled).toBe(true);
    expect(buckets[2]?.remainingFraction).toBeUndefined();
    expect(buckets[2]?.resetTime).toBeUndefined();
  });

  it("requests the summary with the current CLI identity without calling legacy discovery", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(summary));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchAccountQuotaSummary("test-token", "test-project")).resolves.toMatchObject({ usageGroups: summary.groups });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(":retrieveUserQuotaSummary"), expect.objectContaining({
      body: JSON.stringify({ project: "test-project" }),
      headers: expect.objectContaining({ "User-Agent": ANTIGRAVITY_ARGON_CLI_USER_AGENT }),
    }));
  });

  it.each(["http", "invalid", "empty", "network"])("falls back on %s summary failure", async (failure) => {
    const fetch = vi.fn();
    if (failure === "network") fetch.mockRejectedValueOnce(new Error("offline"));
    else fetch.mockResolvedValueOnce(failure === "http" ? new Response(null, { status: 404 })
      : Response.json(failure === "empty" ? { groups: [] } : { groups: [{}] }));
    fetch.mockResolvedValueOnce(Response.json({ models: {
      "gemini-3.8-flash": { quotaInfo: { remainingFraction: 0.5 } },
    } }));
    vi.stubGlobal("fetch", fetch);
    const result = await fetchAccountQuotaSummary("test-token", "test-project");
    expect(result.groups["gemini-flash"]?.remainingFraction).toBe(0.5);
    expect(result.usageGroups).toBeUndefined();
    expect(fetch.mock.calls[1]?.[0]).toContain(":fetchAvailableModels");
  });

  it("reports failure when both APIs fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(fetchAccountQuotaSummary("test-token", "test-project")).rejects.toThrow();
  });
});
