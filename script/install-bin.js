#!/usr/bin/env node
import { existsSync, mkdirSync, symlinkSync, unlinkSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const binSource = resolve(__dirname, "../bin/cli.js");

// Ensure source binary has executable permissions
try {
  chmodSync(binSource, 0o755);
} catch {
  // Ignore permission errors on Windows or restricted filesystems
}

const binNames = ["opencode-agy", "opencode-antigravity"];
const candidates = [
  process.env.XDG_BIN_HOME,
  join(homedir(), ".local", "bin"),
  join(homedir(), "bin"),
];
const targetDirs = candidates.filter(Boolean);

// Find or create suitable user bin directory
let targetDir = targetDirs[0];
for (const dir of targetDirs) {
  if (existsSync(dir)) {
    targetDir = dir;
    break;
  }
}

if (!targetDir) {
  targetDir = join(homedir(), ".local", "bin");
}

try {
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  for (const name of binNames) {
    const dest = join(targetDir, name);
    try {
      if (existsSync(dest)) {
        unlinkSync(dest);
      }
      symlinkSync(binSource, dest);
      console.log(`✓ Installed ${name} to ${dest}`);
    } catch (err) {
      console.warn(`Could not link ${name} to ${dest}:`, err instanceof Error ? err.message : String(err));
    }
  }
} catch (err) {
  console.warn("Could not install CLI links:", err instanceof Error ? err.message : String(err));
}
