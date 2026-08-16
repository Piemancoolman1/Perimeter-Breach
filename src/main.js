import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { buildWorld, MAPS, DEFAULT_MAP_ID, setHitboxesVisible } from "./game/world.js";
import { Player, EYE_HEIGHT } from "./game/player.js";
import { updateCorpseParts } from "./game/humanoidParts.js";
import { Loadout } from "./game/loadout.js";
import { GRENADE_DEF, WEAPON_DEFS, CLASSES } from "./game/weaponDefs.js";
import { predictGrenadeArc } from "./game/projectiles.js";
import { GrenadeHeldView } from "./game/grenadeView.js";
import { DebugGraphs } from "./game/debugGraph.js";
import { SoundBank } from "./game/audio.js";
import { TouchControls } from "./game/touchControls.js";
import { el } from "./game/dom.js";
import { settings, createSettingsUi } from "./game/settings.js";
import { createVfx } from "./game/vfx.js";
import { createHud } from "./game/hud.js";
import { createDebugPanel } from "./game/debugPanel.js";
import { createLobbyUi } from "./game/lobbyUi.js";
import { createAbilities } from "./game/abilities.js";
import { createCombat } from "./game/combat.js";
import { createMatchLifecycle } from "./game/matchLifecycle.js";
import { checkForUpdate, showAppVersion } from "./game/updater.js";
import "./style.css";

const TOTAL_KILLS_TO_WIN = 20;
const MAX_ENEMIES = 5;
const ENEMY_RESPAWN_DELAY = 4.5;
const BASE_FOV = 75;
const INFINITE_GRENADES = true; // testing — flip off for normal supply-limited play
const MENU_CAM_HEIGHT = 55;
const MENU_CAM_RADIUS = 42;
const MENU_CAM_ORBIT_SPEED = 0.05; // rad/s — slow drift, ~125s per revolution
const POS_TICK_INTERVAL = 1 / 15;

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

const player = new Player(camera);
const controls = new PointerLockControls(camera, document.body);
scene.add(controls.object);
const loadout = new Loadout(camera);
const grenadeHeldView = new GrenadeHeldView(camera);

const trajectoryLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85 })
);
trajectoryLine.visible = false;
scene.add(trajectoryLine);

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

const debugGraphs = new DebugGraphs({
  frameCanvas: document.getElementById("dbg-graph-frame"),
  geoCanvas: document.getElementById("dbg-graph-geo"),
  loadCanvas: document.getElementById("dbg-graph-load"),
  frameLegendEl: document.getElementById("dbg-graph-legend"),
  geoLegendEl: document.getElementById("dbg-geo-legend"),
  loadLegendEl: document.getElementById("dbg-load-legend"),
});

