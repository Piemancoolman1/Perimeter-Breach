import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import {
  buildWorld,
  MAPS,
  DEFAULT_MAP_ID,
  setHitboxesVisible,
  buildShieldWall,
  removeShieldWall,
  buildMineMesh,
  buildReconMarkerSprite,
} from "./game/world.js";
import { Player, EYE_HEIGHT, STAMINA_MAX } from "./game/player.js";
import { Enemy, randomSpawnPoint, breakApartEnemy } from "./game/entities.js";
import { updateCorpseParts, sharedHumanoidParts, buildHumanoidBody, breakApartHumanoid } from "./game/humanoidParts.js";
import { RemotePlayer } from "./game/remotePlayer.js";
import { Loadout } from "./game/loadout.js";
import { GRENADE_DEF, WEAPON_DEFS, CLASSES } from "./game/weaponDefs.js";
import { Grenade, Rocket, splashDamageEnemies, splashDamagePlayer, predictGrenadeArc } from "./game/projectiles.js";
import { GrenadeHeldView } from "./game/grenadeView.js";
import { DebugGraphs } from "./game/debugGraph.js";
import { SoundBank } from "./game/audio.js";
import { LobbyClient } from "./net/lobbyClient.js";
import { TouchControls } from "./game/touchControls.js";
import "./style.css";

const TOTAL_KILLS_TO_WIN = 20;
const MAX_ENEMIES = 5;
const ENEMY_RESPAWN_DELAY = 4.5;
const BASE_FOV = 75;
const INFINITE_GRENADES = true; // testing — flip off for normal supply-limited play
const MENU_CAM_HEIGHT = 55;
const MENU_CAM_RADIUS = 42;
const MENU_CAM_ORBIT_SPEED = 0.05; // rad/s — slow drift, ~125s per revolution

function formatGrenadeCount(n) {
  return Number.isFinite(n) ? String(n) : "∞";
}

const canvas = document.getElementById("scene");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.03, 300);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", handleResize);
// Mobile browsers (Safari in particular) resize the *visible* viewport as the address bar/tab
// bar animates in and out, without reliably firing a plain "resize" event — visualViewport's
// own resize event is the correct signal for that. Without this, the canvas/camera can end up
// sized for a taller viewport than what's actually visible, stretching the render and shifting
// the crosshair away from true screen-center (raycasts fire from NDC (0,0), which is only the
// visual center if the canvas's actual displayed size matches what it was rendered at).
window.visualViewport?.addEventListener("resize", handleResize);

// Without an explicit webglcontextlost handler that calls preventDefault(), a lost context
// (common on mobile under memory/thermal pressure — reproduced directly in this project's own
// headless-Chrome test tooling) is NEVER automatically restored; the page just silently stops
// rendering forever, indistinguishable from a full freeze, until the user manually reloads.
// Reloading here is a deliberate, simple recovery — reconstructing every GPU resource (textures,
// geometries, shaders across 4 maps) by hand after a real restoration event is far more failure-
// prone than just starting over, and this is a casual game where losing an in-progress match to
// an already-rare context loss is an acceptable trade for actually recovering instead of hanging.
renderer.domElement.addEventListener(
  "webglcontextlost",
  (e) => {
    e.preventDefault();
    console.warn("WebGL context lost — reloading to recover.");
    window.location.reload();
  },
  false
);

// The active map's meshes/lighting/fog + collision data — rebuilt by loadMap() whenever a
// match starts with a different map selected, so `obstacles`/`obstacleMeshes` must be `let`
// rather than `const`: everything below that reads them (player/enemy/projectile updates,
// hitscan raycasts) reads the current binding fresh each call, so reassigning here is enough
// to swap every consumer over to the new map with no other changes needed.
let currentMapId = DEFAULT_MAP_ID;
let world = buildWorld(scene, currentMapId);
let obstacles = world.obstacles;
let obstacleMeshes = obstacles.map((o) => o.hitboxMesh).filter(Boolean);

// Dev tool (F4): shows every obstacle's actual collision box as a wireframe, so a misaligned
// hitbox is visible directly rather than inferred from where bullets/movement seem to land.
let showCollisionBoxes = false;

function loadMap(mapId) {
  if (mapId === currentMapId) return;
  world.dispose();
  currentMapId = mapId;
  world = buildWorld(scene, currentMapId);
  obstacles = world.obstacles;
  obstacleMeshes = obstacles.map((o) => o.hitboxMesh).filter(Boolean);
  // A fresh buildWorld() call makes new hitbox meshes, which default to hidden same as
  // always — reapply the overlay's current on/off state so it survives a map switch.
  setHitboxesVisible(obstacles, showCollisionBoxes);
}

const player = new Player(camera);
const controls = new PointerLockControls(camera, document.body);
scene.add(controls.object);
const loadout = new Loadout(camera);
const grenadeHeldView = new GrenadeHeldView(camera);
let fovKick = 0;
let aimHeld = false;
let leftMouseHeld = false;

let grenadeCount = INFINITE_GRENADES ? Infinity : GRENADE_DEF.count;
let grenadeCooldown = 0;
let grenadeHeld = false;
let grenadeHeldTime = 0;
const grenades = [];
const rockets = [];
const remoteRockets = []; // visual-only echoes of a peer's bazooka shot — never deals damage locally

const trajectoryLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85 })
);
trajectoryLine.visible = false;
scene.add(trajectoryLine);

const enemies = [];
const pendingSpawns = [];
const corpseParts = [];

const input = { forward: false, back: false, left: false, right: false, jumpQueued: false, sprint: false, up: false, crouch: false };

const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);
// PointerLockControls tracks look direction internally with Euler order 'YXZ', but
// camera.rotation (an Object3D's own Euler, default order 'XYZ') decodes the SAME
// quaternion differently once there's any pitch — reading camera.rotation.y directly
// gave remote players a yaw that only ever swept ±~80° before reversing instead of
// completing a full turn. Re-extracting with the matching 'YXZ' order fixes it —
// verified numerically against a simulated 360° turn before relying on it here.
const networkYawEuler = new THREE.Euler(0, 0, 0, "YXZ");
function getNetworkYaw() {
  networkYawEuler.setFromQuaternion(camera.quaternion, "YXZ");
  return networkYawEuler.y;
}
// Same decomposition also gives the current up/down look angle (positive = looking up,
// same convention PointerLockControls itself uses internally) — broadcast alongside yaw so
// peers can tilt a RemotePlayer's head/arms to show roughly where someone is aiming.
function getNetworkPitch() {
  networkYawEuler.setFromQuaternion(camera.quaternion, "YXZ");
  return networkYawEuler.x;
}

const el = {
  landing: document.getElementById("landing"),
  singlePlayerBtn: document.getElementById("singleplayer-btn"),
  multiplayerBtn: document.getElementById("multiplayer-btn"),

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

const settings = loadSettings();
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (!settings.hideCrosshairWhileAiming) el.crosshair.style.display = "";
});

el.toggleAimCheckbox.addEventListener("change", () => {
  settings.toggleAim = el.toggleAimCheckbox.checked;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  // Switching modes mid-aim would otherwise leave the player stuck scoped in with no held
  // button to release, or vice versa — clear aim whenever the mode itself changes.
  if (aimHeld) setAiming(false);
});

el.toggleCrouchCheckbox.addEventListener("change", () => {
  settings.toggleCrouch = el.toggleCrouchCheckbox.checked;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  // Same reasoning as the aim-mode switch above — otherwise flipping modes mid-crouch could
  // leave the player stuck crouched forever (still-held C never fires a keyup while in
  // toggle mode, and a toggle-mode press right before the switch never gets a matching
  // "cancel" either) with no way to stand back up short of pressing C again.
  input.crouch = false;
});

el.lookSensitivitySlider.addEventListener("input", () => {
  settings.lookSensitivity = Number(el.lookSensitivitySlider.value);
  el.lookSensitivityValue.textContent = settings.lookSensitivity.toFixed(2);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
});

el.scopedSensitivitySlider.addEventListener("input", () => {
  settings.scopedSensitivity = Number(el.scopedSensitivitySlider.value);
  el.scopedSensitivityValue.textContent = settings.scopedSensitivity.toFixed(2);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
});

el.forceTouchControlsCheckbox.addEventListener("change", () => {
  settings.forceTouchControls = el.forceTouchControlsCheckbox.checked;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  touchControls.setForced(settings.forceTouchControls);
});

// Touch is a pure input-translation layer (see touchControls.js) — every button callback below
// is the exact same function keyboard/mouse already call, not new gameplay logic.
const touchControls = new TouchControls({
  camera,
  controls,
  input,
  moveZone: el.touchMoveZone,
  lookZone: el.touchLookZone,
  joystickBase: el.touchJoystickBase,
  joystickThumb: el.touchJoystickThumb,
  buttons: {
    fire: { el: el.touchFireBtn, onStart: handleFireStart, onEnd: handleFireEnd, dragToAim: true },
    aim: { el: el.touchAimBtn, onStart: handleAimStart, onEnd: handleAimEnd },
    jump: { el: el.touchJumpBtn, onStart: () => { input.jumpQueued = true; } },
    ability: { el: el.touchAbilityBtn, onStart: () => useAbility() },
    pause: { el: el.touchPauseBtn, onStart: () => enterPausedState() },
  },
  forced: settings.forceTouchControls,
});

// Landscape-only while actually playing (per confirmed mobile-controls scope) — the touch
// joystick/button layout assumes a wide screen. Menus/lobby screens are plain centered panels
// that work fine in portrait, so this deliberately only blocks the in-game state, not browsing.
const portraitMedia = window.matchMedia("(orientation: portrait)");
function updateRotatePrompt() {
  const shouldShow = touchControls.active && portraitMedia.matches && state === "playing";
  el.rotateDevicePrompt.classList.toggle("hidden", !shouldShow);
}
portraitMedia.addEventListener("change", updateRotatePrompt);

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

const sounds = new SoundBank();
sounds
  .loadAll([
    ["footstep", "/sounds/footstep.mp3"],
    ["fire_pistol", "/sounds/fire_pistol.mp3"],
    ["fire_ak47", "/sounds/fire_ak47.mp3"],
    ["fire_sniper", "/sounds/fire_sniper.mp3"],
    ["fire_bazooka", "/sounds/fire_bazooka.mp3"],
    ["hitmarker", "/sounds/hitmarker.mp3"],
    ["explosion", "/sounds/explosion.mp3"],
  ])
  .catch((err) => console.warn("Some sounds failed to load", err));

// Mute this tab's audio whenever it's not the one currently in view — otherwise two windows
// open side by side (the normal way to test multiplayer solo) leak sounds from whichever one
// isn't focused into whatever you're actually listening to.
document.addEventListener("visibilitychange", () => {
  sounds.setTabMuted(document.hidden);
});

let footstepTimer = 0;
const FOOTSTEP_INTERVAL = 0.33;
const FOOTSTEP_SPRINT_INTERVAL = 0.22;
const FOOTSTEP_SLICE = 0.14;

