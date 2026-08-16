// Assembles the `latest.json` manifest the packaged app's auto-updater checks against
// (see src/game/updater.js), from whatever `npm run tauri build` just produced under
// src-tauri/target/release/bundle/. Run this right after a signed build:
//
//   $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content "$env:USERPROFILE\.tauri\perimeter-breach.key" -Raw)
//   npm run tauri build
//   node tools/make-update-manifest.js
//
// Prints the exact GitHub Release tag/files to publish — this script only ever writes
// latest.json locally; publishing the release itself is a manual step (no `gh` CLI/token
// configured in this project), see printed instructions below.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = "Piemancoolman1/Perimeter-Breach";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE_DIR = path.join(ROOT, "src-tauri", "target", "release", "bundle");
const NSIS_DIR = path.join(BUNDLE_DIR, "nsis");

const confPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const version = conf.version;

if (!existsSync(NSIS_DIR)) {
  console.error(`No NSIS bundle directory found at ${NSIS_DIR} — run "npm run tauri build" first.`);
  process.exit(1);
}

// Old builds' installers are never cleaned out of this folder — matching on the current
// version too (not just ".exe") is required, or this silently picks up a stale build.
// `_<version>_` (not a bare substring match) so e.g. version 0.1.1 can't accidentally
// match a 0.1.10 file.
const installerName = readdirSync(NSIS_DIR).find(
  (f) => f.endsWith(".exe") && !f.endsWith(".exe.sig") && f.includes(`_${version}_`)
);
if (!installerName) {
  console.error(`No installer .exe for version ${version} found in ${NSIS_DIR} — run "npm run tauri build" first.`);
  process.exit(1);
}

const sigPath = path.join(NSIS_DIR, `${installerName}.sig`);
if (!existsSync(sigPath)) {
  console.error(
    `Found ${installerName} but no matching .sig file next to it.\n` +
      `The build wasn't signed — set TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD ` +
      `if the key has one) before running "npm run tauri build", then re-run this script.`
  );
  process.exit(1);
}

const signature = readFileSync(sigPath, "utf8").trim();
const tag = `v${version}`;
const downloadUrl = `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(installerName)}`;

const manifest = {
  version,
  notes: `See the GitHub release notes for v${version}.`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: downloadUrl,
    },
  },
};

const outPath = path.join(ROOT, "latest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`Wrote ${outPath}\n`);
console.log(`Now publish a GitHub Release:`);
console.log(`  1. Go to https://github.com/${REPO}/releases/new`);
console.log(`  2. Tag: ${tag}  (must match exactly — the manifest's download URL depends on it)`);
console.log(`  3. Title: whatever you like (e.g. "v${version}")`);
console.log(`  4. Attach these two files:`);
console.log(`       - ${path.join(NSIS_DIR, installerName)}`);
console.log(`       - ${outPath}`);
console.log(`  5. Publish. The updater's endpoint always points at ".../releases/latest/download/latest.json",`);
console.log(`     so as long as this is marked the latest release, installed apps will pick it up automatically.`);