// --- Shared context object ---------------------------------------------------------------
// Every subsystem below (vfx/hud/debugPanel/lobbyUi/abilities/combat/matchLifecycle) is a
// factory `createX(ctx)` that reads/writes state through this one mutable object rather than
// closing over free-floating module-scope bindings — the only way to split a file this
// interconnected (world/lobby/match state gets reassigned by loadMap()/the lobby flow/match
// start) into separate modules without every module needing a hand-rolled way to see the
// others' latest values. Modules call across to each other via `ctx.otherModule.fn(...)` at
// call time, never a captured reference, so construction order below barely matters — nothing
// invokes another module's method while any factory is still being constructed.
const ctx = {
  TOTAL_KILLS_TO_WIN,
  ENEMY_RESPAWN_DELAY,
  INFINITE_GRENADES,

  scene,
  camera,
  renderer,
  canvas,
  controls,
  clock: new THREE.Clock(),

  player,
  loadout,
  grenadeHeldView,
  sounds,
  debugGraphs,

  settings,
  input,
  raycaster,
  screenCenter,
  getNetworkYaw,
  getNetworkPitch,

  world: null,
  obstacles: null,
  obstacleMeshes: null,
  loadMap,
  showCollisionBoxes: false,

  enemies: [],
  pendingSpawns: [],
  corpseParts: [],

  grenades: [],
  rockets: [],
  remoteRockets: [], // visual-only echoes of a peer's bazooka shot — never deals damage locally
  trajectoryLine,

  remotePlayers: new Map(), // peer id -> RemotePlayer
  scores: new Map(), // player id -> { name, kills }

  lobby: null,
  currentRoom: null,
  currentPlayers: [],
  myPlayerId: null,
  rooms: [],
  selectedRoomId: null,

  inMatch: false, // true once a match is actually running (vs just sitting in the room)
  matchConfig: null, // {mode, target} | {mode, timeLimitSec} | {mode: "freeForAll"}
  matchStartedAt: 0, // server Date.now() from match_started — shared start reference
  hostMatchMode: "killTarget", // killTarget | timeLimit | freeForAll — picked on the room screen
  hostMapId: DEFAULT_MAP_ID, // also picked on the room screen, host-only
  posBroadcastAccum: 0,
  scoreboardVisible: false,

  // true = Spawn In should fully reset (resetGame()/spawnIntoMatch(), the initial-spawn path);
  // false = single-player mid-game class change only — just swap the weapon and resume in
  // place, no repositioning/health/kills reset. Multiplayer ignores this flag entirely and
  // always fully respawns via spawnIntoMatch() regardless of whether this is the very first
  // spawn or a later mid-match change — both are "appear fresh somewhere new" there.
  selectedClassId: CLASSES.find((c) => c.weaponId === "ak47")?.id ?? CLASSES[0].id, // matches Loadout's old always-AK47 default
  classSelectSpawnFresh: true,

  state: "menu", // menu | playing | paused | classSelect | won | lost
  showMenuBackdrop: true, // true while an aerial map flyover should render behind menu/settings overlays
  debugVisible: false,
  kills: 0,

  invincibleTimer: 0, // >0 while immune to damage right after a respawn
  invisibleTimer: 0, // >0 while Assassin's Invisibility is active — purely visual, never blocks damage
  respawnTimer: 0, // >0 while dead and waiting to respawn
  deathHeadPart: null,
  deathCamOffset: new THREE.Vector3(),
  deathCamHeadPos: new THREE.Vector3(),

  fovKick: 0,
  aimHeld: false,
  leftMouseHeld: false,
  grenadeCount: INFINITE_GRENADES ? Infinity : GRENADE_DEF.count,
  grenadeCooldown: 0,
  grenadeHeld: false,
  grenadeHeldTime: 0,
  abilityCooldownRemaining: 0,

  requestPlayLock,
  showClassSelect,
};
loadout.setForceHidden(true); // no gun/player visible over the menu backdrop until a match actually starts

// The active map's meshes/lighting/fog + collision data — rebuilt by loadMap() whenever a
// match starts with a different map selected. Assigning through `ctx` (rather than a bare
// module-scope `let`) is what lets every consumer below (player/enemy/projectile updates,
// hitscan raycasts, abilities) read the current map's data with no other change needed once
// loadMap() reassigns it.
function loadMap(mapId) {
  if (mapId === ctx.world?.mapId) return;
  ctx.world?.dispose();
  ctx.world = buildWorld(scene, mapId);
  ctx.world.mapId = mapId;
  ctx.obstacles = ctx.world.obstacles;
  ctx.obstacleMeshes = ctx.obstacles.map((o) => o.hitboxMesh).filter(Boolean);
  // A fresh buildWorld() call makes new hitbox meshes, which default to hidden same as
  // always — reapply the overlay's current on/off state so it survives a map switch.
  setHitboxesVisible(ctx.obstacles, ctx.showCollisionBoxes);
}
loadMap(DEFAULT_MAP_ID);

ctx.vfx = createVfx(ctx);
ctx.hud = createHud(ctx);
ctx.debugPanel = createDebugPanel(ctx);
ctx.abilities = createAbilities(ctx);
ctx.combat = createCombat(ctx);
ctx.matchLifecycle = createMatchLifecycle(ctx);
ctx.lobbyUi = createLobbyUi(ctx);