const debugGraphs = new DebugGraphs({
  frameCanvas: document.getElementById("dbg-graph-frame"),
  geoCanvas: document.getElementById("dbg-graph-geo"),
  loadCanvas: document.getElementById("dbg-graph-load"),
  frameLegendEl: document.getElementById("dbg-graph-legend"),
  geoLegendEl: document.getElementById("dbg-geo-legend"),
  loadLegendEl: document.getElementById("dbg-load-legend"),
});

let state = "menu"; // menu | playing | paused | won | lost
let showMenuBackdrop = true; // true while an aerial map flyover should render behind menu/settings overlays
loadout.setForceHidden(true); // no gun/player visible over the menu backdrop until a match actually starts
let kills = 0;

let debugVisible = false;
let activeFx = 0;
const frameTimes = [];
let frameMaxMs = 0;
let frameMaxResetAt = 0;
let debugUpdateAccum = 0;

function spawnEnemy() {
  const { x, z } = randomSpawnPoint(14);
  enemies.push(new Enemy(scene, x, z));
}

// Shared by single-player reset and multiplayer match start/respawn — everything about
// the local player's own state that has nothing to do with AI enemies or the kill counter.
function resetPlayerState(x, z, y = 1.7) {
  player.health = player.maxHealth;
  player.velocity.set(0, 0, 0);
  player.onGround = true;
  player.jumpsUsed = 0;
  camera.position.set(x, y, z);
  camera.rotation.set(0, 0, 0);
  fovKick = 0;
  aimHeld = false;
  input.crouch = false; // otherwise a toggle-crouch left on could spawn/respawn the player stuck crouched
  player.crouching = false;
  player.eyeHeight = EYE_HEIGHT; // reset instantly (no lerp) so respawn doesn't visibly crouch-transition from wherever it last was
  player.stamina = STAMINA_MAX;
  player.staminaLocked = false;
  leftMouseHeld = false;
  controls.pointerSpeed = settings.lookSensitivity;
  el.scopeVignette.classList.add("hidden");

  loadout.reset();
  stopHoldingGrenade();

  grenadeCount = INFINITE_GRENADES ? Infinity : GRENADE_DEF.count;
  grenadeCooldown = 0;
  abilityCooldownRemaining = 0; // fresh life, ability immediately available again — matches the full-ammo reset above
  el.grenadeCount.textContent = formatGrenadeCount(grenadeCount);
  for (const g of grenades) g.destroy();
  grenades.length = 0;
  for (const r of rockets) r.destroy();
  rockets.length = 0;
}

function resetGame() {
  kills = 0;
  el.kills.textContent = `0 / ${TOTAL_KILLS_TO_WIN}`;
  resetPlayerState(0, 8);

  for (const e of enemies) e.die(scene);
  enemies.length = 0;
  pendingSpawns.length = 0;
  for (const p of corpseParts) if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
  corpseParts.length = 0;
  clearAllAbilityEffects();
  for (let i = 0; i < 3; i++) spawnEnemy();
}

function setHud() {
  el.healthFill.style.width = `${(player.health / player.maxHealth) * 100}%`;
  el.staminaFill.style.width = `${(player.stamina / STAMINA_MAX) * 100}%`;
  el.staminaFill.classList.toggle("locked", player.staminaLocked); // dimmer while sprint is locked out, not just regenerating
  const slot = loadout.current.slot;
  el.weaponLabel.textContent = loadout.current.def.name;
  el.ammoText.textContent = `${slot.ammo} / ${slot.def.magSize}`;
  el.reloadIndicator.classList.toggle("hidden", !slot.isReloading);
  el.grenadeCount.textContent = formatGrenadeCount(grenadeCount);
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
  state = won ? "won" : "lost";
  controls.unlock();
  hideGameplayUI();
  if (won) {
    showOverlay("Perimeter Secured", `${TOTAL_KILLS_TO_WIN} hostiles eliminated. The outpost holds.`, false);
  } else {
    showOverlay("Overrun", "The outpost fell to the assault.", true);
  }
}

el.singlePlayerBtn.addEventListener("click", () => {
  el.landing.classList.add("hidden");
  el.menu.classList.remove("hidden");
});

// --- Multiplayer lobby ---------------------------------------------------------------
// Room creation/browsing/joining only, over a plain WebSocket to a small local lobby
// server (see server/index.js) — no live gameplay sync yet, that's a separate pass.
// This whole block only ever touches its own 5 overlay screens (never `state`, since
// the match itself never actually starts here — "Start Match" is a disabled placeholder).

const PLAYER_NAME_KEY = "perimeterBreach.playerName";
const mpScreens = [el.landing, el.multiplayerScreen, el.createRoomScreen, el.browseRoomsScreen, el.roomScreen];

function showMpScreen(target) {
  for (const s of mpScreens) s.classList.toggle("hidden", s !== target);
}

function loadPlayerName() {
  try {
    return localStorage.getItem(PLAYER_NAME_KEY) || "";
  } catch {
    return "";
  }
}
function savePlayerName(name) {
  try {
    localStorage.setItem(PLAYER_NAME_KEY, name);
  } catch {
    /* localStorage unavailable — name just won't persist across reloads */
  }
}

function setMpError(errorEl, message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}
function clearMpError(errorEl) {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

function getPlayerNameOrError(errorEl) {
  const name = el.playerNameInput.value.trim();
  if (!name) {
    setMpError(errorEl, "Enter a name first.");
    return null;
  }
  savePlayerName(name);
  return name;
}

let lobby = null;
let activeErrorEl = el.mpConnectError;
let rooms = [];
let selectedRoomId = null;
let creatingPublic = true;
let currentRoom = null;
let currentPlayers = [];
let myPlayerId = null;

// --- PvP match state -------------------------------------------------------------------
let inMatch = false; // true once a match is actually running (vs just sitting in the room)
let hostMatchMode = "killTarget"; // killTarget | timeLimit | freeForAll — picked on the room screen
let hostMapId = DEFAULT_MAP_ID; // also picked on the room screen, host-only
let matchConfig = null; // {mode, target} | {mode, timeLimitSec} | {mode: "freeForAll"}
let matchStartedAt = 0; // server Date.now() from match_started — shared start reference
const remotePlayers = new Map(); // peer id -> RemotePlayer
const camRight = new THREE.Vector3(); // recomputed once per frame — see health-bar update below

// --- Class select ------------------------------------------------------------------------
let selectedClassId = CLASSES.find((c) => c.weaponId === "ak47")?.id ?? CLASSES[0].id; // matches Loadout's old always-AK47 default
// true = Spawn In should fully reset (resetGame()/spawnIntoMatch(), the initial-spawn path);
// false = single-player mid-game class change only — just swap the weapon and resume in
// place, no repositioning/health/kills reset. Multiplayer ignores this flag entirely and
// always fully respawns via spawnIntoMatch() (see the Spawn In click handler) regardless of
// whether this is the very first spawn or a later mid-match change — both are "appear fresh
// somewhere new" there, so there's nothing for this flag to distinguish.
let classSelectSpawnFresh = true;

// --- Class abilities (Q) --------------------------------------------------------------
const DASH_SPEED = 34; // vs WALK_SPEED 6.5 / sprint ~10.4 — a genuinely dramatic burst (>5x walk
// speed), reined back in by the same ACCEL-based damping normal movement already uses (see
// Player.dash). First attempt (16, ~2.5x walk) read as barely-there; this is a real launch.
const SHIELD_PLACE_DISTANCE = 2.2; // how far in front of the player the wall's center lands
const SHIELD_DURATION = 12;
const RECON_PULSE_DURATION = 6;
const MINE_TRIGGER_RADIUS = 2.2;
const MINE_BLAST_RADIUS = 4;
const MINE_DAMAGE = 100;
const MINE_MAX_LIFETIME = 45; // safety net if it's never triggered (e.g. owner disconnects)

let abilityCooldownRemaining = 0;
let abilityIdCounter = 0; // -> unique per-shield/mine ids, combined with myPlayerId/"sp"

// Every entry here (shields, mines) is tracked *regardless of whose it is* — including ones
// placed by peers, synced via relay so this client's own collision/hitscan actually respects
// them (see buildShieldWall's comment for why that's the whole point). `remaining` counts
// down locally for every entry the same way, own or not, as a fallback expiry independent of
// the network message that's supposed to remove it (see the per-frame update loop) — so a
// dropped message or a disconnected owner doesn't leave something stuck forever.
const activeShields = new Map(); // id -> { entry, mesh, hitboxMesh, ownerId, remaining }
const activeMines = new Map(); // id -> { mesh, x, z, ownerId, remaining }
const activeReconMarkers = []; // [{ sprite, targetGroup, remaining }]

const scores = new Map(); // player id -> { name, kills }
let posBroadcastAccum = 0;
const POS_TICK_INTERVAL = 1 / 15;
let respawnTimer = 0; // >0 while dead and waiting to respawn
let lastKillerName = "";
let scoreboardVisible = false;

function amIHost() {
  return currentPlayers.find((p) => p.id === myPlayerId)?.isHost ?? false;
}

function disconnectLobby() {
  if (lobby) lobby.disconnect();
  lobby = null;
}

function renderRoomList() {
  el.roomList.innerHTML = "";
  if (rooms.length === 0) {
    const p = document.createElement("p");
    p.className = "room-list-empty";
    p.textContent = "No rooms yet — create one!";
    el.roomList.appendChild(p);
    return;
  }
  for (const room of rooms) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "room-row" + (room.id === selectedRoomId ? " selected" : "");

    const nameSpan = document.createElement("span");
    nameSpan.className = "room-row-name";
    nameSpan.appendChild(document.createTextNode(room.name));
    if (!room.isPublic) {
      const badge = document.createElement("span");
      badge.className = "room-lock-badge";
      badge.textContent = "PRIVATE";
      nameSpan.appendChild(badge);
    }

    const countSpan = document.createElement("span");
    countSpan.className = "room-row-count";
    countSpan.textContent = `${room.playerCount}/${room.maxPlayers}`;

    row.append(nameSpan, countSpan);
    row.addEventListener("click", () => selectRoom(room));
    el.roomList.appendChild(row);
  }
}

function attemptJoinRoom(roomId, password) {
  activeErrorEl = el.browseError;
  clearMpError(el.browseError);
  lobby.joinRoom({ roomId, password, playerName: loadPlayerName() });
}

function selectRoom(room) {
  clearMpError(el.browseError);
  if (room.isPublic) {
    selectedRoomId = null;
    el.roomPasswordRow.classList.add("hidden");
    el.roomPasswordJoinBtn.classList.add("hidden");
    attemptJoinRoom(room.id, "");
  } else {
    selectedRoomId = room.id;
    el.roomPasswordRoomName.textContent = room.name;
    el.roomPasswordInput.value = "";
    el.roomPasswordRow.classList.remove("hidden");
    el.roomPasswordJoinBtn.classList.remove("hidden");
    renderRoomList(); // refresh the "selected" highlight
  }
}

