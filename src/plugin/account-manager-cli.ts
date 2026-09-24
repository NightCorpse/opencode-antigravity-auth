import {
  pressEnterToContinue,
  promptAddAnotherAccount,
  promptLoginMode,
  promptProjectId,
  type ExistingAccountInfo,
  type LoginMenuResult,
} from "./cli";
import {
  clearAccounts,
  loadAccounts,
  removeAccountFromStorage,
  saveAccounts,
  type AccountMetadataV3,
  type AccountStorageV4,
} from "./storage";
import { checkAccountsQuota } from "./quota";
import {
  formatRefreshParts,
  parseRefreshParts,
} from "./auth";
import type { RefreshParts } from "./types";
import {
  authorizeAntigravity,
  exchangeAntigravity,
  type AntigravityAuthorization,
  type AntigravityTokenExchangeResult,
} from "../antigravity/oauth";
import { startOAuthListener, type OAuthListener } from "./server";
import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./token";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { exec } from "node:child_process";
import type { PluginClient } from "./types";

const MAX_OAUTH_ACCOUNTS = 10;

interface OAuthCallbackParams {
  code: string;
  state: string;
}

function extractOAuthCallbackParams(url: URL): OAuthCallbackParams | null {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return null;
  }
  return { code, state };
}

function parseOAuthCallbackInput(
  value: string,
  fallbackState: string,
): OAuthCallbackParams | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { error: "Missing authorization code" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? fallbackState;

    if (!code) {
      return { error: "Missing code in callback URL" };
    }
    if (!state) {
      return { error: "Missing state in callback URL" };
    }

    return { code, state };
  } catch {
    if (!fallbackState) {
      return { error: "Missing state. Paste the full redirect URL instead of only the code." };
    }

    return { code: trimmed, state: fallbackState };
  }
}

async function promptOAuthCallbackValue(promptText: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(promptText);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function getStateFromAuthorizationUrl(authorizationUrl: string): string {
  try {
    const parsed = new URL(authorizationUrl);
    return parsed.searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}

async function promptManualOAuthInput(
  fallbackState: string,
): Promise<AntigravityTokenExchangeResult> {
  console.log("1. Open the URL above in your browser and complete Google sign-in.");
  console.log("2. After approving, copy the full redirected localhost URL from the address bar.");
  console.log("3. Paste it back here.\n");

  const callbackInput = await promptOAuthCallbackValue(
    "Paste the redirect URL (or just the code) here: ",
  );
  const params = parseOAuthCallbackInput(callbackInput, fallbackState);
  if ("error" in params) {
    return { type: "failed", error: params.error };
  }

  return exchangeAntigravity(params.code, params.state);
}

async function promptAccountIndexForVerification(
  existingAccounts: ExistingAccountInfo[],
): Promise<number | undefined> {
  if (existingAccounts.length === 0) {
    return undefined;
  }

  console.log("\nAccounts:");
  for (const acc of existingAccounts) {
    const label = acc.email || `Account ${acc.index + 1}`;
    console.log(`  ${acc.index + 1}. ${label}`);
  }
  console.log("");

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question(
        `Select account to verify (1-${existingAccounts.length}, or 'c' to cancel): `,
      );
      const normalized = answer.trim().toLowerCase();
      if (normalized === "c" || normalized === "cancel") {
        return undefined;
      }
      const parsed = Number.parseInt(normalized, 10);
      if (
        !Number.isNaN(parsed) &&
        parsed >= 1 &&
        parsed <= existingAccounts.length
      ) {
        return parsed - 1;
      }
      console.log(`Please enter a number between 1 and ${existingAccounts.length}, or 'c'.`);
    }
  } finally {
    rl.close();
  }
}

async function promptOpenVerificationUrl(): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Open this verification URL in your browser now? (y/n): ");
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let command: string;
    switch (process.platform) {
      case "darwin":
        command = `open "${url}"`;
        break;
      case "win32":
        command = `start "" "${url}"`;
        break;
      default:
        command = `xdg-open "${url}"`;
        break;
    }
    exec(command, (error) => {
      resolve(!error);
    });
  });
}

