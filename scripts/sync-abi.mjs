#!/usr/bin/env node
// Regenerates the frontend ABI copies from the forge artifact.
//
// Two copies ship on purpose: `src/lib/abi.json` is what the app imports,
// `public/abi.json` is the file a user can download and diff against the
// explorer. Both must be byte-identical to each other AND to the contract
// that actually compiles — this script is what keeps that true.
//
//   node scripts/sync-abi.mjs
//
// Exits non-zero if the artifact is missing or the copies drift apart.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = join(root, "out", "EscrowLink.sol", "EscrowLink.json");
const targets = [join(root, "web", "src", "lib", "abi.json"), join(root, "web", "public", "abi.json")];

let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch (e) {
  console.error(`sync-abi: cannot read ${artifactPath}`);
  console.error("sync-abi: run `forge build` first");
  console.error(String(e));
  process.exit(1);
}

if (!Array.isArray(artifact.abi)) {
  console.error("sync-abi: artifact has no abi array");
  process.exit(1);
}

const json = `${JSON.stringify(artifact.abi, null, 2)}\n`;
for (const target of targets) {
  writeFileSync(target, json, "utf8");
  console.log(`sync-abi: wrote ${target}`);
}

// Guard: never let the two copies disagree.
const [a, b] = targets.map((t) => readFileSync(t, "utf8"));
if (a !== b) {
  console.error("sync-abi: the two ABI copies differ after writing");
  process.exit(1);
}
console.log("sync-abi: ok (both copies match the forge artifact)");
