# tools/

`cloudflared.exe` lives here but isn't committed to git (it's a ~55MB downloaded
binary, not source). Fetch it with:

```
curl -L -o tools/cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```

Used by two scripts to expose local dev servers to the internet over HTTPS/WSS via
Cloudflare quick tunnels — no port forwarding, router config, or domain required:

- `npm run tunnel:server` — tunnels the lobby server (`npm run server`, port 8787).
  Set the printed `https://...trycloudflare.com` URL (as `wss://...`) as `VITE_WS_URL`
  in `.env.local` so the client connects through it instead of `localhost:8787`.
- `npm run tunnel:client` — tunnels the game itself (`npm run dev`, port 5173). This is
  the URL to actually open on a phone or another device.

Both print a random hostname that changes every time the tunnel restarts — re-share it
each session. `vite.config.js` allows any `*.trycloudflare.com` host through Vite's dev
server (which otherwise rejects unrecognized `Host` headers as a DNS-rebinding
defense) so the client tunnel can reach it at all.

See the main README (once the repo exists) for upgrading to a permanent, stable
subdomain via a named Cloudflare Tunnel once you have a domain.