function formatWaitTime(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

interface VerificationProbeResult {
  status: "ok" | "blocked" | "error";
  message: string;
  verifyUrl?: string;
}

function markStoredAccountVerificationRequired(
  account: AccountMetadataV3,
  reason?: string,
  verifyUrl?: string,
): boolean {
  let changed = false;
  if (!account.verificationRequired) {
    account.verificationRequired = true;
    changed = true;
  }
  if (account.verificationRequiredReason !== reason) {
    account.verificationRequiredReason = reason;
    changed = true;
  }
  if (account.verificationUrl !== verifyUrl) {
    account.verificationUrl = verifyUrl;
    changed = true;
  }
  return changed;
}

function clearStoredAccountVerificationRequired(
  account: AccountMetadataV3,
): { changed: boolean; wasVerificationRequired: boolean } {
  const wasVerificationRequired = account.verificationRequired === true;
  let changed = false;

  if (account.verificationRequired !== false) {
    account.verificationRequired = false;
    changed = true;
  }
  if (account.verificationRequiredAt !== undefined) {
    account.verificationRequiredAt = undefined;
    changed = true;
  }
  if (account.verificationRequiredReason !== undefined) {
    account.verificationRequiredReason = undefined;
    changed = true;
  }
  if (account.verificationUrl !== undefined) {
    account.verificationUrl = undefined;
    changed = true;
  }

  return { changed, wasVerificationRequired };
}

async function verifyAccountAccess(
  account: {
    refreshToken: string;
    email?: string;
    projectId?: string;
    managedProjectId?: string;
  },
  client: PluginClient,
  providerId: string,
): Promise<VerificationProbeResult> {
  const parsed = parseRefreshParts(account.refreshToken);
  if (!parsed.refreshToken) {
    return { status: "error", message: "Missing refresh token for selected account." };
  }

  const auth = {
    type: "oauth" as const,
    refresh: formatRefreshParts({
      refreshToken: parsed.refreshToken,
      projectId: parsed.projectId ?? account.projectId,
      managedProjectId: parsed.managedProjectId ?? account.managedProjectId,
    }),
    access: "",
    expires: 0,
  };

  let refreshedAuth: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    refreshedAuth = await refreshAccessToken(auth, client, providerId);
  } catch (error) {
    if (error instanceof AntigravityTokenRefreshError) {
      return { status: "error", message: error.message };
    }
    return { status: "error", message: `Token refresh failed: ${String(error)}` };
  }

  if (!refreshedAuth?.access) {
    return { status: "error", message: "Could not refresh access token for this account." };
  }

  return { status: "ok", message: "Account access token refreshed successfully." };
}

export async function persistAccountPoolHelper(
  results: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>>,
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) return;

  const existing = replaceAll ? null : await loadAccounts();
  const currentAccounts = existing ? [...existing.accounts] : [];

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh);
    if (!parts.refreshToken) continue;

    const existingIndex = currentAccounts.findIndex(
      (a) =>
        (result.email && a.email && a.email.toLowerCase() === result.email.toLowerCase()) ||
        a.refreshToken === parts.refreshToken,
    );

    const metadata: AccountMetadataV3 = {
      email: result.email,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
      addedAt: Date.now(),
      lastUsed: Date.now(),
    };

    if (existingIndex >= 0) {
      currentAccounts[existingIndex] = {
        ...currentAccounts[existingIndex],
        ...metadata,
      };
    } else {
      currentAccounts.push(metadata);
    }
  }

  const newStorage: AccountStorageV4 = {
    version: 4,
    accounts: currentAccounts,
    activeIndex: 0,
    activeIndexByFamily: {},
  };

  await saveAccounts(newStorage);
}

export function createDummyClient(): PluginClient {
  return {
    app: {
      log: async () => {},
    },
    auth: {
      set: async () => {},
    },
    session: {
      abort: async () => {},
      messages: async () => ({ data: [] }),
      prompt: async () => ({ data: undefined }),
    },
    tui: {
      showToast: async () => {},
    },
  } as unknown as PluginClient;
}