function renderRoomScreen() {
  el.roomScreenName.textContent = currentRoom ? currentRoom.name : "Room";
  el.roomPlayerList.innerHTML = "";
  for (const p of currentPlayers) {
    const li = document.createElement("li");
    li.className = "player-row";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name + (p.id === myPlayerId ? " (you)" : "");
    li.appendChild(nameSpan);
    if (p.isHost) {
      const badge = document.createElement("span");
      badge.className = "host-badge";
      badge.textContent = "HOST";
      li.appendChild(badge);
    }
    el.roomPlayerList.appendChild(li);
  }

  const iAmHost = amIHost();
  el.matchConfig.classList.toggle("hidden", !iAmHost);
  el.startMatchBtn.disabled = !iAmHost;
  el.startMatchBtn.textContent = iAmHost ? "Start Match" : "Waiting for host to start...";
}

function setupLobbyCallbacks(client) {
  client.onRoomList = (list) => {
    rooms = list;
    renderRoomList();
  };
  client.onJoined = (msg) => {
    currentRoom = msg.room;
    currentPlayers = msg.players;
    myPlayerId = msg.you.id;
    renderRoomScreen();
    showMpScreen(el.roomScreen);
  };
  client.onPlayerJoined = (player) => {
    currentPlayers.push(player);
    renderRoomScreen();
  };
  client.onPlayerLeft = (id) => {
    currentPlayers = currentPlayers.filter((p) => p.id !== id);
    renderRoomScreen();
    // If they'd disconnected from the room entirely mid-match (not just left the match
    // via the pause menu, which sends its own "left_match" relay), drop their avatar too.
    const rp = remotePlayers.get(id);
    if (rp) {
      rp.destroy(scene);
      remotePlayers.delete(id);
    }
  };
  client.onHostChanged = (id) => {
    currentPlayers = currentPlayers.map((p) => ({ ...p, isHost: p.id === id }));
    renderRoomScreen();
  };
  client.onError = (message) => setMpError(activeErrorEl, message);
  client.onDisconnected = () => {
    const wasMidFlow = [el.createRoomScreen, el.browseRoomsScreen, el.roomScreen].some(
      (s) => !s.classList.contains("hidden")
    );
    lobby = null;
    if (wasMidFlow || inMatch) {
      currentRoom = null;
      currentPlayers = [];
      if (inMatch) endMatchAbruptly();
      showMpScreen(el.multiplayerScreen);
      setMpError(el.mpConnectError, "Disconnected from the multiplayer server.");
    }
  };
  client.onMatchStarted = (config, startedAt) => beginMatch(config, startedAt);
  client.onRelay = (from, payload) => handleRelay(from, payload);
}

async function ensureLobbyConnected() {
  if (lobby && lobby.ws) return true;
  const client = new LobbyClient();
  setupLobbyCallbacks(client);
  try {
    await client.connect();
    lobby = client;
    return true;
  } catch {
    return false;
  }
}

el.multiplayerBtn.addEventListener("click", () => {
  el.playerNameInput.value = loadPlayerName();
  clearMpError(el.mpConnectError);
  showMpScreen(el.multiplayerScreen);
});

el.mpBackBtn.addEventListener("click", () => {
  disconnectLobby();
  showMpScreen(el.landing);
});

el.createRoomBtn.addEventListener("click", () => {
  activeErrorEl = el.mpConnectError;
  const name = getPlayerNameOrError(el.mpConnectError);
  if (!name) return;
  el.roomNameInput.value = "";
  creatingPublic = true;
  el.visibilityPublicBtn.classList.add("selected");
  el.visibilityPrivateBtn.classList.remove("selected");
  el.roomPasswordCreateRow.classList.add("hidden");
  el.roomPasswordCreateInput.value = "";
  clearMpError(el.createRoomError);
  showMpScreen(el.createRoomScreen);
});

el.visibilityPublicBtn.addEventListener("click", () => {
  creatingPublic = true;
  el.visibilityPublicBtn.classList.add("selected");
  el.visibilityPrivateBtn.classList.remove("selected");
  el.roomPasswordCreateRow.classList.add("hidden");
});
el.visibilityPrivateBtn.addEventListener("click", () => {
  creatingPublic = false;
  el.visibilityPrivateBtn.classList.add("selected");
  el.visibilityPublicBtn.classList.remove("selected");
  el.roomPasswordCreateRow.classList.remove("hidden");
});

el.createRoomBackBtn.addEventListener("click", () => showMpScreen(el.multiplayerScreen));

el.createRoomSubmitBtn.addEventListener("click", async () => {
  const roomName = el.roomNameInput.value.trim();
  if (!roomName) return setMpError(el.createRoomError, "Room name is required.");
  if (!creatingPublic && !el.roomPasswordCreateInput.value) {
    return setMpError(el.createRoomError, "Private rooms need a password.");
  }
  clearMpError(el.createRoomError);
  activeErrorEl = el.createRoomError;

  const connected = await ensureLobbyConnected();
  if (!connected) return setMpError(el.createRoomError, "Could not connect to the multiplayer server.");

  lobby.createRoom({
    name: roomName,
    isPublic: creatingPublic,
    password: el.roomPasswordCreateInput.value,
    playerName: loadPlayerName(),
  });
});

el.browseRoomsBtn.addEventListener("click", async () => {
  activeErrorEl = el.mpConnectError;
  const name = getPlayerNameOrError(el.mpConnectError);
  if (!name) return;
  clearMpError(el.browseError);
  selectedRoomId = null;
  el.roomPasswordRow.classList.add("hidden");
  el.roomPasswordJoinBtn.classList.add("hidden");
  rooms = [];
  renderRoomList();
  showMpScreen(el.browseRoomsScreen);

  activeErrorEl = el.browseError;
  const connected = await ensureLobbyConnected();
  if (!connected) return setMpError(el.browseError, "Could not connect to the multiplayer server.");
  lobby.listRooms();
});

el.roomPasswordJoinBtn.addEventListener("click", () => {
  if (!selectedRoomId || !lobby) return;
  attemptJoinRoom(selectedRoomId, el.roomPasswordInput.value);
});

el.roomsRefreshBtn.addEventListener("click", () => {
  clearMpError(el.browseError);
  if (lobby && lobby.ws) lobby.listRooms();
});

el.browseBackBtn.addEventListener("click", () => showMpScreen(el.multiplayerScreen));

el.leaveRoomBtn.addEventListener("click", () => {
  if (lobby) lobby.leaveRoom();
  disconnectLobby();
  currentRoom = null;
  currentPlayers = [];
  myPlayerId = null;
  showMpScreen(el.multiplayerScreen);
});

// --- End multiplayer lobby ------------------------------------------------------------

// --- PvP match lifecycle ---------------------------------------------------------------
// No AI enemies during a match (confirmed design) — `enemies`/`pendingSpawns` are *supposed*
// to just stay empty for the whole thing, but this used to be an unenforced assumption: a
// single-player round exited mid-game (without ever hitting resetGame(), the only thing that
// cleared them) left them populated, and the animate loop's enemy update/spawn logic was only
// gated on `state === "playing"` — true for a multiplayer match too — so leftover enemies kept
// fighting the player right through what was supposed to be a clean PvP match. Now actually
// enforced two ways: beginMatch() (below) defensively clears enemies/pendingSpawns/corpseParts
// on every multiplayer start regardless of what was left over, and the animate loop's enemy
// logic is separately gated on `!inMatch` so it holds even if something else ever leaves stale
// enemies around too.

const RESPAWN_DELAY = 3;
const INVINCIBLE_DURATION = 3;
let invincibleTimer = 0; // >0 while immune to damage right after a respawn

function setInvincible(seconds) {
  invincibleTimer = seconds;
  el.invincibleVignette.classList.remove("hidden");
  el.invincibleIndicator.classList.remove("hidden");
  el.invincibleTimerEl.textContent = `${Math.ceil(invincibleTimer)}s`;
}

function clearInvincible() {
  invincibleTimer = 0;
  el.invincibleVignette.classList.add("hidden");
  el.invincibleIndicator.classList.add("hidden");
}

// Tracks the local player's own death ragdoll (built fresh per death, thrown away on
// respawn) so the camera can chase its head part in third person instead of just staring at
// a black respawn overlay — see beginDeathRagdoll/endDeathRagdoll below.
let deathHeadPart = null;
const deathCamOffset = new THREE.Vector3();
const deathCamHeadPos = new THREE.Vector3();

// Builds a full humanoid body for the LOCAL player (who normally has no visible body at all
// in first person) at the moment of death, and immediately blasts it apart with the same
// ragdoll physics an eliminated peer's avatar already gets — reusing breakApartHumanoid
// keeps this consistent with how everyone else's death already looks. Disables mouse-look
// (not a full pointer-lock unlock, which would incorrectly trigger the pause overlay via the
// "unlock" listener below) and hides the held-weapon viewmodel, since both would otherwise
// keep rigidly following the camera into its new third-person vantage point.
function beginDeathRagdoll(blast = null) {
  const s = sharedHumanoidParts();
  const built = buildHumanoidBody(s);
  const yaw = getNetworkYaw();
  built.visual.rotation.y = yaw;
  built.group.position.set(camera.position.x, camera.position.y - player.eyeHeight, camera.position.z);
  scene.add(built.group);

  const parts = [built.torso, built.head, built.leftLeg, built.rightLeg, built.leftArm, built.rightArm];
  const blastVec = blast ? { origin: new THREE.Vector3(blast.origin.x, blast.origin.y, blast.origin.z), strength: blast.strength } : null;
  const tracked = breakApartHumanoid(scene, built.group, parts, blastVec);
  corpseParts.push(...tracked);
  deathHeadPart = tracked.find((t) => t.mesh === built.head) || null;

  // A fixed offset (computed once, from the facing direction at the moment of death) behind
  // and above wherever the head currently is — a chase cam, not a camera glued to the head
  // mesh itself, which would just show the inside of a box from point-blank range.
  const yawSin = Math.sin(yaw);
  const yawCos = Math.cos(yaw);
  deathCamOffset.set(yawSin * 3, 2.2, yawCos * 3);

  controls.enabled = false;
  loadout.setForceHidden(true);
}

function endDeathRagdoll() {
  deathHeadPart = null;
  controls.enabled = true;
  loadout.setForceHidden(false);
}

