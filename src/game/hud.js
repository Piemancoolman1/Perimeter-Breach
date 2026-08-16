import { el } from "./dom.js";
import { STAMINA_MAX } from "./player.js";

export function formatGrenadeCount(n) {
  return Number.isFinite(n) ? String(n) : "∞";
}

// Below this health fraction, the low-health vignette starts fading in; at 0 health it's at
// LOW_HEALTH_VIGNETTE_MAX_OPACITY. Above the threshold it stays fully invisible — full/high
// health shouldn't tint the screen at all, only actually being hurt should.
const LOW_HEALTH_VIGNETTE_THRESHOLD = 0.5;
const LOW_HEALTH_VIGNETTE_MAX_OPACITY = 0.85;

// HUD rendering: the in-match health/ammo/kill readouts, the scoreboard, and the two overlay
// screens (single-player win/lose, multiplayer end-of-match). Reads `ctx.player`/`ctx.loadout`/
// `ctx.scores`/etc fresh every call — all of these are reassigned or mutated in place elsewhere
// (loadMap, resetPlayerState, applyElim, ...), never rebound to a new object main.js would need
// to hand back in here.
export function createHud(ctx) {
  function setHud() {
    const healthFrac = ctx.player.health / ctx.player.maxHealth;
    el.healthFill.style.width = `${healthFrac * 100}%`;
    el.staminaFill.style.width = `${(ctx.player.stamina / STAMINA_MAX) * 100}%`;
    el.staminaFill.classList.toggle("locked", ctx.player.staminaLocked); // dimmer while sprint is locked out, not just regenerating
    const slot = ctx.loadout.current.slot;
    el.weaponLabel.textContent = ctx.loadout.current.def.name;
    el.ammoText.textContent = `${slot.ammo} / ${slot.def.magSize}`;
    el.reloadIndicator.classList.toggle("hidden", !slot.isReloading);
    el.grenadeCount.textContent = formatGrenadeCount(ctx.grenadeCount);

    // Continuous gradient, not a discrete on/off — recomputed every frame straight from current
    // health, so it needs no explicit set/clear calls anywhere (unlike invincibleTimer's vignette,
    // which is a timed state): healing/respawning fades it back out automatically.
    const lowHealthT = Math.max(0, 1 - healthFrac / LOW_HEALTH_VIGNETTE_THRESHOLD);
    el.lowHealthVignette.style.opacity = (lowHealthT * LOW_HEALTH_VIGNETTE_MAX_OPACITY).toFixed(3);
  }

  function showOverlay(title, message, isLose) {
    el.endTitle.textContent = title;
    el.endTitle.classList.toggle("lose", !!isLose);
    el.endMessage.textContent = message;
    el.endScreen.classList.remove("hidden");
  }

  // Shows/hides the HUD, crosshair, and touch-control overlay together as one "are we actually
  // in gameplay right now" unit — three separate call sites each toggling all three individually
  // is exactly the kind of divergence-prone duplication that caused a real bug earlier in this
  // project (a multi-site assignment that `replace_all` only partially updated), so this is one
  // place instead of three. `touchControls`' own visibility is still separately gated by the
  // `touch-controls-active` body class (see touchControls.js) — setting `display: ""` here just
  // defers to that CSS rule rather than forcing it visible on desktop.
  function showGameplayUI() {
    el.hud.style.display = "";
    el.crosshair.style.display = "";
    el.touchControls.style.display = "";
  }
  function hideGameplayUI() {
    el.hud.style.display = "none";
    el.crosshair.style.display = "none";
    el.touchControls.style.display = "none";
  }

  function endGame(won) {
    ctx.state = won ? "won" : "lost";
    ctx.controls.unlock();
    hideGameplayUI();
    if (won) {
      showOverlay("Perimeter Secured", `${ctx.TOTAL_KILLS_TO_WIN} hostiles eliminated. The outpost holds.`, false);
    } else {
      showOverlay("Overrun", "The outpost fell to the assault.", true);
    }
  }

  function renderScoreRows(container) {
    container.innerHTML = "";
    const sorted = [...ctx.scores.entries()].sort((a, b) => b[1].kills - a[1].kills);
    for (const [id, s] of sorted) {
      const li = document.createElement("li");
      li.className = "score-row";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = s.name + (id === ctx.myPlayerId ? " (you)" : "");
      const killsSpan = document.createElement("span");
      killsSpan.className = "score-kills";
      killsSpan.textContent = String(s.kills);
      li.append(nameSpan, killsSpan);
      container.appendChild(li);
    }
  }
  function renderScoreboard() {
    renderScoreRows(el.scoreboardList);
  }
  function renderEndScoreboard() {
    renderScoreRows(el.endScoreboardList);
  }

  function updateKillsHud() {
    const mine = ctx.scores.get(ctx.myPlayerId)?.kills ?? 0;
    el.kills.textContent = ctx.matchConfig?.mode === "killTarget" ? `${mine} / ${ctx.matchConfig.target}` : String(mine);
  }

  return { setHud, showOverlay, showGameplayUI, hideGameplayUI, endGame, renderScoreboard, renderEndScoreboard, updateKillsHud };
}