export async function displayAccountsQuota(
  storage: AccountStorageV4,
  client: PluginClient,
  providerId: string,
): Promise<void> {
  console.log("\n📊 Checking quotas for all accounts...\n");
  const results = await checkAccountsQuota(
    storage.accounts,
    client,
    providerId,
  );
  let storageUpdated = false;

  for (const res of results) {
    const label = res.email || `Account ${res.index + 1}`;
    const disabledStr = res.disabled ? " (disabled)" : "";
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ${label}${disabledStr}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (res.status === "error") {
      console.log(`  ❌ Error: ${res.error}\n`);
      continue;
    }

    const colors = {
      red: "\x1b[31m",
      orange: "\x1b[33m",
      green: "\x1b[32m",
      reset: "\x1b[0m",
    };

    const getColor = (remaining?: number): string => {
      if (typeof remaining !== "number") return colors.reset;
      if (remaining < 0.2) return colors.red;
      if (remaining < 0.6) return colors.orange;
      return colors.green;
    };

    const createProgressBar = (
      remaining?: number,
      width: number = 20,
    ): string => {
      if (typeof remaining !== "number") return "░".repeat(width) + " ???";
      const filled = Math.round(remaining * width);
      const empty = width - filled;
      const color = getColor(remaining);
      const bar = `${color}${"█".repeat(filled)}${colors.reset}${"░".repeat(empty)}`;
      const pct = `${color}${Math.round(remaining * 100)}%${colors.reset}`.padStart(
        4 + color.length + colors.reset.length,
      );
      return `${bar} ${pct}`;
    };

    const formatReset = (resetTime?: string): string => {
      if (!resetTime) return "";
      const ms = Date.parse(resetTime) - Date.now();
      if (ms <= 0) return " (resetting...)";

      const hours = ms / (1000 * 60 * 60);
      if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = Math.floor(hours % 24);
        if (remainingHours > 0) {
          return ` (resets in ${days}d ${remainingHours}h)`;
        }
        return ` (resets in ${days}d)`;
      }
      return ` (resets in ${formatWaitTime(ms)})`;
    };

    // Display Antigravity quota
    const hasAntigravity =
      res.quota && Object.keys(res.quota.groups).length > 0;
    console.log(`  │`);
    console.log(`  └─ Antigravity Quota`);
    if (!hasAntigravity) {
      const errorMsg =
        res.quota?.error || "No quota information available";
      console.log(`     └─ ${errorMsg}`);
    } else {
      const groups = res.quota!.groups;
      const groupEntries = [
        { name: "Claude", data: groups.claude },
        { name: "Gemini 3 Pro", data: groups["gemini-pro"] },
        { name: "Gemini 3 Flash", data: groups["gemini-flash"] },
      ].filter((g) => g.data);

      groupEntries.forEach((g, idx) => {
        const isLast = idx === groupEntries.length - 1;
        const connector = isLast ? "└─" : "├─";
        const bar = createProgressBar(g.data!.remainingFraction);
        const reset = formatReset(g.data!.resetTime);
        const modelName = g.name.padEnd(29);
        console.log(`     ${connector} ${modelName} ${bar}${reset}`);
      });
    }
    console.log("");

    if (res.quota?.groups) {
      const acc = storage.accounts[res.index];
      if (acc) {
        acc.cachedQuota = res.quota.groups;
        acc.cachedQuotaUpdatedAt = Date.now();
        storageUpdated = true;
      }
    }

    if (res.updatedAccount) {
      storage.accounts[res.index] = {
        ...res.updatedAccount,
        cachedQuota: res.quota?.groups,
        cachedQuotaUpdatedAt: Date.now(),
      };
      storageUpdated = true;
    }
  }

  if (storageUpdated) {
    await saveAccounts(storage);
  }
}

/**
 * Runs the interactive Antigravity account manager in the terminal.
 */
export function restartOpencodeServiceSafely(): void {
  try {
    exec("opencode service restart", () => {});
  } catch {
    // Non-critical background sync
  }
}