function setMatchMode(mode) {
  hostMatchMode = mode;
  el.modeKillsBtn.classList.toggle("selected", mode === "killTarget");
  el.modeTimeBtn.classList.toggle("selected", mode === "timeLimit");
  el.modeFfaBtn.classList.toggle("selected", mode === "freeForAll");
  el.matchConfigNumberRow.classList.toggle("hidden", mode === "freeForAll");
  if (mode === "killTarget") {
    el.matchConfigNumberLabel.textContent = "Kills to win";
    el.matchConfigNumberInput.value = "15";
  } else if (mode === "timeLimit") {
    el.matchConfigNumberLabel.textContent = "Minutes";
    el.matchConfigNumberInput.value = "5";
  }
}
el.modeKillsBtn.addEventListener("click", () => setMatchMode("killTarget"));
el.modeTimeBtn.addEventListener("click", () => setMatchMode("timeLimit"));
el.modeFfaBtn.addEventListener("click", () => setMatchMode("freeForAll"));

function setHostMap(mapId) {
  hostMapId = mapId;
  for (const btn of el.mapPicker.querySelectorAll(".map-option")) {
    btn.classList.toggle("selected", btn.dataset.mapId === mapId);
  }
  el.mapDescription.textContent = MAPS[mapId]?.description || "";
}
el.mapPicker.addEventListener("click", (e) => {
  const btn = e.target.closest(".map-option");
  if (btn) setHostMap(btn.dataset.mapId);
});
setHostMap(hostMapId);

function renderClassPicker() {
  for (const btn of el.classPicker.querySelectorAll(".class-option")) {
    btn.classList.toggle("selected", btn.dataset.classId === selectedClassId);
  }
  const cls = CLASSES.find((c) => c.id === selectedClassId);
  const def = WEAPON_DEFS.find((d) => d.id === cls?.weaponId);
  el.classDescription.textContent =
    cls && def
      ? `${cls.tagline} (${def.name} — ${def.magSize} rounds, ${def.fireMode === "auto" ? "full-auto" : "semi-auto"}) — Q: ${cls.ability.name} (${cls.ability.cooldown}s cooldown)`
      : "";
}
el.classPicker.addEventListener("click", (e) => {
  const btn = e.target.closest(".class-option");
  if (!btn) return;
  selectedClassId = btn.dataset.classId;
  renderClassPicker();
});

// Shows the class-select screen — the caller is responsible for hiding whatever screen it's
// coming from (menu/end-screen/pause-hint/mp screens) first; this only handles the class
// picker itself and the `state` transition, since what surrounds it differs by context (see
// classSelectSpawnFresh's own comment for why the Spawn In handler branches on both this flag
// and `inMatch`, not just one).
function showClassSelect(spawnFresh) {
  classSelectSpawnFresh = spawnFresh;
  renderClassPicker();
  el.classSelectScreen.classList.remove("hidden");
  state = "classSelect";
}

el.spawnInBtn.addEventListener("click", () => {
  const cls = CLASSES.find((c) => c.id === selectedClassId) || CLASSES[0];
  loadout.setClass(cls.weaponId);
  el.classSelectScreen.classList.add("hidden");

  if (inMatch) {
    spawnIntoMatch();
  } else if (classSelectSpawnFresh) {
    sounds.resume();
    showMenuBackdrop = false;
    showGameplayUI();
    resetGame();
    requestPlayLock();
  } else {
    requestPlayLock();
  }
});

el.startMatchBtn.addEventListener("click", () => {
  if (!lobby || !amIHost()) return;
  let config;
  if (hostMatchMode === "killTarget") {
    config = { mode: "killTarget", target: Math.max(1, Number(el.matchConfigNumberInput.value) || 15) };
  } else if (hostMatchMode === "timeLimit") {
    config = { mode: "timeLimit", timeLimitSec: Math.max(30, (Number(el.matchConfigNumberInput.value) || 5) * 60) };
  } else {
    config = { mode: "freeForAll" };
  }
  config.mapId = hostMapId;
  lobby.startMatch(config);
});

