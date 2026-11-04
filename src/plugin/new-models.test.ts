import { describe, expect, it } from "vitest";
import { resolveModelWithTier } from "./transform/model-resolver";
import { prepareAntigravityRequest } from "./request";
import { OPENCODE_MODEL_DEFINITIONS } from "./config/models";
import { ANTIGRAVITY_ARGON_CLI_USER_AGENT } from "../constants";

const thirdPartyIds = [
  ...["opus", "sonnet"].flatMap((family) => ["low", "medium", "high"].map((tier) => `claude-${family}-5-5-${tier}`)),
  "gpt-oss-120b-medium",
];

describe("new advertised model backend IDs", () => {
  describe.each([false, true])("Claude 5.5 variants wrapped=%s", (wrapped) => {
    it.each(["low", "medium", "high"])("maps %s to the exact backend without forwarding Gemini thinking settings", (level) => {
      for (const family of ["opus", "sonnet"]) {
        const model = `claude-${family}-5-5`;
        const payload = { contents: [], generationConfig: { thinkingConfig: { thinkingLevel: level } } };
        const result = prepareAntigravityRequest(
          `https://generativelanguage.googleapis.com/v1beta/models/antigravity-${model}:generateContent`,
          { method: "POST", body: JSON.stringify(wrapped ? { project: "p", request: payload } : payload) }, "token", "p",
        );
        expect(result.effectiveModel).toBe(`${model}-${level}`);
        expect(JSON.parse(result.init.body as string).request.generationConfig?.thinkingConfig).toBeUndefined();
      }
    });
  });
  it.each(thirdPartyIds)("preserves %s without converting its backend suffix into a legacy budget", (id) => {
    expect(OPENCODE_MODEL_DEFINITIONS[`antigravity-${id.startsWith("claude") ? id.replace(/-(low|medium|high)$/, "") : id}`]).toBeDefined();
    const resolved = resolveModelWithTier(`antigravity-${id}`);
    expect(resolved.actualModel).toBe(id);
    expect(resolved.thinkingBudget).toBeUndefined();
    expect(resolved.thinkingLevel).toBeUndefined();
  });

  describe.each([false, true])("wrapped=%s", (wrapped) => {
    it.each(thirdPartyIds)("lowers %s to its exact backend", (id) => {
      const payload = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
      const result = prepareAntigravityRequest(
        `https://generativelanguage.googleapis.com/v1beta/models/antigravity-${id}:streamGenerateContent?alt=sse`,
        { method: "POST", body: JSON.stringify(wrapped ? { project: "test", request: payload } : payload) },
        "test-token", "test-project",
      );
      expect(result.effectiveModel).toBe(id);
      expect(JSON.parse(result.init.body as string).model).toBe(id);
      if (id.startsWith("claude")) expect(new Headers(result.init.headers).get("User-Agent")).toBe(ANTIGRAVITY_ARGON_CLI_USER_AGENT);
    });
  });

  it.each(["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"])("does not rewrite %s as tiered Flash", (id) => {
    expect(resolveModelWithTier(`antigravity-${id}`).actualModel).toBe(id);
    const result = prepareAntigravityRequest(`https://generativelanguage.googleapis.com/v1beta/models/antigravity-${id}:generateContent`,
      { method: "POST", body: JSON.stringify({ contents: [] }) }, "test-token", "test-project");
    expect(result.effectiveModel).toBe(id);
  });
});
