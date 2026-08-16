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
    // Confirm with more checks, spaced well apart, before ever showing the banner — the
    // very first check(es) right at app boot have repeatedly found an "update" that a
    // check run manually a bit later (by which point DevTools was opened and a command
    // typed — several seconds minimum) always says doesn't exist. That timing signature
    // points at something transient in the app's network stack right at cold start
    // (e.g. DNS resolution not yet warmed up) rather than a real result, so only surface
    // the banner once THREE checks, 5s apart, all agree — cheap here since it only
    // delays the (rare) real-update case, never normal play.
    for (let i = 0; update && i < 2; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      update = await check();
    }
  } catch (err) {
    console.warn("Update check failed", err);
    return;
  }
  if (!update) return;

  el.updateBannerText.textContent = `Update available: v${update.version}`;
  el.updateBanner.classList.remove("hidden");

  el.updateInstallBtn.addEventListener("click", async () => {
    el.updateInstallBtn.disabled = true;
    el.updateInstallBtn.textContent = "Checking...";

    // Re-verify right before actually doing anything, rather than trusting the result
    // from whenever the page first loaded — the startup check has intermittently found
    // an "update" that a check moments later says doesn't exist (looks like GitHub's
    // CDN briefly serving a stale manifest right at boot). Worst case with this guard is
    // a banner that quietly clears itself on click instead of attempting a pointless (or
    // actively wrong) download.
    let fresh;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      fresh = await check();
    } catch (err) {
      console.warn("Update re-check failed", err);
      el.updateInstallBtn.disabled = false;
      el.updateInstallBtn.textContent = "Update & Restart";
      el.updateBannerText.textContent = `Update check failed: ${err?.message ?? err}`;
      return;
    }
    if (!fresh) {
      el.updateBanner.classList.add("hidden");
      return;
    }
    update = fresh;

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
