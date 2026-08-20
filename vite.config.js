import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same version string that drives the packaged app's version (and update-manifest tag) — read
// straight from tauri.conf.json rather than duplicated here, so bumping one place bumps both.
const tauriConf = JSON.parse(readFileSync(resolve(__dirname, "src-tauri/tauri.conf.json"), "utf-8"));

export default defineConfig({
  // Baked into the JS bundle at build time (see src/game/version.js) — unlike the corner
  // version badge (which calls Tauri's getVersion() at runtime specifically to catch a stale
  // in-use .exe that failed to update), this works in a plain browser build too, which is what
  // the multiplayer version-mismatch check needs since a lobby isn't Tauri-specific.
  define: {
    __APP_VERSION__: JSON.stringify(tauriConf.version),
  },
  server: {
    // Lets a Cloudflare quick tunnel (`npm run tunnel:client`, a random *.trycloudflare.com
    // hostname each run) reach the dev server, without disabling Vite's Host-header
    // protection (DNS-rebinding defense) for every possible host.
    allowedHosts: [".trycloudflare.com"],
  },
});