// Touch is a pure input-translation layer (see touchControls.js) — every button callback below
// is the exact same function keyboard/mouse already call, not new gameplay logic. Wrapped in
// arrows (rather than passed directly) purely so this construction doesn't have to happen
// after combat/abilities — the wrapper just defers the ctx.combat/ctx.abilities lookup to
// whenever the button is actually pressed, well after every factory above has run.
const touchControls = new TouchControls({
  camera,
  controls,
  input,
  moveZone: el.touchMoveZone,
  lookZone: el.touchLookZone,
  joystickBase: el.touchJoystickBase,
  joystickThumb: el.touchJoystickThumb,
  buttons: {
    fire: { el: el.touchFireBtn, onStart: () => ctx.combat.handleFireStart(), onEnd: () => ctx.combat.handleFireEnd(), dragToAim: true },
    aim: { el: el.touchAimBtn, onStart: () => ctx.combat.handleAimStart(), onEnd: () => ctx.combat.handleAimEnd() },
    jump: { el: el.touchJumpBtn, onStart: () => { input.jumpQueued = true; } },
    ability: { el: el.touchAbilityBtn, onStart: () => ctx.abilities.useAbility() },
    pause: { el: el.touchPauseBtn, onStart: () => enterPausedState() },
  },
  forced: settings.forceTouchControls,
});
ctx.touchControls = touchControls;

createSettingsUi(ctx);

// Landscape-only while actually playing (per confirmed mobile-controls scope) — the touch
// joystick/button layout assumes a wide screen. Menus/lobby screens are plain centered panels
// that work fine in portrait, so this deliberately only blocks the in-game state, not browsing.
const portraitMedia = window.matchMedia("(orientation: portrait)");
function updateRotatePrompt() {
  const shouldShow = touchControls.active && portraitMedia.matches && ctx.state === "playing";
  el.rotateDevicePrompt.classList.toggle("hidden", !shouldShow);
}
portraitMedia.addEventListener("change", updateRotatePrompt);

el.singlePlayerBtn.addEventListener("click", () => {
  el.landing.classList.add("hidden");
  el.menu.classList.remove("hidden");
});

// --- Match mode / map / class pickers (room-screen host controls + the class-select screen) --

function setMatchMode(mode) {
  ctx.hostMatchMode = mode;
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
  ctx.hostMapId = mapId;
  for (const btn of el.mapPicker.querySelectorAll(".map-option")) {
    btn.classList.toggle("selected", btn.dataset.mapId === mapId);
  }
  el.mapDescription.textContent = MAPS[mapId]?.description || "";
}
el.mapPicker.addEventListener("click", (e) => {
  const btn = e.target.closest(".map-option");
  if (btn) setHostMap(btn.dataset.mapId);
});
setHostMap(ctx.hostMapId);

function renderClassPicker() {
  for (const btn of el.classPicker.querySelectorAll(".class-option")) {
    btn.classList.toggle("selected", btn.dataset.classId === ctx.selectedClassId);
  }
  const cls = CLASSES.find((c) => c.id === ctx.selectedClassId);
  const def = WEAPON_DEFS.find((d) => d.id === cls?.weaponId);
  el.classDescription.textContent =
    cls && def
      ? `${cls.tagline} (${def.name} — ${def.magSize} rounds, ${def.fireMode === "auto" ? "full-auto" : "semi-auto"}) — Q: ${cls.ability.name} (${cls.ability.cooldown}s cooldown)`
      : "";
}
el.classPicker.addEventListener("click", (e) => {
  const btn = e.target.closest(".class-option");
  if (!btn) return;
  ctx.selectedClassId = btn.dataset.classId;
  renderClassPicker();
});

// Shows the class-select screen — the caller is responsible for hiding whatever screen it's
// coming from (menu/end-screen/pause-hint/mp screens) first; this only handles the class
// picker itself and the `state` transition, since what surrounds it differs by context.
function showClassSelect(spawnFresh) {
  ctx.classSelectSpawnFresh = spawnFresh;
  renderClassPicker();
  el.classSelectScreen.classList.remove("hidden");
  ctx.state = "classSelect";
}

el.spawnInBtn.addEventListener("click", () => {
  const cls = CLASSES.find((c) => c.id === ctx.selectedClassId) || CLASSES[0];
  loadout.setClass(cls.weaponId);
  el.classSelectScreen.classList.add("hidden");

  if (ctx.inMatch) {
    ctx.matchLifecycle.spawnIntoMatch();
  } else if (ctx.classSelectSpawnFresh) {
    sounds.resume();
    ctx.showMenuBackdrop = false;
    ctx.hud.showGameplayUI();
    ctx.matchLifecycle.resetGame();
    requestPlayLock();
  } else {
    requestPlayLock();
  }
});

