import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { reloadOpencodeConfiguration } from "./reload";

const state = vi.hoisted(() => ({
  complete: undefined as ((error: Error | null) => void) | undefined,
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    state.complete = callback;
  }),
}));

afterEach(() => {
  state.complete = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("OpenCode configuration reload", () => {
  it("awaits reload without spawning a shell or restarting the service", async () => {
    let completed = false;
    const pending = reloadOpencodeConfiguration().then(() => { completed = true; });
    expect(execFile).toHaveBeenCalledWith("opencode", ["reload"], { timeout: 30000 }, expect.any(Function));
    await Promise.resolve();
    expect(completed).toBe(false);
    state.complete?.(null);
    await pending;
    expect(completed).toBe(true);
  });

  it("keeps saved changes usable and warns on reload failure without restarting", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = reloadOpencodeConfiguration();
    state.complete?.(new Error("unavailable"));
    await expect(pending).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("opencode reload"));
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
