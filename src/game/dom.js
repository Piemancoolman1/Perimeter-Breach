// Every DOM element reference the game touches, gathered in one place so the rest of the
// codebase never calls document.getElementById directly. Pure DOM lookups — no game state.
export const el = {
  landing: document.getElementById("landing"),
  singlePlayerBtn: document.getElementById("singleplayer-btn"),
  multiplayerBtn: document.getElementById("multiplayer-btn"),
  updateBanner: document.getElementById("update-banner"),
  updateBannerText: document.getElementById("update-banner-text"),
  updateInstallBtn: document.getElementById("update-install-btn"),

  multiplayerScreen: document.getElementById("multiplayer-screen"),
  playerNameInput: document.getElementById("player-name-input"),
  mpConnectError: document.getElementById("mp-connect-error"),
  createRoomBtn: document.getElementById("create-room-btn"),
  browseRoomsBtn: document.getElementById("browse-rooms-btn"),
  mpBackBtn: document.getElementById("mp-back-btn"),

  createRoomScreen: document.getElementById("create-room-screen"),
  roomNameInput: document.getElementById("room-name-input"),
  visibilityPublicBtn: document.getElementById("visibility-public-btn"),
  visibilityPrivateBtn: document.getElementById("visibility-private-btn"),
  roomPasswordCreateRow: document.getElementById("room-password-create-row"),
  roomPasswordCreateInput: document.getElementById("room-password-create-input"),
  createRoomError: document.getElementById("create-room-error"),
  createRoomSubmitBtn: document.getElementById("create-room-submit-btn"),
  createRoomBackBtn: document.getElementById("create-room-back-btn"),

  browseRoomsScreen: document.getElementById("browse-rooms-screen"),
  browseError: document.getElementById("browse-error"),
  roomList: document.getElementById("room-list"),
  roomPasswordRow: document.getElementById("room-password-row"),
  roomPasswordRoomName: document.getElementById("room-password-room-name"),
  roomPasswordInput: document.getElementById("room-password-input"),
  roomPasswordJoinBtn: document.getElementById("room-password-join-btn"),
  roomsRefreshBtn: document.getElementById("rooms-refresh-btn"),
  browseBackBtn: document.getElementById("browse-back-btn"),

  roomScreen: document.getElementById("room-screen"),
  roomScreenName: document.getElementById("room-screen-name"),
  roomPlayerList: document.getElementById("room-player-list"),
  matchConfig: document.getElementById("match-config"),
  modeKillsBtn: document.getElementById("mode-kills-btn"),
  modeTimeBtn: document.getElementById("mode-time-btn"),
  modeFfaBtn: document.getElementById("mode-ffa-btn"),
  matchConfigNumberRow: document.getElementById("match-config-number-row"),
  matchConfigNumberLabel: document.getElementById("match-config-number-label"),
  matchConfigNumberInput: document.getElementById("match-config-number-input"),
  mapPicker: document.getElementById("map-picker"),
  mapDescription: document.getElementById("map-description"),
  startMatchBtn: document.getElementById("start-match-btn"),
  leaveRoomBtn: document.getElementById("leave-room-btn"),

  respawnOverlay: document.getElementById("respawn-overlay"),
  respawnTitle: document.getElementById("respawn-title"),
  respawnTimerEl: document.getElementById("respawn-timer"),
  scoreboardPanel: document.getElementById("scoreboard-panel"),
  scoreboardList: document.getElementById("scoreboard-list"),
  endScoreboardList: document.getElementById("end-scoreboard-list"),
  backToRoomBtn: document.getElementById("back-to-room-btn"),

  settingsBtn: document.getElementById("settings-btn"),
  settingsScreen: document.getElementById("settings-screen"),
  settingsBackBtn: document.getElementById("settings-back-btn"),
  hideCrosshairAimingCheckbox: document.getElementById("hide-crosshair-aiming-checkbox"),
  toggleAimCheckbox: document.getElementById("toggle-aim-checkbox"),
  toggleCrouchCheckbox: document.getElementById("toggle-crouch-checkbox"),
  lookSensitivitySlider: document.getElementById("look-sensitivity-slider"),
  lookSensitivityValue: document.getElementById("look-sensitivity-value"),
  scopedSensitivitySlider: document.getElementById("scoped-sensitivity-slider"),
  scopedSensitivityValue: document.getElementById("scoped-sensitivity-value"),
  menu: document.getElementById("menu"),
  classSelectScreen: document.getElementById("class-select-screen"),
  classPicker: document.getElementById("class-picker"),
  classDescription: document.getElementById("class-description"),
  spawnInBtn: document.getElementById("spawn-in-btn"),
  pauseHint: document.getElementById("pause-hint"),
  resumeBtn: document.getElementById("resume-btn"),
  changeClassBtn: document.getElementById("change-class-btn"),
  pauseSettingsBtn: document.getElementById("pause-settings-btn"),
  exitToMenuBtn: document.getElementById("exit-to-menu-btn"),
  endScreen: document.getElementById("end-screen"),
  endTitle: document.getElementById("end-title"),
  endMessage: document.getElementById("end-message"),
  startBtn: document.getElementById("start-btn"),
  restartBtn: document.getElementById("restart-btn"),
  kills: document.getElementById("kills"),
  healthFill: document.getElementById("health-fill"),
  staminaFill: document.getElementById("stamina-fill"),
  weaponLabel: document.getElementById("weapon-label"),
  ammoText: document.getElementById("ammo-text"),
  grenadeCount: document.getElementById("grenade-count"),
  abilityLabel: document.getElementById("ability-label"),
  abilityStatus: document.getElementById("ability-status"),
  reloadIndicator: document.getElementById("reload-indicator"),
  hitFlash: document.getElementById("hit-flash"),
  invincibleVignette: document.getElementById("invincible-vignette"),
  lowHealthVignette: document.getElementById("low-health-vignette"),
  invincibleIndicator: document.getElementById("invincible-indicator"),
  invincibleTimerEl: document.getElementById("invincible-timer"),
  collisionBoxIndicator: document.getElementById("collision-box-indicator"),
  flyModeIndicator: document.getElementById("fly-mode-indicator"),
  crosshair: document.getElementById("crosshair"),
  fullscreenBtn: document.getElementById("fullscreen-btn"),
  scopeVignette: document.getElementById("scope-vignette"),
  hud: document.getElementById("hud"),
  touchControls: document.getElementById("touch-controls"),
  touchLookZone: document.getElementById("touch-look-zone"),
  touchMoveZone: document.getElementById("touch-move-zone"),
  touchJoystickBase: document.getElementById("touch-joystick-base"),
  touchJoystickThumb: document.getElementById("touch-joystick-thumb"),
  touchFireBtn: document.getElementById("touch-fire-btn"),
  touchAimBtn: document.getElementById("touch-aim-btn"),
  touchJumpBtn: document.getElementById("touch-jump-btn"),
  touchAbilityBtn: document.getElementById("touch-ability-btn"),
  touchPauseBtn: document.getElementById("touch-pause-btn"),
  rotateDevicePrompt: document.getElementById("rotate-device-prompt"),
  forceTouchControlsCheckbox: document.getElementById("force-touch-controls-checkbox"),
  debugPanel: document.getElementById("debug-panel"),
  dbgFps: document.getElementById("dbg-fps"),
  dbgFrame: document.getElementById("dbg-frame"),
  dbgCalls: document.getElementById("dbg-calls"),
  dbgTris: document.getElementById("dbg-tris"),
  dbgGeo: document.getElementById("dbg-geo"),
  dbgTex: document.getElementById("dbg-tex"),
  dbgLights: document.getElementById("dbg-lights"),
  dbgEnemies: document.getElementById("dbg-enemies"),
  dbgFx: document.getElementById("dbg-fx"),
  dbgHeap: document.getElementById("dbg-heap"),
};

// Fullscreen toggle — available on every screen (not just in-game), since mobile browser
// chrome (address bar/tab bar) eating into the usable viewport is the whole problem this
// solves, and that's just as true on the landing/lobby screens as it is mid-match. Requires a
// real user gesture to invoke (this click IS one), so it can't be triggered programmatically.
el.fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {
      // Some browsers (older mobile Safari, or a page embedded in an iframe without the
      // allowfullscreen attribute) reject this outright — nothing further to do but leave the
      // button available to try again; the button's own hidden state below already accounts
      // for fullscreenEnabled being false entirely.
    });
  }
});
document.addEventListener("fullscreenchange", () => {
  el.fullscreenBtn.classList.toggle("is-fullscreen", !!document.fullscreenElement);
});
if (!document.fullscreenEnabled) el.fullscreenBtn.style.display = "none";
