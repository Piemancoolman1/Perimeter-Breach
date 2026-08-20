// The running build's version, baked in at build time by vite.config.js's `define`. Used for
// the multiplayer version-mismatch check (lobbyClient.js/server) — NOT the same thing as the
// corner version badge (updater.js's showAppVersion), which calls Tauri's getVersion() API at
// runtime specifically to catch a stale in-use .exe that failed to update. This constant is
// just "which JS bundle is this," which is exactly what matters for two peers' game logic
// actually being compatible, and it works in a plain browser build too, unlike the Tauri API.
export const APP_VERSION = __APP_VERSION__;
