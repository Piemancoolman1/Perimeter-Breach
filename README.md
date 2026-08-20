# Perimeter-Breach

## Releasing a new version

Pushing to `main` just saves source code — nothing reaches players until you
publish a GitHub Release with build artifacts attached to it.

1. **Bump the version** in `src-tauri/tauri.conf.json` (the `"version"` field), and add a
   matching entry to `PATCH_NOTES` in `src/game/patchNotes.js` (`{ version, date, highlights: [...] }`,
   prepended so the array stays newest-first). This is what powers the in-game Patch Notes screen
   and, eventually, a public changelog page — write it now, as the version is built, not
   reconstructed later from commit history. Never edit or remove an existing entry once added;
   it's meant to be a permanent, append-only history.

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

## Hosting multiplayer for friends and family (self-hosted, current setup)

The server (`server/index.js`) runs the WebSocket lobby/relay *and* the accounts/stats HTTP API
on one port. For now this runs on your own machine — no cloud hosting — reached via a
**Tailscale Funnel**, which gives it a stable public address that doesn't change every time you
restart it (unlike the old Cloudflare Quick Tunnel approach, whose random URL changing on every
restart caused real connection bugs — see `tools/cloudflared.exe`'s `tunnel:server`/`tunnel:client`
scripts, still there for quick one-off tests on a machine without Tailscale, but not what to use
for ongoing hosting anymore).

**One-time setup** (already done on this machine):
1. Install Tailscale (`winget install --id Tailscale.Tailscale -e`) and sign in
   (`tailscale up`, opens a browser to authenticate — any account works).
2. Enable Funnel for your tailnet once, from the link `tailscale funnel` prints the first time
   (a one-time toggle in the Tailscale admin console).
3. `tailscale funnel --bg 8787` — exposes the server's port publicly in the background,
   persisting across reboots/logins. Find your stable address any time with
   `tailscale funnel status`; it looks like `https://<device>.<tailnet>.ts.net`.

**Every time you want the server up:**
```
npm run server
```
That's it — Funnel is already running in the background and pointed at port 8787, so as soon as
the server process is listening, `https://<device>.<tailnet>.ts.net` (HTTP) and
`wss://<device>.<tailnet>.ts.net` (WebSocket) are both reachable from anywhere on the internet,
no port forwarding or router config needed.

**Building the app to actually share with friends**: update `.env.local`'s `VITE_WS_URL`
(`wss://...`) and `VITE_API_URL` (`https://...`) to your Funnel address, then follow "Testing a
build locally, without publishing" above to produce a real installer — that's what you hand to
friends/family, not the raw dev server.

If this ever needs to move to a real always-on cloud host (e.g. once it's not just trusted
friends/family anymore), Fly.io is the recommended target — cheap, no cold starts, and Neon
already covers the database side regardless of where the server itself runs.

## Development

- `npm run dev` — the game as a plain browser page (no installer needed)
- `npm run server` — the multiplayer lobby/relay server + accounts/stats API (`server/index.js`)
- `npm run migrate` — apply any new `server/migrations/*.sql` files to the Neon database
- `npm run tauri dev` — the desktop app, hot-reloading against the Vite dev server
