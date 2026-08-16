import { el } from "./dom.js";

const SETTINGS_KEY = "perimeterBreach.settings";

const DEFAULT_SETTINGS = {
  hideCrosshairWhileAiming: false,
  toggleAim: false,
  toggleCrouch: false,
  lookSensitivity: 1,
  scopedSensitivity: 0.4, // matches this project's pre-existing (formerly hardcoded) scoped-in feel
  forceTouchControls: false, // manual override — lets an ambiguous/hybrid device force touch UI on or off
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const settings = loadSettings();

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Wires the settings screen's checkboxes/sliders to the shared `settings` object above and
// persists on every change. Called once from main.js after `ctx.combat`/`ctx.touchControls`
// exist, since a couple of these change handlers reach into them (see inline comments).
export function createSettingsUi(ctx) {
  el.hideCrosshairAimingCheckbox.checked = settings.hideCrosshairWhileAiming;
  el.toggleAimCheckbox.checked = settings.toggleAim;
  el.toggleCrouchCheckbox.checked = settings.toggleCrouch;
  el.lookSensitivitySlider.value = settings.lookSensitivity;
  el.lookSensitivityValue.textContent = settings.lookSensitivity.toFixed(2);
  el.scopedSensitivitySlider.value = settings.scopedSensitivity;
  el.scopedSensitivityValue.textContent = settings.scopedSensitivity.toFixed(2);
  el.forceTouchControlsCheckbox.checked = settings.forceTouchControls;

  el.hideCrosshairAimingCheckbox.addEventListener("change", () => {
    settings.hideCrosshairWhileAiming = el.hideCrosshairAimingCheckbox.checked;
    saveSettings();
    if (!settings.hideCrosshairWhileAiming) el.crosshair.style.display = "";
  });

  el.toggleAimCheckbox.addEventListener("change", () => {
    settings.toggleAim = el.toggleAimCheckbox.checked;
    saveSettings();
    // Switching modes mid-aim would otherwise leave the player stuck scoped in with no held
    // button to release, or vice versa — clear aim whenever the mode itself changes.
    if (ctx.aimHeld) ctx.combat.setAiming(false);
  });

  el.toggleCrouchCheckbox.addEventListener("change", () => {
    settings.toggleCrouch = el.toggleCrouchCheckbox.checked;
    saveSettings();
    // Same reasoning as the aim-mode switch above — otherwise flipping modes mid-crouch could
    // leave the player stuck crouched forever (still-held C never fires a keyup while in
    // toggle mode, and a toggle-mode press right before the switch never gets a matching
    // "cancel" either) with no way to stand back up short of pressing C again.
    ctx.input.crouch = false;
  });

  el.lookSensitivitySlider.addEventListener("input", () => {
    settings.lookSensitivity = Number(el.lookSensitivitySlider.value);
    el.lookSensitivityValue.textContent = settings.lookSensitivity.toFixed(2);
    saveSettings();
  });

  el.scopedSensitivitySlider.addEventListener("input", () => {
    settings.scopedSensitivity = Number(el.scopedSensitivitySlider.value);
    el.scopedSensitivityValue.textContent = settings.scopedSensitivity.toFixed(2);
    saveSettings();
  });

  el.forceTouchControlsCheckbox.addEventListener("change", () => {
    settings.forceTouchControls = el.forceTouchControlsCheckbox.checked;
    saveSettings();
    ctx.touchControls.setForced(settings.forceTouchControls);
  });

  let settingsReturnTo = el.landing;
  el.settingsBtn.addEventListener("click", () => {
    settingsReturnTo = el.landing;
    el.landing.classList.add("hidden");
    el.settingsScreen.classList.remove("hidden");
  });

  el.pauseSettingsBtn.addEventListener("click", () => {
    settingsReturnTo = el.pauseHint;
    el.pauseHint.classList.add("hidden");
    el.settingsScreen.classList.remove("hidden");
  });

  el.settingsBackBtn.addEventListener("click", () => {
    el.settingsScreen.classList.add("hidden");
    settingsReturnTo.classList.remove("hidden");
  });
}
