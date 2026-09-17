import { describe, it, expect, vi } from "vitest";
import { createDummyClient, persistAccountPoolHelper } from "./account-manager-cli";
import * as storage from "./storage";

vi.mock("./storage", () => ({
  loadAccounts: vi.fn(),
  saveAccounts: vi.fn(),
  removeAccountFromStorage: vi.fn(),
  clearAccounts: vi.fn(),
}));

describe("account-manager-cli", () => {
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