function renderScoreRows(container) {
  container.innerHTML = "";
  const sorted = [...scores.entries()].sort((a, b) => b[1].kills - a[1].kills);
  for (const [id, s] of sorted) {
    const li = document.createElement("li");
    li.className = "score-row";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = s.name + (id === myPlayerId ? " (you)" : "");
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
  const mine = scores.get(myPlayerId)?.kills ?? 0;
  el.kills.textContent = matchConfig?.mode === "killTarget" ? `${mine} / ${matchConfig.target}` : String(mine);
}

// Fires for every client, including the host — the server broadcasts match_started to
// the whole room rather than skipping the sender, so nobody needs special-case logic.
function beginMatch(config, startedAt) {
  matchConfig = config;
  matchStartedAt = startedAt;
  inMatch = true;
  respawnTimer = 0;
  // Before loadMap() reassigns obstacles/obstacleMeshes to the new map's fresh arrays — a
  // shield left over from a previous match (or an exited single-player round) needs its
  // splice-out to happen against the *old* arrays it was actually pushed into, not silently
  // no-op against arrays that already forgot it existed. Its visual mesh would otherwise also
  // just leak in the scene forever, since shields/mines live outside buildWorld's own dispose().
  clearAllAbilityEffects();
  loadMap(config.mapId || DEFAULT_MAP_ID);
  el.respawnOverlay.classList.add("hidden");
  endDeathRagdoll();
  clearInvincible();

  // Multiplayer never has AI hostiles at all — but if a single-player round was left
  // mid-game (exited without ever calling resetGame(), which is the only thing that
  // normally clears these), enemies/pendingSpawns/their corpses would otherwise still be
  // sitting here and the animate loop would keep them fighting the player right through a
  // "multiplayer" match. Defensive, not just reactive: also enforced by the `!inMatch`
  // gate around the enemy update/spawn logic itself, so this holds even if some other path
  // ever leaves stale enemies around too.
  for (const e of enemies) e.die(scene);
  enemies.length = 0;
  pendingSpawns.length = 0;
  for (const p of corpseParts) if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
  corpseParts.length = 0;

  for (const rp of remotePlayers.values()) rp.destroy(scene);
  remotePlayers.clear();
  scores.clear();

  let idx = 0;
  for (const p of currentPlayers) {
    scores.set(p.id, { name: p.name, kills: 0 });
    if (p.id !== myPlayerId) {
      const { x, z } = randomSpawnPoint(12, world.arenaBound);
      remotePlayers.set(p.id, new RemotePlayer(scene, p.id, p.name, idx, x, z));
    }
    idx++;
  }
  renderScoreboard();
  updateKillsHud();

  showMpScreen(null);
  sounds.resume();
  loadout.setForceHidden(false);
  // Class-select comes before the local player actually spawns in — keeps showMenuBackdrop/
  // HUD as they are (menu flyover, no HUD yet) until spawnIntoMatch() actually places them.
  showClassSelect(true);
}

// Actually places the LOCAL player into the match world — a fresh spawn point, full health/
// ammo, and whatever class was just selected. Used both for the very first spawn right after
// a match starts and for every subsequent mid-match class change (see the Spawn In click
// handler) — both are "you appear somewhere new with a clean slate" in exactly the same way.
function spawnIntoMatch() {
  showMenuBackdrop = false;
  showGameplayUI();
  const spawn = randomSpawnPoint(12, world.arenaBound);
  resetPlayerState(spawn.x, spawn.z);
  posBroadcastAccum = 0;
  requestPlayLock();
}

// Applies damage to the LOCAL player only — never touches anyone else's health. A hit
// on a remote player instead sends *them* a message (see fireWeapon/explodeAt) and lets
// their own client decide what happens, same trust model as the rest of this game.
// `blast`, when given as {origin:{x,y,z}, strength}, is what makes an eliminated player's
// avatar (as their peers see it) scatter apart hard from an explosive kill instead of the
// plain-gunshot collapse — the same distinction Enemy/registerKill already makes.
function damageLocalPlayer(amount, killerId, killerName, blast = null) {
  if (!inMatch || respawnTimer > 0 || invincibleTimer > 0) return;
  player.takeDamage(amount);
  flashHit();
  if (player.health <= 0) startRespawnSequence(killerId, killerName, blast);
}

function startRespawnSequence(killerId, killerName, blast = null) {
  respawnTimer = RESPAWN_DELAY;
  el.respawnTitle.textContent = killerId ? `Eliminated by ${killerName}` : "Eliminated";
  el.respawnOverlay.classList.remove("hidden");
  beginDeathRagdoll(blast);

  const myName = loadPlayerName();
  if (lobby) lobby.relayToRoom({ t: "elim", victimId: myPlayerId, victimName: myName, killerId, killerName, blast });
  applyElim(myPlayerId, myName, killerId, killerName, blast); // tally locally too, symmetric with how peers see it
}

// Every client tallies the same broadcast "elim" events independently — there's no
// single scorekeeper. Fine for this scope; near-simultaneous kills could in principle
// land in a slightly different order per client (documented v1 simplification).
function applyElim(victimId, victimName, killerId, killerName, blast = null) {
  if (!scores.has(victimId)) scores.set(victimId, { name: victimName, kills: 0 });
  if (killerId && killerId !== victimId) {
    if (!scores.has(killerId)) scores.set(killerId, { name: killerName, kills: 0 });
    scores.get(killerId).kills++;
  }
  renderScoreboard();
  if (killerId === myPlayerId) updateKillsHud();

  // "Explode" the eliminated player's avatar the same way an AI enemy dies — only ever
  // meaningful for a peer (there's no RemotePlayer standing in for the local client itself).
  const rp = remotePlayers.get(victimId);
  if (rp) {
    const blastVec = blast
      ? { origin: new THREE.Vector3(blast.origin.x, blast.origin.y, blast.origin.z), strength: blast.strength }
      : null;
    corpseParts.push(...rp.breakApart(scene, blastVec));
    remotePlayers.delete(victimId); // recreated lazily off that player's next "pos" tick post-respawn
  }

  if (matchConfig?.mode === "killTarget" && killerId) {
    const killer = scores.get(killerId);
    if (killer.kills >= matchConfig.target) endMatch(killerId);
  }
}

function handleRelay(from, payload) {
  if (!payload) return;
  switch (payload.t) {
    case "pos": {
      let rp = remotePlayers.get(from);
      if (!rp) {
        // No avatar for them yet — either the very first tick after joining, or they were
        // just ragdolled on elimination and this is their first tick after respawning.
        const info = currentPlayers.find((p) => p.id === from);
        const idx = Math.max(0, currentPlayers.findIndex((p) => p.id === from));
        rp = new RemotePlayer(scene, from, info?.name || "Player", idx, payload.x, payload.z);
        remotePlayers.set(from, rp);
      }
      rp.updateFromNetwork(
        payload.x,
        payload.y,
        payload.z,
        payload.rotY,
        payload.health,
        payload.isMoving,
        payload.weaponId,
        payload.pitch
      );
      break;
    }
    case "hit":
      damageLocalPlayer(payload.damage, payload.fromId, payload.fromName, payload.blast);
      break;
    case "elim":
      applyElim(payload.victimId, payload.victimName, payload.killerId, payload.killerName, payload.blast);
      break;
    case "left_match": {
      const rp = remotePlayers.get(from);
      if (rp) {
        rp.destroy(scene);
        remotePlayers.delete(from);
      }
      break;
    }
    case "fire": {
      // A plain visual/audio echo of someone else's shot — no damage authority here
      // (that's still only ever decided by whoever actually gets hit, via "hit" above).
      const rp = remotePlayers.get(from);
      if (!rp) break;
      const def = WEAPON_DEFS.find((d) => d.id === payload.weaponId);
      if (!def) break;

      rp.setWeapon(payload.weaponId);
      rp.triggerMuzzleFlash();
      sounds.play(`fire_${def.id}`, { volume: 0.55, rate: 0.98 + Math.random() * 0.04 });

      const muzzleWorld = rp.getMuzzleWorldPosition(new THREE.Vector3());
      const hitVec = new THREE.Vector3(payload.hitPoint.x, payload.hitPoint.y, payload.hitPoint.z);
      if (def.hitscan) {
        bolt(muzzleWorld, hitVec, payload.hitPlayer ? 0x4de3ff : 0x8a8172);
        sparkBurst(hitVec, payload.hitPlayer ? 0x9be9ff : 0xbfae8a);
      } else {
        const rocket = new Rocket(scene, muzzleWorld, hitVec, def.projectileSpeed);
        rocket.splashRadius = def.splashRadius;
        remoteRockets.push(rocket);
      }
      break;
    }
    // `from` (the server-verified sender id), not payload.ownerId, is used as the owner for
    // both of these — no reason to trust a self-reported field when the relay already hands
    // us the real one for free.
    case "shield_place":
      if (!activeShields.has(payload.id)) {
        spawnLocalShield(payload.id, payload.x, payload.z, payload.rotY, from, payload.duration ?? SHIELD_DURATION);
      }
      break;
    case "shield_remove":
      despawnLocalShield(payload.id);
      break;
    case "mine_place":
      if (!activeMines.has(payload.id)) spawnLocalMine(payload.id, payload.x, payload.z, from);
      break;
    case "mine_explode": {
      // Visual/audio echo only — never deals damage here. If this hit *me*, the owner's own
      // client already decided that independently (via explodeAt's splashDamagePlayer check
      // against every RemotePlayer it knows about, same as any other explosion) and sent me a
      // separate "hit" relay_to_player message for it, same as the "fire" case above.
      const m = activeMines.get(payload.id);
      if (m) explodeVisualOnly(new THREE.Vector3(m.x, 0.15, m.z), MINE_BLAST_RADIUS);
      despawnLocalMine(payload.id);
      break;
    }
  }
}

function endMatch(winnerId) {
  inMatch = false;
  state = "menu"; // set before unlock() so the pause-hint doesn't pop up, same trick endGame() uses
  controls.unlock();
  hideGameplayUI();
  el.respawnOverlay.classList.add("hidden");
  el.scoreboardPanel.classList.add("hidden");
  scoreboardVisible = false;
  // Defensive: the match can end (another player hit the kill target, or time ran out) while
  // this player is still on the class-select screen, never having spawned in at all.
  el.classSelectScreen.classList.add("hidden");
  clearAllAbilityEffects();

  const winnerName = winnerId ? scores.get(winnerId)?.name ?? "Someone" : null;
  el.endTitle.classList.remove("lose");
  el.endTitle.textContent = winnerId ? (winnerId === myPlayerId ? "You Win!" : `${winnerName} Wins!`) : "Time's Up";
  el.endMessage.textContent = winnerId ? `First to ${matchConfig.target} eliminations.` : "Final scoreboard:";
  renderEndScoreboard();
  el.endScoreboardList.classList.remove("hidden");
  el.restartBtn.classList.add("hidden");
  el.backToRoomBtn.classList.remove("hidden");
  el.endScreen.classList.remove("hidden");

  for (const rp of remotePlayers.values()) rp.destroy(scene);
  remotePlayers.clear();
}

el.backToRoomBtn.addEventListener("click", () => {
  el.endScreen.classList.add("hidden");
  el.endScoreboardList.classList.add("hidden");
  el.restartBtn.classList.remove("hidden");
  el.backToRoomBtn.classList.add("hidden");
  showMenuBackdrop = true;
  loadout.setForceHidden(true);
  renderRoomScreen();
  showMpScreen(el.roomScreen);
});

// Leaving mid-match via the pause menu — stays connected to the room/lobby (unlike
// leaving the room entirely), so the group can start another match right after.
function leaveMatchToRoom() {
  // Its only current caller (el.exitToMenuBtn's handler) already sets this first, but
  // relying on that precondition is fragile — leaving it unset here means `state` stays
  // "playing" for anyone who calls this directly, which leaves the global mousedown/mouseup
  // listeners still treating clicks as in-game fire input (`if (state !== "playing") return`
  // never short-circuits) instead of ordinary page clicks.
  state = "menu";
  inMatch = false;
  respawnTimer = 0;
  el.respawnOverlay.classList.add("hidden");
  endDeathRagdoll();
  clearInvincible();
  el.scoreboardPanel.classList.add("hidden");
  scoreboardVisible = false;
  if (lobby) lobby.relayToRoom({ t: "left_match", id: myPlayerId });
  for (const rp of remotePlayers.values()) rp.destroy(scene);
  remotePlayers.clear();
  clearAllAbilityEffects();
  renderRoomScreen();
  showMpScreen(el.roomScreen);
}

// Disconnect mid-match (server dropped / network blip) — clean up game state only;
// the onDisconnected handler that called this is the one showing the error/screen.
function endMatchAbruptly() {
  inMatch = false;
  respawnTimer = 0;
  el.respawnOverlay.classList.add("hidden");
  endDeathRagdoll();
  clearInvincible();
  el.scoreboardPanel.classList.add("hidden");
  scoreboardVisible = false;
  state = "menu";
  controls.unlock();
  showMenuBackdrop = true;
  loadout.setForceHidden(true);
  hideGameplayUI();
  // Defensive: a disconnect could land while the class-select screen is up (match started,
  // but the player hadn't hit Spawn In yet) — showMpScreen only manages the lobby screens,
  // not this one, so it'd otherwise be left showing on top of whatever comes next.
  el.classSelectScreen.classList.add("hidden");
  for (const rp of remotePlayers.values()) rp.destroy(scene);
  remotePlayers.clear();
  clearAllAbilityEffects();
}

// --- End PvP match lifecycle -------------------------------------------------------------

el.startBtn.addEventListener("click", () => {
  el.menu.classList.add("hidden");
  showClassSelect(true);
});

el.restartBtn.addEventListener("click", () => {
  el.endScreen.classList.add("hidden");
  showClassSelect(true);
});

// Extracted so touch-mode code paths (no Pointer Lock API involved at all) can reach the
// exact same state transition directly, instead of only ever firing from a real lock/unlock
// browser event.
function enterPlayingState() {
  el.menu.classList.add("hidden");
  el.classSelectScreen.classList.add("hidden");
  el.pauseHint.classList.add("hidden");
  state = "playing";
}

function enterPausedState() {
  if (state === "playing") {
    state = "paused";
    el.pauseHint.classList.remove("hidden");
    loadout.setAiming(false);
    aimHeld = false;
    if (settings.hideCrosshairWhileAiming) el.crosshair.style.display = "";
  }
}

// Touch devices never engage the Pointer Lock API at all (no cursor to lock, and it's
// unsupported on some mobile browsers anyway) — every call site that used to just call
// controls.lock(true) to enter gameplay now goes through this, so it reaches the exact same
// enterPlayingState() transition directly on touch instead of waiting on a "lock" event that
// will never fire.
function requestPlayLock() {
  if (touchControls.active) enterPlayingState();
  else controls.lock(true);
}

controls.addEventListener("lock", enterPlayingState);
controls.addEventListener("unlock", enterPausedState);

el.resumeBtn.addEventListener("click", requestPlayLock);

el.changeClassBtn.addEventListener("click", () => {
  el.pauseHint.classList.add("hidden");
  showClassSelect(false); // false — a single-player change swaps weapons in place, no reset (see classSelectSpawnFresh)
});

el.exitToMenuBtn.addEventListener("click", () => {
  state = "menu";
  showMenuBackdrop = true;
  loadout.setForceHidden(true);
  el.pauseHint.classList.add("hidden");
  el.scopeVignette.classList.add("hidden");
  hideGameplayUI();

  if (inMatch) {
    leaveMatchToRoom(); // stays connected to the room — a single-player exit disconnects nothing to keep
  } else {
    el.landing.classList.remove("hidden");
  }
});

function grenadeThrowVelocity() {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const velocity = forward.clone().multiplyScalar(GRENADE_DEF.throwSpeed);
  velocity.y += GRENADE_DEF.throwSpeed * 0.35;
  return velocity;
}

function consumeGrenadeCharge() {
  if (!INFINITE_GRENADES) grenadeCount--;
  grenadeCooldown = GRENADE_DEF.cooldown;
  el.grenadeCount.textContent = formatGrenadeCount(grenadeCount);
}

function stopHoldingGrenade() {
  grenadeHeld = false;
  grenadeHeldTime = 0;
  grenadeHeldView.setHeld(false);
  trajectoryLine.visible = false;
  loadout.current.view.setForceHidden(false);
}

function startHoldingGrenade() {
  if (grenadeHeld || grenadeCooldown > 0) return;
  if (!INFINITE_GRENADES && grenadeCount <= 0) return;
  grenadeHeld = true;
  grenadeHeldTime = 0;
  grenadeHeldView.setHeld(true);
  loadout.current.view.setForceHidden(true);
}

function releaseGrenade() {
  if (!grenadeHeld) return;
  const velocity = grenadeThrowVelocity();
  const origin = grenadeHeldView.getWorldPosition(new THREE.Vector3());

  stopHoldingGrenade();
  consumeGrenadeCharge();
  grenades.push(new Grenade(scene, origin, velocity, GRENADE_DEF.fuse));
}

// True while the user is actually typing into a text field (room name, player name, password,
// kill-target number, etc.) — the global keydown/keyup listeners below are on `window`, so
// without this guard they intercept every keystroke regardless of what's focused. WASD in
// particular used to work fine typed into these fields (nothing prevented their default
// behavior), but adding `e.preventDefault()` on movement keys for the crouch-key fix broke it —
// that preventDefault now needs to be skipped whenever the keystroke is actually meant for a
// text field, not the game.
function isTypingIntoField() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

window.addEventListener("keydown", (e) => {
  if (isTypingIntoField()) return;
  if (e.code === "F3") {
    e.preventDefault();
    debugVisible = !debugVisible;
    el.debugPanel.classList.toggle("hidden", !debugVisible);
    return;
  }
  if (e.code === "F4") {
    e.preventDefault();
    showCollisionBoxes = !showCollisionBoxes;
    setHitboxesVisible(obstacles, showCollisionBoxes);
    el.collisionBoxIndicator.classList.toggle("hidden", !showCollisionBoxes);
    return;
  }
  if (e.code === "F5") {
    e.preventDefault();
    player.setFlying(!player.flying);
    el.flyModeIndicator.classList.toggle("hidden", !player.flying);
    return;
  }
  if (e.code === "Tab" && state === "playing" && inMatch) {
    e.preventDefault(); // otherwise Tab tries to cycle browser focus
    scoreboardVisible = !scoreboardVisible;
    el.scoreboardPanel.classList.toggle("hidden", !scoreboardVisible);
    return;
  }
  // preventDefault on every key this game actually uses — belt-and-suspenders against the
  // browser's own default action for that key (arrow-key/space page scrolling, etc.). Note
  // this does NOT protect against browser-level keyboard *shortcuts* layered on top of a key
  // (Ctrl/Alt/etc. + key) — see the crouch-key comment below for why that distinction mattered.
  switch (e.code) {
    case "KeyW": case "ArrowUp": e.preventDefault(); input.forward = true; break;
    case "KeyS": case "ArrowDown": e.preventDefault(); input.back = true; break;
    case "KeyA": case "ArrowLeft": e.preventDefault(); input.left = true; break;
    case "KeyD": case "ArrowRight": e.preventDefault(); input.right = true; break;
    case "Space":
      e.preventDefault();
      if (!e.repeat) input.jumpQueued = true;
      input.up = true; // held (not one-shot) — only consumed while flying, see Player.updateFlying
      break;
    case "ShiftLeft": case "ShiftRight": input.sprint = true; break;
    // KeyC, not Ctrl — crouch was originally bound to Ctrl, but Ctrl+W/D/S (forward/right/back)
    // are Chrome's close-tab/bookmark/save-page shortcuts, and browsers deliberately don't let
    // a page preventDefault() those (crouch-walking would trigger them regardless of anything
    // done here). A plain unmodified key sidesteps the whole category of conflict.
    case "KeyC":
      if (settings.toggleCrouch) {
        if (!e.repeat) input.crouch = !input.crouch;
      } else {
        input.crouch = true;
      }
      break;
    case "KeyR":
      if (!e.repeat) doReload();
      break;
    case "KeyG":
      if (!e.repeat && state === "playing") startHoldingGrenade();
      break;
    case "KeyQ":
      if (!e.repeat) useAbility();
      break;
  }
});
window.addEventListener("keyup", (e) => {
  // No isTypingIntoField() guard here (unlike keydown) — releasing a key only ever clears a
  // flag or no-ops, never starts something new or calls preventDefault, so there's no typing
  // interference to prevent. Skipping it would risk the opposite problem instead: if focus
  // ever moved to a field while a movement key was physically held down, the matching keyup
  // would be silently dropped and that key would read as "stuck" held forever.
  switch (e.code) {
    case "KeyW": case "ArrowUp": input.forward = false; break;
    case "KeyS": case "ArrowDown": input.back = false; break;
    case "KeyA": case "ArrowLeft": input.left = false; break;
    case "KeyD": case "ArrowRight": input.right = false; break;
    case "Space": input.up = false; break;
    case "ShiftLeft": case "ShiftRight": input.sprint = false; break;
    case "KeyC": if (!settings.toggleCrouch) input.crouch = false; break;
    case "KeyG": releaseGrenade(); break;
  }
});

function bolt(from, to, color) {
  const path = new THREE.Vector3().subVectors(to, from);
  const length = Math.max(0.05, path.length());

  const geo = new THREE.CylinderGeometry(0.025, 0.025, length, 6);
  geo.translate(0, length / 2, 0);
  geo.rotateX(Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(from);
  mesh.lookAt(to);
  scene.add(mesh);
  activeFx++;

  let life = 0.09;
  const fade = () => {
    life -= 1 / 60;
    mat.opacity = Math.max(0, life / 0.09) * 0.95;
    if (life <= 0) {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      activeFx--;
    } else {
      requestAnimationFrame(fade);
    }
  };
  fade();
}

function sparkBurst(point, color) {
  const geo = new THREE.SphereGeometry(0.12, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(point);
  scene.add(mesh);
  activeFx++;

  let life = 0.18;
  const fade = () => {
    life -= 1 / 60;
    const t = Math.max(0, life / 0.18);
    mat.opacity = t * 0.9;
    mesh.scale.setScalar(1 + (1 - t) * 2.2);
    if (life <= 0) {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      activeFx--;
    } else {
      requestAnimationFrame(fade);
    }
  };
  fade();
}

function explosionBurst(point, radius) {
  const geo = new THREE.SphereGeometry(0.3, 12, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(point);
  scene.add(mesh);
  activeFx++;

  const light = new THREE.PointLight(0xff8a3a, 6, radius * 2.5);
  light.position.copy(point);
  scene.add(light);

  const maxScale = Math.max(1.5, radius * 0.7);
  let life = 0.35;
  const fade = () => {
    life -= 1 / 60;
    const t = Math.max(0, life / 0.35);
    mat.opacity = t * 0.95;
    mesh.scale.setScalar(1 + (1 - t) * maxScale);
    light.intensity = t * 6;
    if (life <= 0) {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      scene.remove(light);
      activeFx--;
    } else {
      requestAnimationFrame(fade);
    }
  };
  fade();
}

function pulseCrosshair() {
  el.crosshair.classList.remove("fire");
  void el.crosshair.offsetWidth;
  el.crosshair.classList.add("fire");
}

function pulseAmmoEmpty() {
  el.ammoText.classList.remove("empty-pulse");
  void el.ammoText.offsetWidth;
  el.ammoText.classList.add("empty-pulse");
}

function registerKill(enemy, blast = null) {
  corpseParts.push(...breakApartEnemy(scene, enemy, blast));
  pendingSpawns.push(ENEMY_RESPAWN_DELAY);
  debugGraphs.markKill();
  kills++;
  el.kills.textContent = `${kills} / ${TOTAL_KILLS_TO_WIN}`;
  if (kills >= TOTAL_KILLS_TO_WIN) endGame(true);
}

// The look/sound of an explosion with none of the damage side effects — used both by a
// real explosion below and by the visual-only echo of a peer's bazooka rocket arriving
// (that one must never deal damage locally; only the original shooter's client does).
function explodeVisualOnly(position, radius) {
  explosionBurst(position, radius);
  sounds.play("explosion", { volume: 0.8, rate: 0.96 + Math.random() * 0.08 });
}

function explodeAt(position, radius, damage) {
  explodeVisualOnly(position, radius);

  const killed = splashDamageEnemies(position, radius, damage, enemies);
  const blast = { origin: position, strength: damage * 0.06 };
  for (const e of killed) registerKill(e, blast);

  if (inMatch && lobby) {
    // Same "send them the hit, never touch their health directly" rule as hitscan. `blast`
    // (already computed above for the enemy ragdoll) rides along so that if this hit is
    // lethal, the victim's peers see their avatar scatter apart like an explosive enemy
    // kill instead of a plain-gunshot collapse.
    for (const rp of remotePlayers.values()) {
      const dmg = splashDamagePlayer(position, radius, damage, rp.group.position);
      if (dmg > 0) {
        lobby.relayToPlayer(rp.id, { t: "hit", damage: dmg, fromId: myPlayerId, fromName: loadPlayerName(), blast });
      }
    }
  }

  const playerDmg = splashDamagePlayer(position, radius, damage, camera.position);
  if (playerDmg > 0) {
    if (inMatch) {
      damageLocalPlayer(playerDmg, null, "", blast); // a suicide via your own blast — no kill credit
    } else {
      player.takeDamage(playerDmg);
      flashHit();
      if (player.health <= 0) endGame(false);
    }
  }
}

// --- Class abilities (Q) ---------------------------------------------------------------

function useAbility() {
  if (state !== "playing" || grenadeHeld || respawnTimer > 0 || abilityCooldownRemaining > 0) return;
  const cls = CLASSES.find((c) => c.id === selectedClassId);
  if (!cls) return;
  switch (cls.ability.id) {
    case "dash":
      doDash();
      break;
    case "shield":
      placeShield();
      break;
    case "pulse":
      doReconPulse();
      break;
    case "mine":
      placeMine();
      break;
    default:
      return; // unknown ability id — don't burn the cooldown on nothing
  }
  abilityCooldownRemaining = cls.ability.cooldown;
}

// Scout: an instant burst in whatever direction is currently held (falls back to camera-
// forward if no movement key is pressed) — the same forward/right basis Player.update() uses
// for normal movement, recomputed here since that math lives inside the Player class, not
// exposed for reuse.
function doDash() {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

  let moveX = 0, moveZ = 0;
  if (input.forward) moveZ += 1;
  if (input.back) moveZ -= 1;
  if (input.right) moveX += 1;
  if (input.left) moveX -= 1;

  const dir = new THREE.Vector3();
  if (moveX !== 0 || moveZ !== 0) dir.addScaledVector(forward, moveZ).addScaledVector(right, moveX);
  else dir.copy(forward);
  player.dash(dir.x, dir.z, DASH_SPEED);
  sounds.play("footstep", { volume: 0.6, rate: 1.7 }); // no dedicated dash sfx — a pitched-up footstep reads as a quick burst
}

// Assault: deploys a solid, temporary wall directly in front of the player, facing them —
// its thin axis lines up with the camera's own forward direction via getNetworkYaw() (the
// same yaw convention already used to orient a RemotePlayer avatar), so a peer's synced copy
// renders at the exact angle this player is actually facing. Pushed into the *live*
// obstacles/obstacleMeshes arrays (not just the visual scene) so it actually blocks
// movement/hitscan/AI line-of-sight, not just decoration — see buildShieldWall's own comment.
function placeShield() {
  const rotY = getNetworkYaw();
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  const x = camera.position.x + forward.x * SHIELD_PLACE_DISTANCE;
  const z = camera.position.z + forward.z * SHIELD_PLACE_DISTANCE;
  const id = `${myPlayerId || "sp"}_shield_${abilityIdCounter++}`;

  spawnLocalShield(id, x, z, rotY, myPlayerId, SHIELD_DURATION);
  if (inMatch && lobby) {
    lobby.relayToRoom({ t: "shield_place", id, x, z, rotY, ownerId: myPlayerId, duration: SHIELD_DURATION });
  }
}

function spawnLocalShield(id, x, z, rotY, ownerId, duration) {
  const { mesh, hitboxMesh, entry } = buildShieldWall(scene, x, z, rotY);
  obstacles.push(entry);
  obstacleMeshes.push(hitboxMesh);
  activeShields.set(id, { entry, mesh, hitboxMesh, ownerId, remaining: duration });
}

function despawnLocalShield(id) {
  const s = activeShields.get(id);
  if (!s) return;
  const oi = obstacles.indexOf(s.entry);
  if (oi !== -1) obstacles.splice(oi, 1);
  const mi = obstacleMeshes.indexOf(s.hitboxMesh);
  if (mi !== -1) obstacleMeshes.splice(mi, 1);
  removeShieldWall(scene, s);
  activeShields.delete(id);
}

// Recon: reveals every enemy currently known to this client (AI in single-player, remote
// players in multiplayer — never both, there's no AI at all during a match) with a marker
// rendered through walls. No networking involved at all: this only visualizes information the
// client already has locally (AI state / position ticks), it isn't asking anyone for anything.
function doReconPulse() {
  const targets = inMatch ? [...remotePlayers.values()] : enemies.filter((e) => e.alive);
  for (const t of targets) {
    const sprite = buildReconMarkerSprite();
    scene.add(sprite);
    activeReconMarkers.push({ sprite, targetGroup: t.group, remaining: RECON_PULSE_DURATION });
  }
}

// Demolition: places a mine at the player's feet. Deliberately not a collision obstacle at
// all (meant to be walked over, not blocked by) — trigger detection is a plain per-frame
// proximity check owned entirely by *this* client for mines *this* client placed (see the
// per-frame update loop below), matching the project's established "each client is
// authoritative for damage it deals" trust model. A mine synced from a peer's placement is
// purely a visual copy here; their own client is what actually decides when it goes off.
function placeMine() {
  const x = camera.position.x;
  const z = camera.position.z;
  const id = `${myPlayerId || "sp"}_mine_${abilityIdCounter++}`;
  spawnLocalMine(id, x, z, myPlayerId);
  if (inMatch && lobby) {
    lobby.relayToRoom({ t: "mine_place", id, x, z, ownerId: myPlayerId });
  }
}

function spawnLocalMine(id, x, z, ownerId) {
  const mesh = buildMineMesh();
  mesh.position.set(x, 0, z);
  scene.add(mesh);
  activeMines.set(id, { mesh, x, z, ownerId, remaining: MINE_MAX_LIFETIME });
}

function despawnLocalMine(id) {
  const m = activeMines.get(id);
  if (!m) return;
  scene.remove(m.mesh);
  activeMines.delete(id);
}

// Detonates a mine THIS client owns (called only from the per-frame trigger check, never for
// a peer's mine) — full splash damage via the same explodeAt() a grenade/rocket already uses
// (so kill-crediting/remote-hit-relay/enemy-splash all just work, no separate path needed),
// plus telling peers to remove their copy of it (and see the explosion) too.
function triggerMine(id) {
  const m = activeMines.get(id);
  if (!m) return;
  explodeAt(new THREE.Vector3(m.x, 0.15, m.z), MINE_BLAST_RADIUS, MINE_DAMAGE);
  despawnLocalMine(id);
  if (inMatch && lobby) {
    lobby.relayToRoom({ t: "mine_explode", id });
  }
}

// Clears every active shield/mine/recon marker regardless of ownership — used wherever match
// state is already torn down wholesale (match start/end/disconnect, single-player restart),
// same treatment corpseParts/remotePlayers already get in those same spots.
function clearAllAbilityEffects() {
  for (const id of [...activeShields.keys()]) despawnLocalShield(id);
  for (const id of [...activeMines.keys()]) despawnLocalMine(id);
  for (const marker of activeReconMarkers) scene.remove(marker.sprite);
  activeReconMarkers.length = 0;
  abilityCooldownRemaining = 0;
}

function fireWeapon() {
  const def = loadout.current.def;
  if (!loadout.fire()) {
    if (!loadout.current.slot.isReloading && loadout.current.slot.ammo <= 0) pulseAmmoEmpty();
    return;
  }

  loadout.current.view.fire();
  pulseCrosshair();
  fovKick = 2.2;
  debugGraphs.markShot();
  sounds.play(`fire_${def.id}`, { volume: 0.8, rate: 0.98 + Math.random() * 0.04 });

  raycaster.setFromCamera(screenCenter, camera);
  if (def.spread > 0) {
    raycaster.ray.direction.x += (Math.random() - 0.5) * def.spread;
    raycaster.ray.direction.y += (Math.random() - 0.5) * def.spread;
    raycaster.ray.direction.normalize();
  }

  const enemyMeshes = enemies.filter((e) => e.alive).map((e) => e.mesh);
  const remoteMeshes = [...remotePlayers.values()].map((rp) => rp.mesh);
  const hits = raycaster.intersectObjects([...enemyMeshes, ...remoteMeshes, ...obstacleMeshes], false);

  const muzzleOrigin = loadout.current.view.getMuzzleWorldPosition(new THREE.Vector3());
  let hitPoint;
  if (hits.length > 0) {
    hitPoint = hits[0].point.clone();
  } else {
    // Nothing hit (no obstacle/enemy raycast target includes the ground plane) — a flat
    // 60-unit-out fallback point can end up underground on any downward-angled shot, which is
    // what let the bazooka's rocket travel straight through the terrain. Clamp the fallback to
    // where the aim ray actually crosses ground level (y=0) when it's heading downward.
    const dir = raycaster.ray.direction;
    const groundDist = dir.y < -1e-4 ? -camera.position.y / dir.y : Infinity;
    const dist = Math.min(60, groundDist);
    hitPoint = camera.position.clone().addScaledVector(dir, dist);
  }

  let hitRemote = false;
  if (def.hitscan) {
    if (hits.length > 0) {
      const hit = hits[0];
      const enemy = enemies.find((e) => e.mesh === hit.object);
      const remote = enemy ? null : [...remotePlayers.values()].find((rp) => rp.mesh === hit.object);
      bolt(muzzleOrigin, hit.point, enemy || remote ? 0x4de3ff : 0x8a8172);
      sparkBurst(hit.point, enemy || remote ? 0x9be9ff : 0xbfae8a);
      if (enemy) {
        sounds.play("hitmarker", { volume: 0.6 });
        if (enemy.takeDamage(def.damage)) registerKill(enemy);
      } else if (remote) {
        // Never touch the remote player's health directly — send *them* the hit and let
        // their own client decide what happens, same trust model as everything else here.
        hitRemote = true;
        sounds.play("hitmarker", { volume: 0.6 });
        if (lobby) {
          lobby.relayToPlayer(remote.id, { t: "hit", damage: def.damage, fromId: myPlayerId, fromName: loadPlayerName() });
        }
      }
    } else {
      bolt(muzzleOrigin, hitPoint, 0x2a6b7a);
    }
  } else {
    const rocket = new Rocket(scene, muzzleOrigin, hitPoint, def.projectileSpeed);
    rocket.splashRadius = def.splashRadius;
    rocket.splashDamage = def.splashDamage;
    rockets.push(rocket);
  }

  // Let peers see and hear this shot too — a plain visual/audio echo (handled on their
  // end by handleRelay's "fire" case), never a source of damage authority on its own.
  // The muzzle point itself isn't sent: each receiver draws the tracer from *their own*
  // replicated copy of the shooter's rig (rp.getMuzzleWorldPosition()), which is more
  // accurate than trusting a raw coordinate that may be a tick stale by arrival.
  if (inMatch && lobby) {
    lobby.relayToRoom({
      t: "fire",
      weaponId: def.id,
      hitPoint: { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
      hitPlayer: hitRemote,
    });
  }
}

window.addEventListener("contextmenu", (e) => e.preventDefault());

function setAiming(aiming) {
  aimHeld = aiming;
  loadout.setAiming(aiming);
  if (settings.hideCrosshairWhileAiming) el.crosshair.style.display = aiming ? "none" : "";
}

function doReload() {
  if (state !== "playing" || grenadeHeld) return;
  if (loadout.startReload() && aimHeld) setAiming(false);
}

// Extracted so the touch Fire/Aim buttons drive the exact same state the mouse handlers
// below do, instead of duplicating the state === "playing"/grenadeHeld guard and the
// toggleAim branching a second time.
function handleFireStart() {
  if (state !== "playing" || grenadeHeld) return;
  leftMouseHeld = true;
  fireWeapon();
}
function handleFireEnd() {
  leftMouseHeld = false;
}
function handleAimStart() {
  if (state !== "playing" || grenadeHeld) return;
  setAiming(settings.toggleAim ? !aimHeld : true);
}
function handleAimEnd() {
  if (!settings.toggleAim) setAiming(false);
}

window.addEventListener("mousedown", (e) => {
  if (e.button === 0) handleFireStart();
  if (e.button === 2) handleAimStart();
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) handleFireEnd();
  if (e.button === 2) handleAimEnd();
});

window.addEventListener(
  "wheel",
  (e) => {
    if (state !== "playing" || grenadeHeld) return;
    e.preventDefault();
    loadout.cycle(e.deltaY > 0 ? 1 : -1, aimHeld);
  },
  { passive: false }
);

function flashHit() {
  el.hitFlash.classList.add("show");
  setTimeout(() => el.hitFlash.classList.remove("show"), 90);
}

const clock = new THREE.Clock();
const heapSupported = typeof performance !== "undefined" && !!performance.memory;

function updateDebugPanel(rawDt) {
  const ms = rawDt * 1000;
  frameTimes.push(ms);
  if (frameTimes.length > 90) frameTimes.shift();

  if (clock.getElapsedTime() - frameMaxResetAt > 1) {
    frameMaxMs = 0;
    frameMaxResetAt = clock.getElapsedTime();
  }
  if (ms > frameMaxMs) frameMaxMs = ms;

  debugUpdateAccum += rawDt;
  if (debugUpdateAccum < 0.2) return;
  debugUpdateAccum = 0;

  const avgMs = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  const fps = avgMs > 0 ? 1000 / avgMs : 0;

  let lightCount = 0;
  scene.traverse((obj) => {
    if (obj.isLight) lightCount++;
  });

  el.dbgFps.textContent = fps.toFixed(0);
  el.dbgFrame.textContent = `${avgMs.toFixed(1)} / ${frameMaxMs.toFixed(1)} ms`;
  el.dbgCalls.textContent = renderer.info.render.calls;
  el.dbgTris.textContent = renderer.info.render.triangles.toLocaleString();
  el.dbgGeo.textContent = renderer.info.memory.geometries;
  el.dbgTex.textContent = renderer.info.memory.textures;
  el.dbgLights.textContent = lightCount;
  el.dbgEnemies.textContent = enemies.length;
  el.dbgFx.textContent = activeFx;
  el.dbgHeap.textContent = heapSupported
    ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB`
    : "n/a";
}

function animate() {
  requestAnimationFrame(animate);
  const rawDt = clock.getDelta();
  const dt = Math.min(0.05, rawDt);
  const elapsed = clock.getElapsedTime();

  updateRotatePrompt();

  if (state === "playing") {
    // Touch has no dedicated sprint button (per the confirmed mobile-controls scope) — sprint
    // auto-engages whenever the joystick shows any movement, with the existing stamina system
    // (drain/lock/regen) still fully gating it exactly as it does for a held Shift key.
    const touchMoving = Math.abs(input.moveX || 0) > 0.05 || Math.abs(input.moveZ || 0) > 0.05;
    if (touchControls.active) input.sprint = touchMoving || input.forward || input.back || input.left || input.right;

    if (respawnTimer <= 0) player.update(dt, input, obstacles, world.arenaBound);

    const isMoving = touchMoving || input.forward || input.back || input.left || input.right;
    loadout.update(dt, elapsed, isMoving);

    // Touch also has no manual reload button — auto-triggers the instant the mag is empty,
    // via the exact same doReload() the R key calls.
    if (touchControls.active && respawnTimer <= 0 && loadout.current.slot.ammo === 0) doReload();

    if (isMoving && player.onGround) {
      footstepTimer -= dt;
      if (footstepTimer <= 0) {
        const interval = input.sprint ? FOOTSTEP_SPRINT_INTERVAL : FOOTSTEP_INTERVAL;
        footstepTimer += interval;
        const offset = Math.random() * 8;
        sounds.play("footstep", { volume: 0.5, rate: 0.95 + Math.random() * 0.1, offset, duration: FOOTSTEP_SLICE });
      }
    } else {
      footstepTimer = 0;
    }

    if (leftMouseHeld && !grenadeHeld && respawnTimer <= 0 && loadout.current.def.fireMode === "auto") {
      fireWeapon();
    }

    if (grenadeHeld) {
      grenadeHeldTime += dt;
      grenadeHeldView.update(grenadeHeldTime, elapsed);
      const origin = grenadeHeldView.getWorldPosition(new THREE.Vector3());
      const points = predictGrenadeArc(origin, grenadeThrowVelocity(), GRENADE_DEF.fuse);
      trajectoryLine.geometry.setFromPoints(points);
      trajectoryLine.visible = true;
    }

    fovKick *= Math.exp(-16 * dt);
    if (fovKick < 0.01) fovKick = 0;
    const targetFov = BASE_FOV + (loadout.current.def.aimFov - BASE_FOV) * loadout.current.view.aimProgress;
    camera.fov = targetFov + fovKick;
    camera.updateProjectionMatrix();
    // Blends from the general look-sensitivity setting down to the scoped-sensitivity setting
    // as aimProgress goes 0 -> 1, matching the pre-existing hardcoded (1 -> 0.4) feel exactly
    // when both settings are left at their defaults.
    controls.pointerSpeed =
      settings.lookSensitivity - (settings.lookSensitivity - settings.scopedSensitivity) * loadout.current.view.aimProgress;
    el.scopeVignette.classList.toggle("hidden", !loadout.current.view.scopedIn);

    if (grenadeCooldown > 0) grenadeCooldown -= dt;

    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      if (g.update(dt, obstacles)) {
        explodeAt(g.position.clone(), GRENADE_DEF.splashRadius, GRENADE_DEF.splashDamage);
        g.destroy();
        grenades.splice(i, 1);
      }
    }

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      if (r.update(dt)) {
        explodeAt(r.position.clone(), r.splashRadius, r.splashDamage);
        r.destroy();
        rockets.splice(i, 1);
      }
    }

    for (let i = remoteRockets.length - 1; i >= 0; i--) {
      const r = remoteRockets[i];
      if (r.update(dt)) {
        explodeVisualOnly(r.position.clone(), r.splashRadius); // echo only — never damages locally
        r.destroy();
        remoteRockets.splice(i, 1);
      }
    }

    // A health-bar Sprite always billboards to face the camera, so "shrink from the left
    // edge" only reads correctly if the compensation shifts along whatever direction is
    // currently screen-right — not a fixed world axis, which only matched when viewed
    // head-on and otherwise shifted mostly in depth (read as "the whole bar shrinks in
    // place"). Column 0 of the camera's world matrix is its local +X axis in world space,
    // i.e. screen-right for a non-rolling FPS camera; computed once per frame and handed to
    // every health bar update below.
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);

    // AI enemies only ever exist in single-player — this `!inMatch` gate is the actual
    // enforcement of that (beginMatch()'s cleanup is just belt-and-suspenders for whatever
    // was already sitting in `enemies` when a multiplayer match starts); without it, stale
    // enemies left over from an exited single-player round would keep fighting the player
    // (and could even call the single-player-only endGame()) during a "multiplayer" match.
    if (!inMatch) {
      for (const e of enemies) {
        const damage = e.update(dt, elapsed, camera.position, obstacles, obstacleMeshes, camRight);
        if (e.justFired) sounds.play("fire_pistol", { volume: 0.35, rate: 0.9 + Math.random() * 0.15 });
        if (damage) {
          player.takeDamage(damage);
          flashHit();
          if (player.health <= 0) endGame(false);
        }
      }
      for (let i = enemies.length - 1; i >= 0; i--) {
        if (!enemies[i].alive) enemies.splice(i, 1);
      }
    }

    // Unconditional, unlike the enemy logic above — corpseParts also holds broken-apart
    // *player* ragdolls from multiplayer eliminations (applyElim/beginDeathRagdoll), not
    // just single-player enemy deaths, so this still needs to animate during a match.
    updateCorpseParts(corpseParts, dt);

    // Every active shield/mine/recon marker counts down regardless of whose it is (own or a
    // peer's, synced via relay) — see clearAllAbilityEffects's comment for the trust-model
    // reasoning. Map's own iterator tolerates deleting the *current* entry mid-iteration
    // (well-defined per spec, unlike some other iterables), which despawnLocalShield/
    // despawnLocalMine do below, so this is safe as written.
    for (const [id, s] of activeShields) {
      s.remaining -= dt;
      if (s.remaining <= 0) {
        const wasMine = s.ownerId === myPlayerId;
        despawnLocalShield(id);
        if (wasMine && inMatch && lobby) lobby.relayToRoom({ t: "shield_remove", id });
      }
    }

    for (const [id, m] of activeMines) {
      m.remaining -= dt;
      if (m.remaining <= 0) {
        despawnLocalMine(id); // safety-net expiry — see MINE_MAX_LIFETIME's own comment
        continue;
      }
      if (m.ownerId !== myPlayerId) continue; // only the owner's client decides when its own mine goes off
      let triggered = false;
      if (inMatch) {
        for (const rp of remotePlayers.values()) {
          if (Math.hypot(rp.group.position.x - m.x, rp.group.position.z - m.z) <= MINE_TRIGGER_RADIUS) {
            triggered = true;
            break;
          }
        }
      } else {
        for (const e of enemies) {
          if (e.alive && Math.hypot(e.group.position.x - m.x, e.group.position.z - m.z) <= MINE_TRIGGER_RADIUS) {
            triggered = true;
            break;
          }
        }
      }
      if (triggered) triggerMine(id);
    }

    for (let i = activeReconMarkers.length - 1; i >= 0; i--) {
      const marker = activeReconMarkers[i];
      marker.remaining -= dt;
      if (marker.remaining <= 0 || !marker.targetGroup.parent) {
        scene.remove(marker.sprite);
        activeReconMarkers.splice(i, 1);
        continue;
      }
      marker.sprite.position.copy(marker.targetGroup.position);
      marker.sprite.position.y += 2.2; // hover above the head
    }

    if (abilityCooldownRemaining > 0) {
      abilityCooldownRemaining = Math.max(0, abilityCooldownRemaining - dt);
    }
    const equippedClass = CLASSES.find((c) => c.id === selectedClassId);
    if (equippedClass) {
      el.abilityLabel.textContent = equippedClass.ability.name;
      el.abilityStatus.textContent = abilityCooldownRemaining > 0 ? `${Math.ceil(abilityCooldownRemaining)}s` : "Ready (Q)";
    }

    if (!inMatch) {
      for (let i = pendingSpawns.length - 1; i >= 0; i--) {
        pendingSpawns[i] -= dt;
        if (pendingSpawns[i] <= 0) {
          pendingSpawns.splice(i, 1);
          if (enemies.length < MAX_ENEMIES && state === "playing") spawnEnemy();
        }
      }
    }

    for (const rp of remotePlayers.values()) {
      const revealedByPulse = activeReconMarkers.some((m) => m.targetGroup === rp.group);
      rp.update(dt, camera.position, camRight, revealedByPulse);
    }

    if (inMatch) {
      if (respawnTimer > 0) {
        respawnTimer -= dt;
        el.respawnTimerEl.textContent = `Respawning in ${Math.max(0, Math.ceil(respawnTimer))}s`;
        if (deathHeadPart) {
          deathCamHeadPos.copy(deathHeadPart.mesh.position);
          camera.position.copy(deathCamHeadPos).add(deathCamOffset);
          camera.lookAt(deathCamHeadPos);
        }
        if (respawnTimer <= 0) {
          const spawn = randomSpawnPoint(12, world.arenaBound);
          resetPlayerState(spawn.x, spawn.z);
          el.respawnOverlay.classList.add("hidden");
          endDeathRagdoll();
          setInvincible(INVINCIBLE_DURATION);
        }
      } else {
        if (invincibleTimer > 0) {
          invincibleTimer -= dt;
          if (invincibleTimer <= 0) clearInvincible();
          else el.invincibleTimerEl.textContent = `${Math.ceil(invincibleTimer)}s`;
        }
        posBroadcastAccum += dt;
        if (posBroadcastAccum >= POS_TICK_INTERVAL && lobby) {
          posBroadcastAccum = 0;
          lobby.relayToRoom({
            t: "pos",
            x: camera.position.x,
            // Deliberately the standing constant, not player.eyeHeight — RemotePlayer avatars
            // have no crouch pose to switch to, so sending the true (shorter) crouched eye
            // height here would make peers see your avatar float slightly above the ground
            // instead of standing on it while you're crouched.
            y: camera.position.y - EYE_HEIGHT, // feet height — RemotePlayer's group origin is feet-relative
            z: camera.position.z,
            rotY: getNetworkYaw(),
            pitch: getNetworkPitch(),
            health: player.health,
            isMoving,
            weaponId: loadout.current.def.id,
          });
        }
      }

      if (matchConfig?.mode === "timeLimit" && matchStartedAt) {
        if ((Date.now() - matchStartedAt) / 1000 >= matchConfig.timeLimitSec) endMatch(null);
      }
    }

    setHud();
  } else if (showMenuBackdrop) {
    const angle = elapsed * MENU_CAM_ORBIT_SPEED;
    camera.position.set(Math.cos(angle) * MENU_CAM_RADIUS, MENU_CAM_HEIGHT, Math.sin(angle) * MENU_CAM_RADIUS);
    camera.lookAt(0, 4, 0);
    if (camera.fov !== BASE_FOV) {
      camera.fov = BASE_FOV;
      camera.updateProjectionMatrix();
    }
  }

  // Re-centers the sun/moon/cloud sprites on the camera's *final* position for this frame
  // (after both the "playing" and menu-flyover branches above have had their chance to move
  // it) — see world.js's updateSky comment for why these can't just sit at a fixed world
  // position the way the sky dome itself does.
  world.updateSky(camera);

  renderer.render(scene, camera);

  debugGraphs.push(rawDt * 1000, renderer.info.memory.geometries, enemies.length, activeFx);
  if (debugVisible) {
    debugGraphs.draw();
    updateDebugPanel(rawDt);
  }
}

animate();
