#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const files = [
  "package.json",
  "README.md",
  "scripts/check-installed-cache.mjs",
  "src/index.ts",
  "src/domain/async-queue.ts",
  "src/domain/atomic-write.ts",
  "src/domain/error-reporter.ts",
  "src/domain/pane-info.ts",
  "src/domain/pane-key.ts",
  "src/domain/state.ts",
  "src/domain/status.ts",
];

const installedRoot = join(homedir(), ".pi", "agent", "git", "github.com", "patlux", "pi-tmux-session-map");

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!existsSync(installedRoot)) {
  console.log(`installed cache not present: ${installedRoot}`);
  process.exit(0);
}

const mismatches = [];
for (const file of files) {
  const source = join(process.cwd(), file);
  const installed = join(installedRoot, file);
  if (!existsSync(installed)) {
    mismatches.push(`${file}: missing from installed cache`);
    continue;
  }
  if (hash(source) !== hash(installed)) {
    mismatches.push(`${file}: differs from installed cache`);
  }
}

if (mismatches.length > 0) {
  console.error(`installed cache is stale at ${installedRoot}`);
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log(`installed cache matches source: ${installedRoot}`);
