#!/usr/bin/env node
import { runInteractiveAccountManager } from "./plugin/account-manager-cli";

runInteractiveAccountManager(process.argv.slice(2)).catch((err) => {
  console.error("Antigravity account manager error:", err);
  process.exit(1);
});

