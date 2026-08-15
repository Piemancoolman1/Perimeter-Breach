import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Lets a Cloudflare quick tunnel (`npm run tunnel:client`, a random *.trycloudflare.com
    // hostname each run) reach the dev server, without disabling Vite's Host-header
    // protection (DNS-rebinding defense) for every possible host.
    allowedHosts: [".trycloudflare.com"],
  },
});
