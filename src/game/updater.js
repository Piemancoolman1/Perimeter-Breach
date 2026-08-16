import { el } from "./dom.js";

// Checks for a newer packaged-app release once on startup. `__TAURI_INTERNALS__` is the
// low-level bridge every Tauri webview injects (regardless of whether the convenience
// `window.__TAURI__` global is enabled) — its absence means this is the plain browser
// dev server or a plain web build, where there's nothing to update, so this is a no-op
// there rather than a real check. Surfaced as a small banner on the landing screen
// (matching this project's existing HTML/CSS-driven UI, e.g. the multiplayer error
// banners) instead of a native dialog plugin, to avoid a second UI paradigm just for this.
export async function checkForUpdate() {
  if (!("__TAURI_INTERNALS__" in window)) return;

  let update;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    update = await check();
  } catch (err) {
    console.warn("Update check failed", err);
    return;
  }
  if (!update) return;

  el.updateBannerText.textContent = `Update available: v${update.version}`;
  el.updateBanner.classList.remove("hidden");

  el.updateInstallBtn.addEventListener("click", async () => {
    el.updateInstallBtn.disabled = true;
    el.updateInstallBtn.textContent = "Installing...";
    try {
      await update.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.warn("Update install failed", err);
      el.updateInstallBtn.disabled = false;
      el.updateInstallBtn.textContent = "Update & Restart";
      el.updateBannerText.textContent = "Update failed — try again later.";
    }
  });
}
