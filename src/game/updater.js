import { el } from "./dom.js";

// Shows the actual running app version in a corner of every screen — the ground truth
// for "which build is this," since NSIS can silently fail to replace a running .exe
// (Windows won't let an in-use file be overwritten) and there was otherwise no way to
// tell which version was actually launched versus which installer was last run.
export async function showAppVersion() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    el.appVersion.textContent = `v${await getVersion()}`;
    el.appVersion.classList.remove("hidden");
  } catch (err) {
    console.warn("Could not read app version", err);
  }
}

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
    el.updateInstallBtn.textContent = "Downloading...";
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((ev) => {
        switch (ev.event) {
          case "Started":
            total = ev.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += ev.data.chunkLength;
            el.updateInstallBtn.textContent = total
              ? `Downloading... ${Math.round((downloaded / total) * 100)}%`
              : `Downloading... ${(downloaded / 1e6).toFixed(1)}MB`;
            break;
          case "Finished":
            el.updateInstallBtn.textContent = "Installing...";
            break;
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      // Shown directly in the banner, not just console.warn'd — a release build has no
      // devtools open by default, so a user hitting this has no other way to see why.
      console.warn("Update install failed", err);
      el.updateInstallBtn.disabled = false;
      el.updateInstallBtn.textContent = "Update & Restart";
      el.updateBannerText.textContent = `Update failed: ${err?.message ?? err}`;
    }
  });
}