el.startMatchBtn.addEventListener("click", () => {
  if (!ctx.lobby || !ctx.lobbyUi.amIHost()) return;
  let config;
  if (ctx.hostMatchMode === "killTarget") {
    config = { mode: "killTarget", target: Math.max(1, Number(el.matchConfigNumberInput.value) || 15) };
  } else if (ctx.hostMatchMode === "timeLimit") {
    config = { mode: "timeLimit", timeLimitSec: Math.max(30, (Number(el.matchConfigNumberInput.value) || 5) * 60) };
  } else {
    config = { mode: "freeForAll" };
  }
  config.mapId = ctx.hostMapId;
  ctx.lobby.startMatch(config);
});

// --- Menu / pause state transitions -------------------------------------------------------

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
  ctx.state = "playing";
}

function enterPausedState() {
  if (ctx.state === "playing") {
    ctx.state = "paused";
    el.pauseHint.classList.remove("hidden");
    loadout.setAiming(false);
    ctx.aimHeld = false;
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
  showClassSelect(false); // false — a single-player change swaps weapons in place, no reset
});

el.exitToMenuBtn.addEventListener("click", () => {
  ctx.state = "menu";
  ctx.showMenuBackdrop = true;
  loadout.setForceHidden(true);
  el.pauseHint.classList.add("hidden");
  el.scopeVignette.classList.add("hidden");
  ctx.hud.hideGameplayUI();

  if (ctx.inMatch) {
    ctx.matchLifecycle.leaveMatchToRoom(); // stays connected to the room — a single-player exit disconnects nothing to keep
  } else {
    el.landing.classList.remove("hidden");
  }
});

// --- Keyboard / mouse / touch input -------------------------------------------------------

// True while the user is actually typing into a text field (room name, player name, password,
// kill-target number, etc.) — the global keydown/keyup listeners below are on `window`, so
// without this guard they intercept every keystroke regardless of what's focused.
function isTypingIntoField() {
  const active = document.activeElement;
  if (!active) return false;
  return active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable;
}

window.addEventListener("keydown", (e) => {
  if (isTypingIntoField()) return;
  if (e.code === "F3") {
    e.preventDefault();
    ctx.debugVisible = !ctx.debugVisible;
    el.debugPanel.classList.toggle("hidden", !ctx.debugVisible);
    return;
  }
  if (e.code === "F4") {
    e.preventDefault();
    ctx.showCollisionBoxes = !ctx.showCollisionBoxes;
    setHitboxesVisible(ctx.obstacles, ctx.showCollisionBoxes);
    el.collisionBoxIndicator.classList.toggle("hidden", !ctx.showCollisionBoxes);
    return;
  }
  if (e.code === "F5") {
    e.preventDefault();
    player.setFlying(!player.flying);
    el.flyModeIndicator.classList.toggle("hidden", !player.flying);
    return;
  }
  if (e.code === "Tab" && ctx.state === "playing" && ctx.inMatch) {
    e.preventDefault(); // otherwise Tab tries to cycle browser focus
    ctx.scoreboardVisible = !ctx.scoreboardVisible;
    el.scoreboardPanel.classList.toggle("hidden", !ctx.scoreboardVisible);
    return;
  }
  // preventDefault on every key this game actually uses — belt-and-suspenders against the
  // browser's own default action for that key (arrow-key/space page scrolling, etc.).
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
    // a page preventDefault() those. A plain unmodified key sidesteps that whole conflict.
    case "KeyC":
      if (settings.toggleCrouch) {
        if (!e.repeat) input.crouch = !input.crouch;
      } else {
        input.crouch = true;
      }
      break;
    case "KeyR":
      if (!e.repeat) ctx.combat.doReload();
      break;
    case "KeyG":
      if (!e.repeat && ctx.state === "playing") ctx.combat.startHoldingGrenade();
      break;
    case "KeyQ":
      if (!e.repeat) ctx.abilities.useAbility();
      break;
  }
});
window.addEventListener("keyup", (e) => {
  // No isTypingIntoField() guard here (unlike keydown) — releasing a key only ever clears a
  // flag or no-ops, never starts something new, so there's no typing interference to prevent.
  switch (e.code) {
    case "KeyW": case "ArrowUp": input.forward = false; break;
    case "KeyS": case "ArrowDown": input.back = false; break;
    case "KeyA": case "ArrowLeft": input.left = false; break;
    case "KeyD": case "ArrowRight": input.right = false; break;
    case "Space": input.up = false; break;
    case "ShiftLeft": case "ShiftRight": input.sprint = false; break;
    case "KeyC": if (!settings.toggleCrouch) input.crouch = false; break;
    case "KeyG": ctx.combat.releaseGrenade(); break;
  }
});