export async function runInteractiveAccountManager(
  args: string[] = process.argv.slice(2),
  client: PluginClient = createDummyClient(),
  providerId: string = ANTIGRAVITY_PROVIDER_ID,
): Promise<void> {
  const isHeadless = !!(
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.OPENCODE_HEADLESS
  );

  // Handle direct command-line arguments (e.g. "quota" or "-q")
  const firstArg = args[0]?.toLowerCase();
  if (firstArg === "quota" || firstArg === "-q" || firstArg === "--quota") {
    const existingStorage = await loadAccounts();
    if (!existingStorage || existingStorage.accounts.length === 0) {
      console.log("\nNo Antigravity accounts found in storage.\n");
      return;
    }
    await displayAccountsQuota(existingStorage, client, providerId);
    return;
  }

  while (true) {
    const existingStorage = await loadAccounts();

    if (existingStorage && existingStorage.accounts.length > 0) {
      const now = Date.now();
      const existingAccounts = existingStorage.accounts.map((acc, idx) => {
        let status:
          | "active"
          | "rate-limited"
          | "expired"
          | "verification-required"
          | "unknown" = "unknown";

        if (acc.reauthRequired) {
          status = "expired";
        } else if (acc.verificationRequired) {
          status = "verification-required";
        } else {
          const rateLimits = acc.rateLimitResetTimes;
          if (rateLimits) {
            const isRateLimited = Object.values(rateLimits).some(
              (resetTime) => typeof resetTime === "number" && resetTime > now,
            );
            status = isRateLimited ? "rate-limited" : "active";
          } else {
            status = "active";
          }

          if (acc.coolingDownUntil && acc.coolingDownUntil > now) {
            status = "rate-limited";
          }
        }

        return {
          email: acc.email,
          index: idx,
          addedAt: acc.addedAt,
          lastUsed: acc.lastUsed,
          status,
          isCurrentAccount: idx === (existingStorage.activeIndex ?? 0),
          enabled: acc.enabled !== false,
        };
      });

      const menuResult = await promptLoginMode(existingAccounts);

      if (menuResult.mode === "check") {
        await displayAccountsQuota(existingStorage, client, providerId);
        console.log("");
        await pressEnterToContinue();
        continue;
      }

      if (menuResult.mode === "manage") {
        if (menuResult.toggleAccountIndex !== undefined) {
          const acc = existingStorage.accounts[menuResult.toggleAccountIndex];
          if (acc) {
            acc.enabled = acc.enabled === false;
            acc.enabledUpdatedAt = Date.now();
            await saveAccounts(existingStorage);
            restartOpencodeServiceSafely();
            console.log(
              `\nAccount ${acc.email || menuResult.toggleAccountIndex + 1} ${acc.enabled ? "enabled" : "disabled"}.\n`,
            );
            await pressEnterToContinue();
          }
        }
        continue;
      }

      if (menuResult.mode === "verify" || menuResult.mode === "verify-all") {
        const verifyAll =
          menuResult.mode === "verify-all" || menuResult.verifyAll === true;

        if (verifyAll) {
          if (existingStorage.accounts.length === 0) {
            console.log("\nNo accounts available to verify.\n");
            await pressEnterToContinue();
            continue;
          }

          console.log(
            `\nChecking verification status for ${existingStorage.accounts.length} account(s)...\n`,
          );

          let okCount = 0;
          let blockedCount = 0;
          let errorCount = 0;
          let storageUpdated = false;

          const blockedResults: Array<{
            label: string;
            message: string;
            verifyUrl?: string;
          }> = [];

          for (let i = 0; i < existingStorage.accounts.length; i++) {
            const account = existingStorage.accounts[i];
            if (!account) continue;

            const label = account.email || `Account ${i + 1}`;
            process.stdout.write(
              `- [${i + 1}/${existingStorage.accounts.length}] ${label} ... `,
            );

            const verification = await verifyAccountAccess(
              account,
              client,
              providerId,
            );
            if (verification.status === "ok") {
              const { changed } = clearStoredAccountVerificationRequired(
                account,
              );
              if (changed) {
                storageUpdated = true;
              }
              okCount += 1;
              console.log("ok");
              continue;
            }

            if (verification.status === "blocked") {
              const changed = markStoredAccountVerificationRequired(
                account,
                verification.message,
                verification.verifyUrl,
              );
              if (changed) {
                storageUpdated = true;
              }

              blockedCount += 1;
              console.log("needs verification");
              const verifyUrl =
                verification.verifyUrl ?? account.verificationUrl;
              blockedResults.push({
                label,
                message: verification.message,
                verifyUrl,
              });
              continue;
            }

            errorCount += 1;
            console.log(`error (${verification.message})`);
          }

          if (storageUpdated) {
            await saveAccounts(existingStorage);
          }

          console.log(
            `\nVerification summary: ${okCount} ready, ${blockedCount} need verification, ${errorCount} errors.`,
          );

          if (blockedResults.length > 0) {
            console.log("\nAccounts needing verification:");
            for (const result of blockedResults) {
              console.log(`\n- ${result.label}`);
              console.log(`  ${result.message}`);
              if (result.verifyUrl) {
                console.log(`  URL: ${result.verifyUrl}`);
              }
            }
          }
          console.log("");
          await pressEnterToContinue();
          continue;
        }

        let verifyAccountIndex = menuResult.verifyAccountIndex;
        if (verifyAccountIndex === undefined) {
          verifyAccountIndex = await promptAccountIndexForVerification(
            existingAccounts,
          );
        }

        if (verifyAccountIndex === undefined) {
          console.log("\nVerification cancelled.\n");
          await pressEnterToContinue();
          continue;
        }

        const account = existingStorage.accounts[verifyAccountIndex];
        if (!account) {
          console.log(`\nAccount ${verifyAccountIndex + 1} not found.\n`);
          await pressEnterToContinue();
          continue;
        }

        const label = account.email || `Account ${verifyAccountIndex + 1}`;
        console.log(`\nChecking verification status for ${label}...\n`);

        const verification = await verifyAccountAccess(
          account,
          client,
          providerId,
        );

        if (verification.status === "ok") {
          const { changed, wasVerificationRequired } =
            clearStoredAccountVerificationRequired(account);
          if (changed) {
            await saveAccounts(existingStorage);
          }

          if (wasVerificationRequired) {
            console.log(
              `✓ ${label} is ready for requests.\n`,
            );
          } else {
            console.log(`✓ ${label} is ready for requests.\n`);
          }
          await pressEnterToContinue();
          continue;
        }

        if (verification.status === "blocked") {
          const changed = markStoredAccountVerificationRequired(
            account,
            verification.message,
            verification.verifyUrl,
          );
          if (changed) {
            await saveAccounts(existingStorage);
          }

          const verifyUrl = verification.verifyUrl ?? account.verificationUrl;
          console.log(
            `⚠ ${label} needs Google verification before it can be used.`,
          );
          if (verification.message) {
            console.log(verification.message);
          }
          console.log(`${label} is temporarily unavailable until verification is completed.`);
          if (verifyUrl) {
            console.log(`\nVerification URL:\n${verifyUrl}\n`);
            if (await promptOpenVerificationUrl()) {
              await openBrowser(verifyUrl);
            }
          }
          await pressEnterToContinue();
          continue;
        }

        console.log(`✗ ${label}: ${verification.message}\n`);
        await pressEnterToContinue();
        continue;
      }

      if (menuResult.mode === "cancel") {
        console.log("Operation cancelled.");
        return;
      }

      if (menuResult.deleteAccountIndex !== undefined) {
        const deletedAccount =
          existingStorage.accounts[menuResult.deleteAccountIndex];
        if (deletedAccount) {
          await removeAccountFromStorage(deletedAccount.refreshToken);
          restartOpencodeServiceSafely();
        }
        console.log("\nAccount deleted.\n");
        await pressEnterToContinue();
        continue;
      }

      if (menuResult.deleteAll) {
        await clearAccounts();
        restartOpencodeServiceSafely();
        console.log("\nAll accounts deleted.\n");
        await pressEnterToContinue();
        continue;
      }

      // If user chose re-authentication
      if (menuResult.refreshAccountIndex !== undefined) {
        const refreshIndex = menuResult.refreshAccountIndex;
        const targetAccount = existingStorage.accounts[refreshIndex];
        const refreshEmail = targetAccount?.email;
        console.log(`\nRe-authenticating ${refreshEmail || "account"}...\n`);

        const projectId = await promptProjectId(targetAccount?.projectId);
        const authorization = await authorizeAntigravity(projectId);
        const fallbackState = getStateFromAuthorizationUrl(authorization.url);

        console.log("\nOAuth URL:\n" + authorization.url + "\n");

        let result: AntigravityTokenExchangeResult;

        if (isHeadless) {
          result = await promptManualOAuthInput(fallbackState);
        } else {
          let listener: OAuthListener | null = null;
          try {
            listener = await startOAuthListener();
          } catch {
            listener = null;
          }

          await openBrowser(authorization.url);

          if (listener) {
            try {
              const SOFT_TIMEOUT_MS = 30000;
              const callbackPromise = listener.waitForCallback();
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("SOFT_TIMEOUT")), SOFT_TIMEOUT_MS),
              );

              let callbackUrl: URL;
              try {
                callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
              } catch (err) {
                if (err instanceof Error && err.message === "SOFT_TIMEOUT") {
                  console.log("\n⏳ Automatic callback not received after 30 seconds.");
                  console.log("You can paste the redirect URL manually.\n");
                  try {
                    await listener.close();
                  } catch {}
                  result = await promptManualOAuthInput(fallbackState);
                  callbackUrl = new URL("http://localhost");
                } else {
                  throw err;
                }
              }

              if (result! === undefined) {
                const params = extractOAuthCallbackParams(callbackUrl);
                if (!params) {
                  result = {
                    type: "failed",
                    error: "Missing code or state in callback URL",
                  };
                } else {
                  result = await exchangeAntigravity(params.code, params.state);
                }
              }
            } catch {
              result = await promptManualOAuthInput(fallbackState);
            } finally {
              try {
                await listener.close();
              } catch {}
            }
          } else {
            result = await promptManualOAuthInput(fallbackState);
          }
        }

        if (result.type === "failed") {
          console.log(`\n❌ Failed: ${result.error}\n`);
          await pressEnterToContinue();
          continue;
        }

        const currentStorage = await loadAccounts();
        if (currentStorage) {
          const updatedAccounts = [...currentStorage.accounts];
          const parts = parseRefreshParts(result.refresh);
          if (parts.refreshToken) {
            const previous = updatedAccounts[refreshIndex];
            updatedAccounts[refreshIndex] = {
              ...previous,
              email: result.email ?? previous?.email,
              refreshToken: parts.refreshToken,
              projectId: parts.projectId ?? (projectId || previous?.projectId),
              managedProjectId:
                parts.managedProjectId ??
                previous?.managedProjectId,
              addedAt:
                previous?.addedAt ?? Date.now(),
              lastUsed: Date.now(),
              reauthRequired: false,
              reauthRequiredAt: undefined,
              reauthRequiredReason: undefined,
            };
            await saveAccounts({
              version: 4,
              accounts: updatedAccounts,
              activeIndex: currentStorage.activeIndex,
              activeIndexByFamily: currentStorage.activeIndexByFamily,
            });
            restartOpencodeServiceSafely();
          }
        }

        console.log(`\n✓ Account authenticated (${result.email || "success"}).\n`);
        await pressEnterToContinue();
        continue;
      }

      // If user chose to add an account (or fresh setup)
      const startFresh = menuResult.mode === "fresh";
      let addedCount = 0;

      while (true) {
        const latestStorage = await loadAccounts();
        const currentCount = latestStorage?.accounts.length ?? 0;
        if (currentCount >= MAX_OAUTH_ACCOUNTS) {
          console.log("\nMaximum number of accounts reached.\n");
          await pressEnterToContinue();
          break;
        }

        console.log(`\n=== Antigravity OAuth (Account ${currentCount + 1}) ===`);

        const projectId = await promptProjectId();
        const authorization = await authorizeAntigravity(projectId);
        const fallbackState = getStateFromAuthorizationUrl(authorization.url);

        console.log("\nOAuth URL:\n" + authorization.url + "\n");

        let result: AntigravityTokenExchangeResult;

        if (isHeadless) {
          result = await promptManualOAuthInput(fallbackState);
        } else {
          let listener: OAuthListener | null = null;
          try {
            listener = await startOAuthListener();
          } catch {
            listener = null;
          }

          await openBrowser(authorization.url);

          if (listener) {
            try {
              const SOFT_TIMEOUT_MS = 30000;
              const callbackPromise = listener.waitForCallback();
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("SOFT_TIMEOUT")), SOFT_TIMEOUT_MS),
              );

              let callbackUrl: URL;
              try {
                callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
              } catch (err) {
                if (err instanceof Error && err.message === "SOFT_TIMEOUT") {
                  console.log("\n⏳ Automatic callback not received after 30 seconds.");
                  console.log("You can paste the redirect URL manually.\n");
                  try {
                    await listener.close();
                  } catch {}
                  result = await promptManualOAuthInput(fallbackState);
                  callbackUrl = new URL("http://localhost");
                } else {
                  throw err;
                }
              }

              if (result! === undefined) {
                const params = extractOAuthCallbackParams(callbackUrl);
                if (!params) {
                  result = {
                    type: "failed",
                    error: "Missing code or state in callback URL",
                  };
                } else {
                  result = await exchangeAntigravity(params.code, params.state);
                }
              }
            } catch {
              result = await promptManualOAuthInput(fallbackState);
            } finally {
              try {
                await listener.close();
              } catch {}
            }
          } else {
            result = await promptManualOAuthInput(fallbackState);
          }
        }

        if (result.type === "failed") {
          console.log(`\n❌ Failed: ${result.error}\n`);
          await pressEnterToContinue();
          break;
        }

        addedCount++;
        const isFirst = addedCount === 1;
        await persistAccountPoolHelper([result], isFirst && startFresh);
        restartOpencodeServiceSafely();

        console.log(
          `\n✓ Account authenticated${result.email ? ` (${result.email})` : ""}`,
        );

        const updatedStorage = await loadAccounts();
        const totalNow = updatedStorage?.accounts.length ?? 0;
        const addAnother = await promptAddAnotherAccount(totalNow);
        if (!addAnother) {
          break;
        }
      }

      await pressEnterToContinue();
      continue;
    }

    // No existing accounts - prompt to add first account
    console.log("\nNo Antigravity accounts configured.\n");
    console.log("=== Antigravity OAuth (Account 1) ===\n");

    const projectId = await promptProjectId();
    const authorization = await authorizeAntigravity(projectId);
    const fallbackState = getStateFromAuthorizationUrl(authorization.url);

    console.log("\nOAuth URL:\n" + authorization.url + "\n");

    let result: AntigravityTokenExchangeResult;

    if (isHeadless) {
      result = await promptManualOAuthInput(fallbackState);
    } else {
      let listener: OAuthListener | null = null;
      try {
        listener = await startOAuthListener();
      } catch {
        listener = null;
      }

      await openBrowser(authorization.url);

      if (listener) {
        try {
          const SOFT_TIMEOUT_MS = 30000;
          const callbackPromise = listener.waitForCallback();
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("SOFT_TIMEOUT")), SOFT_TIMEOUT_MS),
          );

          let callbackUrl: URL;
          try {
            callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
          } catch (err) {
            if (err instanceof Error && err.message === "SOFT_TIMEOUT") {
              console.log("\n⏳ Automatic callback not received after 30 seconds.");
              console.log("You can paste the redirect URL manually.\n");
              try {
                await listener.close();
              } catch {}
              result = await promptManualOAuthInput(fallbackState);
              callbackUrl = new URL("http://localhost");
            } else {
              throw err;
            }
          }

          if (result! === undefined) {
            const params = extractOAuthCallbackParams(callbackUrl);
            if (!params) {
              result = {
                type: "failed",
                error: "Missing code or state in callback URL",
              };
            } else {
              result = await exchangeAntigravity(params.code, params.state);
            }
          }
        } catch {
          result = await promptManualOAuthInput(fallbackState);
        } finally {
          try {
            await listener.close();
          } catch {}
        }
      } else {
        result = await promptManualOAuthInput(fallbackState);
      }
    }

    if (result.type === "failed") {
      console.log(`\n❌ Failed: ${result.error}\n`);
      return;
    }

    await persistAccountPoolHelper([result], true);
    restartOpencodeServiceSafely();

    console.log(
      `\n✓ Account authenticated${result.email ? ` (${result.email})` : ""}\n`,
    );

    await pressEnterToContinue();
  }
}
