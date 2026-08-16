# Perimeter-Breach

## Releasing a new version

Pushing to `main` just saves source code — nothing reaches players until you
publish a GitHub Release with build artifacts attached to it.

1. **Bump the version** in `src-tauri/tauri.conf.json` (the `"version"` field).

2. **Build it, signed.** The signing key lives at
   `C:\Users\<you>\.tauri\perimeter-breach.key` (outside the repo, never
   committed — back it up somewhere safe; losing it means installed apps can
   no longer trust future updates).

   PowerShell:
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\perimeter-breach.key" -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<the key's actual password>"
   npm run tauri build
   ```
   If the key has no password, use `""` — but if the build fails at the
   "Decrypting updater signing key" step with "Wrong password for that key",
   the key does have one; use the real password there instead.

   This produces both an installer and a `.sig` file under
   `src-tauri/target/release/bundle/nsis/` (and `/msi/`).

3. **Generate the update manifest:**
   ```
   node tools/make-update-manifest.js
   ```
   Writes `latest.json` to the repo root and prints exactly which files to
   upload and what tag to use.

4. **Publish a GitHub Release** at
   [github.com/Piemancoolman1/Perimeter-Breach/releases/new](https://github.com/Piemancoolman1/Perimeter-Breach/releases/new):
   - Tag: `vX.Y.Z` — **must exactly match** the version from step 1, since the
     manifest's download URL is built from it.
   - Attach the two files the script pointed you to: the `...-setup.exe`
     installer and `latest.json`.
   - Publish it as the latest release (not a draft/pre-release).

Once published, every installed copy of the app checks
`.../releases/latest/download/latest.json` on launch and offers a one-click
update if it finds a newer version.

## Testing a build locally, without publishing

Pushing to `main` and even running `npm run tauri build` never reaches
players by itself — only publishing a GitHub Release (step 4 above) does. To
try out a change yourself before deciding to ship it:

- **Fastest — in the browser, no installer:** `npm run dev`, then open the
  printed `localhost` URL. Everything works except anything Tauri-only
  (native updater, window chrome). Good enough for testing gameplay changes
  like a new class, weapon, or ability.
- **As the real desktop app:** `npm run tauri dev` — builds and launches the
  actual Tauri window, hot-reloading against the Vite dev server.
- **A real standalone installer, still local-only:** run step 2's build
  command above (`npm run tauri build`). This produces a working installer at
  `src-tauri/target/release/bundle/nsis/PerimeterBreach_X.Y.Z_x64-setup.exe`
  (and an `.msi` alongside it) that you can hand to someone or install
  yourself directly — none of this touches GitHub or goes live. Skip steps 3
  and 4 entirely unless you actually intend to publish.

## Development

- `npm run dev` — the game as a plain browser page (no installer needed)
- `npm run server` — the multiplayer lobby/relay server (`server/index.js`)
- `npm run tauri dev` — the desktop app, hot-reloading against the Vite dev server