window.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("mousedown", (e) => {
  if (e.button === 0) ctx.combat.handleFireStart();
  if (e.button === 2) ctx.combat.handleAimStart();
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) ctx.combat.handleFireEnd();
  if (e.button === 2) ctx.combat.handleAimEnd();
});

window.addEventListener(
  "wheel",
  (e) => {
    if (ctx.state !== "playing" || ctx.grenadeHeld) return;
    e.preventDefault();
    loadout.cycle(e.deltaY > 0 ? 1 : -1, ctx.aimHeld);
  },
  { passive: false }
);

// --- Main loop -----------------------------------------------------------------------------

const camRight = new THREE.Vector3(); // recomputed once per frame — see health-bar update below
let footstepTimer = 0;
const FOOTSTEP_INTERVAL = 0.33;
const FOOTSTEP_SPRINT_INTERVAL = 0.22;
const FOOTSTEP_SLICE = 0.14;

function animate() {
  requestAnimationFrame(animate);
  const rawDt = ctx.clock.getDelta();
  const dt = Math.min(0.05, rawDt);
  const elapsed = ctx.clock.getElapsedTime();

  updateRotatePrompt();

  if (ctx.state === "playing") {
    // Touch has no dedicated sprint button (per the confirmed mobile-controls scope) — sprint
    // auto-engages whenever the joystick shows any movement, with the existing stamina system
    // (drain/lock/regen) still fully gating it exactly as it does for a held Shift key.
    const touchMoving = Math.abs(input.moveX || 0) > 0.05 || Math.abs(input.moveZ || 0) > 0.05;
    if (touchControls.active) input.sprint = touchMoving || input.forward || input.back || input.left || input.right;

    if (ctx.respawnTimer <= 0) player.update(dt, input, ctx.obstacles, ctx.world.arenaBound, ctx.world.ceilingHeight);

    const isMoving = touchMoving || input.forward || input.back || input.left || input.right;
    loadout.update(dt, elapsed, isMoving);

    // Touch also has no manual reload button — auto-triggers the instant the mag is empty,
    // via the exact same doReload() the R key calls.
    if (touchControls.active && ctx.respawnTimer <= 0 && loadout.current.slot.ammo === 0) ctx.combat.doReload();

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

    if (ctx.leftMouseHeld && !ctx.grenadeHeld && ctx.respawnTimer <= 0 && loadout.current.def.fireMode === "auto") {
      ctx.combat.fireWeapon();
    }

    if (ctx.grenadeHeld) {
      ctx.grenadeHeldTime += dt;
      grenadeHeldView.update(ctx.grenadeHeldTime, elapsed);
      const origin = grenadeHeldView.getWorldPosition(new THREE.Vector3());
      const points = predictGrenadeArc(origin, ctx.combat.grenadeThrowVelocity(), GRENADE_DEF.fuse);
      trajectoryLine.geometry.setFromPoints(points);
      trajectoryLine.visible = true;
    }

    ctx.fovKick *= Math.exp(-16 * dt);
    if (ctx.fovKick < 0.01) ctx.fovKick = 0;
    const targetFov = BASE_FOV + (loadout.current.def.aimFov - BASE_FOV) * loadout.current.view.aimProgress;
    camera.fov = targetFov + ctx.fovKick;
    camera.updateProjectionMatrix();
    // Blends from the general look-sensitivity setting down to the scoped-sensitivity setting
    // as aimProgress goes 0 -> 1, matching the pre-existing hardcoded (1 -> 0.4) feel exactly
    // when both settings are left at their defaults.
    controls.pointerSpeed =
      settings.lookSensitivity - (settings.lookSensitivity - settings.scopedSensitivity) * loadout.current.view.aimProgress;
    el.scopeVignette.classList.toggle("hidden", !loadout.current.view.scopedIn);

    if (ctx.grenadeCooldown > 0) ctx.grenadeCooldown -= dt;

    for (let i = ctx.grenades.length - 1; i >= 0; i--) {
      const g = ctx.grenades[i];
      if (g.update(dt, ctx.obstacles)) {
        ctx.combat.explodeAt(g.position.clone(), GRENADE_DEF.splashRadius, GRENADE_DEF.splashDamage);
        g.destroy();
        ctx.grenades.splice(i, 1);
      }
    }

    for (let i = ctx.rockets.length - 1; i >= 0; i--) {
      const r = ctx.rockets[i];
      if (r.update(dt)) {
        ctx.combat.explodeAt(r.position.clone(), r.splashRadius, r.splashDamage);
        r.destroy();
        ctx.rockets.splice(i, 1);
      }
    }

    for (let i = ctx.remoteRockets.length - 1; i >= 0; i--) {
      const r = ctx.remoteRockets[i];
      if (r.update(dt)) {
        ctx.combat.explodeVisualOnly(r.position.clone(), r.splashRadius); // echo only — never damages locally
        r.destroy();
        ctx.remoteRockets.splice(i, 1);
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
    // enforcement of that; without it, stale enemies left over from an exited single-player
    // round would keep fighting the player (and could even call the single-player-only
    // endGame()) during a "multiplayer" match.
    if (!ctx.inMatch) {
      for (const e of ctx.enemies) {
        const damage = e.update(dt, elapsed, camera.position, ctx.obstacles, ctx.obstacleMeshes, camRight, ctx.invisibleTimer <= 0);
        if (e.justFired) sounds.play("fire_pistol", { volume: 0.35, rate: 0.9 + Math.random() * 0.15 });
        if (damage) {
          player.takeDamage(damage);
          ctx.vfx.flashHit();
          if (player.health <= 0) ctx.hud.endGame(false);
        }
      }
      for (let i = ctx.enemies.length - 1; i >= 0; i--) {
        if (!ctx.enemies[i].alive) ctx.enemies.splice(i, 1);
      }
    }

    // Unconditional, unlike the enemy logic above — corpseParts also holds broken-apart
    // *player* ragdolls from multiplayer eliminations, not just single-player enemy deaths,
    // so this still needs to animate during a match.
    updateCorpseParts(ctx.corpseParts, dt);

    // Every active shield/mine/recon marker counts down regardless of whose it is (own or a
    // peer's, synced via relay) — see clearAllAbilityEffects's comment for the trust-model
    // reasoning. Map's own iterator tolerates deleting the *current* entry mid-iteration
    // (well-defined per spec, unlike some other iterables), which despawnLocalShield/
    // despawnLocalMine do below, so this is safe as written.
    for (const [id, s] of ctx.abilities.activeShields) {
      s.remaining -= dt;
      if (s.remaining <= 0) {
        const wasMine = s.ownerId === ctx.myPlayerId;
        ctx.abilities.despawnLocalShield(id);
        if (wasMine && ctx.inMatch && ctx.lobby) ctx.lobby.relayToRoom({ t: "shield_remove", id });
      }
    }

    for (const [id, m] of ctx.abilities.activeMines) {
      m.remaining -= dt;
      if (m.remaining <= 0) {
        ctx.abilities.despawnLocalMine(id); // safety-net expiry — see MINE_MAX_LIFETIME's own comment
        continue;
      }
      if (m.ownerId !== ctx.myPlayerId) continue; // only the owner's client decides when its own mine goes off
      let triggered = false;
      if (ctx.inMatch) {
        for (const rp of ctx.remotePlayers.values()) {
          if (Math.hypot(rp.group.position.x - m.x, rp.group.position.z - m.z) <= ctx.abilities.MINE_TRIGGER_RADIUS) {
            triggered = true;
            break;
          }
        }
      } else {
        for (const e of ctx.enemies) {
          if (e.alive && Math.hypot(e.group.position.x - m.x, e.group.position.z - m.z) <= ctx.abilities.MINE_TRIGGER_RADIUS) {
            triggered = true;
            break;
          }
        }
      }
      if (triggered) ctx.abilities.triggerMine(id);
    }

    for (let i = ctx.abilities.activeReconMarkers.length - 1; i >= 0; i--) {
      const marker = ctx.abilities.activeReconMarkers[i];
      marker.remaining -= dt;
      if (marker.remaining <= 0 || !marker.targetGroup.parent) {
        scene.remove(marker.sprite);
        ctx.abilities.activeReconMarkers.splice(i, 1);
        continue;
      }
      marker.sprite.position.copy(marker.targetGroup.position);
      marker.sprite.position.y += 2.2; // hover above the head
    }

    if (ctx.abilityCooldownRemaining > 0) {
      ctx.abilityCooldownRemaining = Math.max(0, ctx.abilityCooldownRemaining - dt);
    }
    const equippedClass = CLASSES.find((c) => c.id === ctx.selectedClassId);
    if (equippedClass) {
      el.abilityLabel.textContent = equippedClass.ability.name;
      el.abilityStatus.textContent = ctx.abilityCooldownRemaining > 0 ? `${Math.ceil(ctx.abilityCooldownRemaining)}s` : "Ready (Q)";
    }

    if (!ctx.inMatch) {
      for (let i = ctx.pendingSpawns.length - 1; i >= 0; i--) {
        ctx.pendingSpawns[i] -= dt;
        if (ctx.pendingSpawns[i] <= 0) {
          ctx.pendingSpawns.splice(i, 1);
          if (ctx.enemies.length < MAX_ENEMIES && ctx.state === "playing") ctx.matchLifecycle.spawnEnemy();
        }
      }
    }

    for (const rp of ctx.remotePlayers.values()) {
      const revealedByPulse = ctx.abilities.activeReconMarkers.some((m) => m.targetGroup === rp.group);
      rp.update(dt, camera.position, camRight, revealedByPulse);
    }

    if (ctx.inMatch) {
      if (ctx.respawnTimer > 0) {
        ctx.respawnTimer -= dt;
        el.respawnTimerEl.textContent = `Respawning in ${Math.max(0, Math.ceil(ctx.respawnTimer))}s`;
        if (ctx.deathHeadPart) {
          ctx.deathCamHeadPos.copy(ctx.deathHeadPart.mesh.position);
          camera.position.copy(ctx.deathCamHeadPos).add(ctx.deathCamOffset);
          camera.lookAt(ctx.deathCamHeadPos);
        }
        if (ctx.respawnTimer <= 0) ctx.matchLifecycle.respawnNow();
      } else {
        if (ctx.invincibleTimer > 0) {
          ctx.invincibleTimer -= dt;
          if (ctx.invincibleTimer <= 0) ctx.matchLifecycle.clearInvincible();
          else el.invincibleTimerEl.textContent = `${Math.ceil(ctx.invincibleTimer)}s`;
        }
        // No local HUD/vignette tied to this (unlike invincibleTimer) — invisibility is
        // purely something peers see (via the `invisible` position-tick field below fading
        // to false once this hits 0), so a plain decrement is all that's needed here.
        if (ctx.invisibleTimer > 0) ctx.invisibleTimer -= dt;
        ctx.posBroadcastAccum += dt;
        if (ctx.posBroadcastAccum >= POS_TICK_INTERVAL && ctx.lobby) {
          ctx.posBroadcastAccum = 0;
          ctx.lobby.relayToRoom({
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
            invincible: ctx.invincibleTimer > 0,
            invisible: ctx.invisibleTimer > 0,
          });
        }
      }

      if (ctx.matchConfig?.mode === "timeLimit" && ctx.matchStartedAt) {
        if ((Date.now() - ctx.matchStartedAt) / 1000 >= ctx.matchConfig.timeLimitSec) ctx.matchLifecycle.endMatch(null);
      }
    }

    ctx.hud.setHud();
  } else if (ctx.showMenuBackdrop) {
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
  ctx.world.updateSky(camera);

  renderer.render(scene, camera);

  debugGraphs.push(rawDt * 1000, renderer.info.memory.geometries, ctx.enemies.length, ctx.vfx.activeFx);
  if (ctx.debugVisible) {
    debugGraphs.draw();
    ctx.debugPanel.updateDebugPanel(rawDt);
  }
}

showAppVersion();
checkForUpdate();

animate();
