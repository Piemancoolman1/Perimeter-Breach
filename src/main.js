import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { buildWorld, MAPS, DEFAULT_MAP_ID, setHitboxesVisible, preloadRockModels } from "./game/world.js";
import { Player, EYE_HEIGHT } from "./game/player.js";
import { updateCorpseParts, preloadCharacterModel } from "./game/humanoidParts.js";
import { RemotePlayer } from "./game/remotePlayer.js";
import { Loadout } from "./game/loadout.js";
import { GRENADE_DEF, WEAPON_DEFS, CLASSES } from "./game/weaponDefs.js";
import { predictGrenadeArc } from "./game/projectiles.js";
import { GrenadeHeldView } from "./game/grenadeView.js";
import { DebugGraphs } from "./game/debugGraph.js";
import { SoundBank } from "./game/audio.js";
import { TouchControls } from "./game/touchControls.js";
import { el } from "./game/dom.js";
import { settings, createSettingsUi } from "./game/settings.js";
import { createPatchNotesUi } from "./game/patchNotesUi.js";
import { createAccountUi } from "./game/accountUi.js";
import { createVfx } from "./game/vfx.js";
import { createHud } from "./game/hud.js";
import { createDebugPanel } from "./game/debugPanel.js";
import { createLobbyUi } from "./game/lobbyUi.js";
import { createScreenManager } from "./game/screens.js";
import { createAbilities } from "./game/abilities.js";
import { createCombat } from "./game/combat.js";
import { createMatchLifecycle } from "./game/matchLifecycle.js";
import { currentDifficultyTier } from "./game/enemyAI.js";
import { checkForUpdate, showAppVersion, setupQuitGame } from "./game/updater.js";
import "./style.css";

const TOTAL_KILLS_TO_WIN = 20;
const ENEMY_RESPAWN_DELAY = 4.5;
const BASE_FOV = 75;
const INFINITE_GRENADES = true; // testing — flip off for normal supply-limited play
const MENU_CAM_HEIGHT = 55;
const MENU_CAM_RADIUS = 42;
const MENU_CAM_ORBIT_SPEED = 0.05; // rad/s — slow drift, ~125s per revolution
const POS_TICK_INTERVAL = 1 / 15;
const GAME_LOAD_MIN_MS = 900; // floor on how long the loading curtain stays up, even though the work behind it is effectively instant

const canvas = document.getElementById("scene");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.03, 300);
// A dedicated camera for the idle menu flyover — never touched by PointerLockControls, weapon
// viewmodels, or aim-zoom/fire-kick FOV logic, so the flyover can't inherit leftover gameplay
// camera state (previously it had to defensively reset `camera.fov` every frame for exactly
// that reason). Same lens params as the gameplay camera purely so the two don't look different.
const menuCamera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.03, 300);

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
  menuCamera.aspect = window.innerWidth / window.innerHeight;
  menuCamera.updateProjectionMatrix();
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

// Fire-and-forget, same as sounds above — kicked off as early as possible (the user needs to
// click through at least the main menu before any body is actually built) rather than gated on
// anything, since buildHumanoidBody() falls back to the primitive rig on its own if this hasn't
// finished yet (see humanoidParts.js).
preloadCharacterModel();

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
  devSpectatorBody: null, // dev tool (F6) — a RemotePlayer standing in for "you", so you can fly around and look back at yourself
  devSpectatorRotY: 0,
  devSpectatorPitch: 0,

  enemies: [],
  pendingSpawns: [],
  corpseParts: [],

  grenades: [],
  rockets: [],
  remoteRockets: [], // visual-only echoes of a peer's bazooka shot — never deals damage locally
  trajectoryLine,

  remotePlayers: new Map(), // peer id -> RemotePlayer
  // player id -> { invisibleUntil, invincibleUntil } — server-issued (see matchLifecycle's
  // handleAbilityUsed/handleRespawnScheduled), kept separate from RemotePlayer instances since
  // those get destroyed/recreated across a death (applyElim deletes one on elimination; it's
  // lazily recreated on that player's next "pos" tick post-respawn), which would otherwise lose
  // whatever effect state lived directly on the instance.
  remoteEffectUntil: new Map(),
  scores: new Map(), // player id -> { name, kills }

  lobby: null,
  currentRoom: null,
  currentPlayers: [],
  myPlayerId: null,
  rooms: [],
  selectedRoomId: null,

  inMatch: false, // true once a match is actually running (vs just sitting in the room)
  matchConfig: null, // {mode, target} | {mode, timeLimitSec} | {mode: "freeForAll"}
  hostMatchMode: "killTarget", // killTarget | timeLimit | freeForAll — picked on the room screen
  hostMapId: DEFAULT_MAP_ID, // also picked on the room screen, host-only
  posBroadcastAccum: 0,
  scoreboardVisible: false,

  // true = Spawn In should fully reset (startSession()/spawnIntoMatch(), the initial-spawn path);
  // false = single-player mid-game class change only — just swap the weapon and resume in
  // place, no repositioning/health/kills reset. Multiplayer ignores this flag entirely and
  // always fully respawns via spawnIntoMatch() regardless of whether this is the very first
  // spawn or a later mid-match change — both are "appear fresh somewhere new" there.
  selectedClassId: CLASSES.find((c) => c.weaponId === "smg")?.id ?? CLASSES[0].id, // matches Loadout's DEFAULT_WEAPON_ID
  classSelectSpawnFresh: true,

  state: "menu", // menu | playing | paused | classSelect | won | lost
  showMenuBackdrop: true, // true while an aerial map flyover should render behind menu/settings overlays
  debugVisible: false,
  kills: 0,

  invincibleUntil: 0, // epoch ms; still immune to damage while Date.now() < this, right after a respawn
  invisibleUntil: 0, // epoch ms; Assassin's Invisibility is active while Date.now() < this — purely visual, never blocks damage
  overclockUntil: 0, // epoch ms; Scout's Overclock is active while Date.now() < this — boosts fire rate/spread/recoil, checked directly by combat.js
  respawnAt: 0, // epoch ms; still dead and waiting to respawn while Date.now() < this
  pendingInvincibleUntil: 0, // epoch ms, server-issued; applied by respawnNow() at the moment respawn actually fires
  deathHeadPart: null,
  deathCamOffset: new THREE.Vector3(),
  deathCamHeadPos: new THREE.Vector3(),

  fovKick: 0,
  aimHeld: false,
  leftMouseHeld: false,
  burstShotsQueued: 0, // Assault's battle rifle — shots still owed from the current burst (see combat.js's updateBurstFire)
  burstCooldownRemaining: 0, // time left before the next burst may start
  grenadeCount: INFINITE_GRENADES ? Infinity : GRENADE_DEF.count,
  grenadeCooldown: 0,
  grenadeHeld: false,
  grenadeHeldTime: 0,
  abilityCooldownUntil: 0, // epoch ms; ability is on cooldown while Date.now() < this
  eliminatedMessage: "", // set by matchLifecycle's startRespawnSequence, read by updateDeathUI
  deadPauseMenuOpen: false, // while dead: false shows #respawn-overlay, true shows the full #pause-hint (toggled by Esc/touch pause — see handlePauseToggle)

  requestPlayLock,
  showClassSelect,
  updateDeathUI,
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

// The map above just got built with whatever rock visuals were available at that instant
// (almost certainly the procedural fallback — this runs synchronously at app init, before
// preloadRockModels' fetch has any chance to finish) and loadMap() only rebuilds on an actual
// map *change*, so on a default-map session those rocks would otherwise stay procedural for the
// entire session even after the real models finish loading moments later. upgradeRockVisuals()
// swaps any still-procedural rock meshes in the currently active world over to the model once
// it's ready; a no-op if the world was already rebuilt (map switch) after the model loaded.
preloadRockModels().then(() => ctx.world?.upgradeRockVisuals?.());

ctx.vfx = createVfx(ctx);
ctx.hud = createHud(ctx);
// #hud has no default `display: none` in CSS (showGameplayUI()/hideGameplayUI() only ever
// toggle an inline style), and every other place that hides it does so reactively, on
// actually *leaving* gameplay (exitToMenuBtn, endGame, leaveMatchToRoom, ...) — there was
// never a call for the very first state of all, before any match has started or ended, so
// the HUD sat visible by default with placeholder values right from initial page load.
ctx.hud.hideGameplayUI();
ctx.debugPanel = createDebugPanel(ctx);
ctx.abilities = createAbilities(ctx);
ctx.combat = createCombat(ctx);
ctx.matchLifecycle = createMatchLifecycle(ctx);
ctx.screens = createScreenManager();
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
    pause: { el: el.touchPauseBtn, onStart: () => handlePauseToggle() },
  },
  forced: settings.forceTouchControls,
});
ctx.touchControls = touchControls;

createSettingsUi(ctx);
createPatchNotesUi(ctx);
createAccountUi(ctx);

// Landscape-only while actually playing (per confirmed mobile-controls scope) — the touch
// joystick/button layout assumes a wide screen. Menus/lobby screens are plain centered panels
// that work fine in portrait, so this deliberately only blocks the in-game state, not browsing.
const portraitMedia = window.matchMedia("(orientation: portrait)");
function updateRotatePrompt() {
  const shouldShow = touchControls.active && portraitMedia.matches && ctx.state === "playing";
  el.rotateDevicePrompt.classList.toggle("hidden", !shouldShow);
}
portraitMedia.addEventListener("change", updateRotatePrompt);

// The corner version badge is only useful for reading "which build am I on" while parked on a
// menu/pause screen — during actual gameplay it just clutters the bottom-left corner, and the
// same info is already mirrored into the pause menu (see showAppVersion() in updater.js). Only
// touches the badge if a version was actually loaded (plain browser/web builds never populate
// it, so this must not force it visible there).
function updateAppVersionVisibility() {
  const inGame = ctx.state === "playing" || ctx.state === "paused";
  if (el.appVersion.textContent) el.appVersion.classList.toggle("hidden", inGame);
  // Not Tauri-gated (unlike the version badge) — patch notes are static data, not a Tauri API
  // read, so this stays available in a plain browser tab too. Same corner-badge treatment,
  // just the opposite corner: hidden during actual gameplay, visible everywhere else.
  el.patchNotesBtn.classList.toggle("hidden", inGame);
}

// Covers the moment a fresh single-player game or multiplayer match actually begins — runs
// `startFn` immediately (synchronously, so it stays inside the click's user-gesture stack for
// controls.lock()'s Pointer Lock request), then holds an opaque curtain over the screen for at
// least GAME_LOAD_MIN_MS before revealing whatever startFn just put on screen. There's no real
// asynchronous load to gate on here (see the call sites) — this is deliberately just a fixed
// pause, so "entering the game" reads as a distinct step instead of the menu instantly snapping
// into gameplay.
function showLoadingCurtain(startFn) {
  el.loadingScreen.classList.remove("hidden");
  startFn();
  setTimeout(() => el.loadingScreen.classList.add("hidden"), GAME_LOAD_MIN_MS);
}

el.singlePlayerBtn.addEventListener("click", () => ctx.screens.showScreen(el.menu));

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

function fireModeLabel(def) {
  if (def.fireMode === "auto") return "full-auto";
  if (def.fireMode === "burst") return `${def.burstCount}-round burst`;
  return "semi-auto";
}

function renderClassPicker() {
  for (const btn of el.classPicker.querySelectorAll(".class-option")) {
    btn.classList.toggle("selected", btn.dataset.classId === ctx.selectedClassId);
  }
  const cls = CLASSES.find((c) => c.id === ctx.selectedClassId);
  const def = WEAPON_DEFS.find((d) => d.id === cls?.weaponId);
  el.classDescription.textContent =
    cls && def
      ? `${cls.tagline} (${def.name} — ${def.magSize} rounds, ${fireModeLabel(def)}) — Q: ${cls.ability.name} (${cls.ability.cooldown}s cooldown)`
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
  ctx.screens.showScreen(el.classSelectScreen);
  ctx.state = "classSelect";
}

el.spawnInBtn.addEventListener("click", () => {
  // Change Class stays reachable/browsable at any time while dead, but must not let a player
  // actually spawn back in before the server-enforced respawn wait has passed — that's exactly
  // what locking the dedicated Respawn button behind a timer is supposed to guarantee, and this
  // is just as real a way to spawn back into the match as that button is.
  if (ctx.inMatch && ctx.respawnAt > Date.now()) return;
  const cls = CLASSES.find((c) => c.id === ctx.selectedClassId) || CLASSES[0];
  loadout.setClass(cls.weaponId);
  ctx.screens.showScreen(null);

  if (ctx.inMatch) {
    // classSelectSpawnFresh distinguishes "first spawn right after this match started" (worth
    // the loading curtain) from "mid-match class change via the pause menu" (ctx.inMatch is
    // also true there, but nothing is actually loading — just a loadout swap in place).
    if (ctx.classSelectSpawnFresh) {
      showLoadingCurtain(() => ctx.matchLifecycle.spawnIntoMatch());
    } else {
      ctx.matchLifecycle.spawnIntoMatch();
    }
  } else if (ctx.classSelectSpawnFresh) {
    showLoadingCurtain(() => {
      sounds.resume();
      ctx.showMenuBackdrop = false;
      ctx.hud.showGameplayUI();
      ctx.matchLifecycle.startSession({ mode: "singleplayer" });
      requestPlayLock();
    });
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

el.startBtn.addEventListener("click", () => showClassSelect(true));

el.restartBtn.addEventListener("click", () => showClassSelect(true));

// Extracted so touch-mode code paths (no Pointer Lock API involved at all) can reach the
// exact same state transition directly, instead of only ever firing from a real lock/unlock
// browser event.
function enterPlayingState() {
  ctx.screens.showScreen(null);
  ctx.state = "playing";
}

// Pausing freezes the entire `if (ctx.state === "playing")` branch of animate() below —
// including physics (gravity) and the position-tick broadcast — so a player who pauses mid-jump
// would otherwise leave every peer staring at them frozen floating in midair: RemotePlayer has no
// gravity of its own, it's purely driven by whatever "pos" tick last arrived, and once paused, no
// more ever do. Rather than let that happen, resolve the fall synchronously right now — reusing
// Player.update()'s own gravity/landing logic (so it lands correctly on a rock/roof/car exactly
// like normal movement would, not just straight down to y=0) — then send one last corrected "pos"
// tick immediately, since the regular per-frame broadcast is about to stop firing entirely.
const STILL_INPUT = { forward: false, back: false, left: false, right: false, sprint: false, crouch: false, jumpQueued: false };
function settleToGroundIfAirborne() {
  if (player.onGround) return;
  STILL_INPUT.crouch = player.crouching;
  const SETTLE_DT = 1 / 60;
  for (let i = 0; i < 300 && !player.onGround; i++) {
    player.update(SETTLE_DT, STILL_INPUT, ctx.obstacles, ctx.world.arenaBound, ctx.world.ceilingHeight);
  }
  if (ctx.inMatch && ctx.lobby) {
    ctx.lobby.relayToRoom({
      t: "pos",
      x: camera.position.x,
      y: camera.position.y - EYE_HEIGHT,
      z: camera.position.z,
      rotY: getNetworkYaw(),
      pitch: getNetworkPitch(),
      isMoving: false,
      weaponId: loadout.current.def.id,
    });
  }
}

function enterPausedState() {
  if (ctx.state === "playing") {
    // Dying releases the pointer lock itself (see startRespawnSequence), purely so the separate
    // #respawn-overlay's button is actually clickable — that fires this exact same "unlock"
    // listener, but it must NOT open the real pause menu: death has its own UI
    // (#respawn-overlay, toggled with the full pause menu via handlePauseToggle/updateDeathUI), a
    // real pause only ever applies while alive.
    if (ctx.respawnAt > 0) return;
    settleToGroundIfAirborne();
    ctx.state = "paused";
    ctx.screens.showScreen(el.pauseHint);
    loadout.setAiming(false);
    ctx.aimHeld = false;
    if (settings.hideCrosshairWhileAiming) el.crosshair.style.display = "";
  }
}

// Esc (desktop) and the touch pause button both route through here, so a real pause and a dead
// player's "peek at the full menu" toggle share one place. While dead this has nothing to do with
// ctx.state/Pointer Lock at all (the cursor's already released — see startRespawnSequence); it
// just flips which of two independent, mutually-exclusive-while-dead overlays is showing.
function handlePauseToggle() {
  if (ctx.respawnAt > 0) {
    ctx.deadPauseMenuOpen = !ctx.deadPauseMenuOpen;
    ctx.screens.showScreen(ctx.deadPauseMenuOpen ? el.pauseHint : null);
    updateDeathUI();
    return;
  }
  if (ctx.state === "playing") enterPausedState();
}

// Keeps #respawn-overlay's countdown/button and #pause-hint's title/Resume-visibility correct —
// called unconditionally every animate() frame (like updateRotatePrompt already is) so the
// countdown keeps ticking regardless of which screen (or neither) is currently showing, and so a
// death that happens *while already paused* updates live without needing to close/reopen anything.
function updateDeathUI() {
  const dead = ctx.respawnAt > 0;
  el.respawnOverlay.classList.toggle("hidden", !dead || ctx.deadPauseMenuOpen);
  el.pauseTitle.textContent = dead ? ctx.eliminatedMessage : "Paused";
  el.pauseTitle.classList.toggle("eliminated", dead);
  // Nothing to "resume" to while dead — respawning happens from #respawn-overlay's own button
  // instead; Back returns to that screen (see its click handler). Change Class stays available
  // and unrestricted the whole time (the player's call).
  el.resumeBtn.classList.toggle("hidden", dead);
  el.backToRespawnBtn.classList.toggle("hidden", !dead);
  if (!dead) return;
  el.respawnTitle.textContent = ctx.eliminatedMessage;
  const now = Date.now();
  if (now >= ctx.respawnAt) {
    el.respawnBtn.disabled = false;
    el.respawnBtn.textContent = "Respawn";
  } else {
    el.respawnBtn.disabled = true;
    el.respawnBtn.textContent = `Respawn in ${Math.max(0, Math.ceil((ctx.respawnAt - now) / 1000))}s`;
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

// The dead-state counterpart to Resume — toggles back to #respawn-overlay, same as pressing Esc
// or the touch pause button again (see handlePauseToggle). Needed as an actual in-menu button,
// not just a key/touch-button shortcut, since the touch pause button is covered by this very
// overlay and can't be tapped again from here.
el.backToRespawnBtn.addEventListener("click", () => handlePauseToggle());

// Manual respawn — replaces the old auto-respawn-on-timer, which was exactly what let a paused
// player respawn "in the background" without controlling it. The button itself is only ever
// enabled once ctx.respawnAt has actually passed (see updateDeathUI), but the disabled
// attribute doesn't stop a stale click event from a frame where it *was* just enabled, so this
// re-checks directly rather than trusting the DOM state alone.
el.respawnBtn.addEventListener("click", () => {
  if (ctx.respawnAt <= 0 || Date.now() < ctx.respawnAt) return;
  ctx.matchLifecycle.respawnNow();
  requestPlayLock();
});

el.changeClassBtn.addEventListener("click", () => showClassSelect(false)); // false — a single-player change swaps weapons in place, no reset

el.exitToMenuBtn.addEventListener("click", () => {
  ctx.showMenuBackdrop = true;
  loadout.setForceHidden(true);
  el.scopeVignette.classList.add("hidden");

  if (ctx.inMatch) {
    ctx.matchLifecycle.leaveMatchToRoom(); // stays connected to the room — a single-player exit disconnects nothing to keep
  } else {
    ctx.matchLifecycle.endSession("menu"); // single-player exit — previously left enemies/corpses/grenades/abilities fully live under the menu flyover
    ctx.screens.showScreen(el.landing);
  }
});

// --- Dev tool (F6): step outside your own body ---------------------------------------------

// The local player normally has no visible body at all (first person never renders one) —
// this builds a real one (reusing RemotePlayer, the exact same body/weapon/Invisibility-fade
// code a peer would see you with) frozen at wherever you toggled it on, then hands control to
// the existing F5 noclip flight so you can fly around and actually look at yourself — e.g. to
// check an ability's visual effect, which is otherwise something only a peer could ever see.
// Pressing F6 again drops you back into first person exactly where the frozen body is standing.
function toggleDevSpectator() {
  if (ctx.devSpectatorBody) {
    const body = ctx.devSpectatorBody;
    camera.position.set(body.group.position.x, body.group.position.y + player.eyeHeight, body.group.position.z);
    camera.rotation.set(0, ctx.devSpectatorRotY, 0);
    body.destroy(scene);
    ctx.devSpectatorBody = null;
    player.setFlying(false);
    el.spectatorIndicator.classList.add("hidden");
  } else {
    const x = camera.position.x;
    const z = camera.position.z;
    const y = camera.position.y - player.eyeHeight; // feet height, matching the position-tick convention
    const rotY = getNetworkYaw();
    const pitch = getNetworkPitch();
    const body = new RemotePlayer(scene, "dev-spectator", "You", 0, x, z);
    body.updateFromNetwork(x, y, z, rotY, false, loadout.current.def.id, pitch);
    body.maxHealth = player.maxHealth;
    body.health = player.health;
    ctx.devSpectatorBody = body;
    ctx.devSpectatorRotY = rotY;
    ctx.devSpectatorPitch = pitch;
    player.setFlying(true);
    el.spectatorIndicator.classList.remove("hidden");
  }
}

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
  if (e.code === "F6") {
    e.preventDefault();
    toggleDevSpectator();
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
      if (!e.repeat && ctx.state === "playing" && ctx.respawnAt <= Date.now()) ctx.combat.startHoldingGrenade();
      break;
    case "KeyQ":
      if (!e.repeat) ctx.abilities.useAbility();
      break;
    // Only meaningful while dead — while alive/locked, the browser's own pointer-lock Escape
    // handling already drives enterPausedState() via the "unlock" event; the cursor's already
    // out here (death releases it), so there's no lock for a real Escape press to exit at all.
    case "Escape":
      if (!e.repeat && ctx.respawnAt > 0) handlePauseToggle();
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
    // Abandon any in-progress burst/cooldown from whichever weapon was just switched away
    // from — otherwise switching back to a burst weapon later could fire its leftover queued
    // shots the instant it's re-equipped, with no trigger pull at all.
    ctx.burstShotsQueued = 0;
    ctx.burstCooldownRemaining = 0;
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
  updateAppVersionVisibility();
  // Unconditional (unlike almost everything below) so the countdown keeps ticking regardless of
  // which death-related screen (or neither) is showing — including the case where a death happens
  // *while already paused* (a "hit" can arrive at any time).
  updateDeathUI();

  if (ctx.state === "playing") {
    // Touch has no dedicated sprint button (per the confirmed mobile-controls scope) — sprint
    // auto-engages whenever the joystick shows any movement, with the existing stamina system
    // (drain/lock/regen) still fully gating it exactly as it does for a held Shift key.
    const touchMoving = Math.abs(input.moveX || 0) > 0.05 || Math.abs(input.moveZ || 0) > 0.05;
    if (touchControls.active) input.sprint = touchMoving || input.forward || input.back || input.left || input.right;

    if (ctx.respawnAt <= Date.now()) player.update(dt, input, ctx.obstacles, ctx.world.arenaBound, ctx.world.ceilingHeight);

    const isMoving = touchMoving || input.forward || input.back || input.left || input.right;
    loadout.update(dt, elapsed, isMoving);

    // Touch also has no manual reload button — auto-triggers the instant the mag is empty,
    // via the exact same doReload() the R key calls.
    if (touchControls.active && ctx.respawnAt <= Date.now() && loadout.current.slot.ammo === 0) ctx.combat.doReload();

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

    if (ctx.leftMouseHeld && !ctx.grenadeHeld && ctx.respawnAt <= Date.now() && loadout.current.def.fireMode === "auto") {
      ctx.combat.fireWeapon();
    }
    ctx.combat.updateBurstFire(dt);

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
        ctx.combat.explodeAt(g.position.clone(), GRENADE_DEF.splashRadius, GRENADE_DEF.splashDamage, "grenade");
        g.destroy();
        ctx.grenades.splice(i, 1);
      }
    }

    for (let i = ctx.rockets.length - 1; i >= 0; i--) {
      const r = ctx.rockets[i];
      if (r.update(dt, ctx.obstacles)) {
        ctx.combat.explodeAt(r.position.clone(), r.splashRadius, r.splashDamage, "bazooka");
        r.destroy();
        ctx.rockets.splice(i, 1);
      }
    }

    for (let i = ctx.remoteRockets.length - 1; i >= 0; i--) {
      const r = ctx.remoteRockets[i];
      if (r.update(dt, ctx.obstacles)) {
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
        const damage = e.update(dt, elapsed, camera.position, ctx.obstacles, ctx.obstacleMeshes, camRight, ctx.invisibleUntil <= Date.now(), player.velocity, ctx.enemies);
        if (e.justFired) sounds.play(e.fireSoundId, { volume: 0.35, rate: 0.9 + Math.random() * 0.15 });
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

    // Every active shield/mine/recon marker expires regardless of whose it is (own or a peer's,
    // synced via the server-issued `until` from ability_used — see clearAllAbilityEffects's
    // comment for the trust-model reasoning). Compared against the wall clock (not ticked down by
    // dt) so expiry is correct the instant this loop resumes running after any gap, including the
    // whole game being paused. No message needs sending on expiry — every client (owner or
    // bystander) independently reaches the same `until` and despawns on its own, so there's
    // nothing to tell anyone. Map's own iterator tolerates deleting the *current* entry
    // mid-iteration (well-defined per spec, unlike some other iterables), which
    // despawnLocalShield/despawnLocalMine do below, so this is safe as written.
    const effectsNow = Date.now();
    for (const [id, s] of ctx.abilities.activeShields) {
      if (effectsNow >= s.until) ctx.abilities.despawnLocalShield(id);
    }

    for (const [id, m] of ctx.abilities.activeMines) {
      if (effectsNow >= m.until) {
        ctx.abilities.despawnLocalMine(id); // safety-net expiry — see ABILITY_DURATIONS.mine's own comment
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
      if (effectsNow >= marker.until || !marker.targetGroup.parent) {
        scene.remove(marker.sprite);
        ctx.abilities.activeReconMarkers.splice(i, 1);
        continue;
      }
      marker.sprite.position.copy(marker.targetGroup.position);
      marker.sprite.position.y += 2.2; // hover above the head
    }

    const equippedClass = CLASSES.find((c) => c.id === ctx.selectedClassId);
    if (equippedClass) {
      el.abilityLabel.textContent = equippedClass.ability.name;
      // Overclock's duration (2s) is shorter than its cooldown (30s) and runs concurrently with
      // it — without this, the status would jump straight to a cooldown countdown the instant
      // it's used, with nothing telling the player the buff itself is still live.
      el.abilityStatus.textContent =
        equippedClass.ability.id === "overclock" && ctx.overclockUntil > effectsNow
          ? `Active ${Math.ceil((ctx.overclockUntil - effectsNow) / 1000)}s`
          : ctx.abilityCooldownUntil > effectsNow
            ? `${Math.ceil((ctx.abilityCooldownUntil - effectsNow) / 1000)}s`
            : "Ready (Q)";
    }

    if (!ctx.inMatch) {
      for (let i = ctx.pendingSpawns.length - 1; i >= 0; i--) {
        ctx.pendingSpawns[i] -= dt;
        if (ctx.pendingSpawns[i] <= 0) {
          ctx.pendingSpawns.splice(i, 1);
          const maxEnemies = currentDifficultyTier(ctx.kills).maxEnemies;
          if (ctx.enemies.length < maxEnemies && ctx.state === "playing") ctx.matchLifecycle.spawnEnemy();
        }
      }
    }

    for (const rp of ctx.remotePlayers.values()) {
      const revealedByPulse = ctx.abilities.activeReconMarkers.some((m) => m.targetGroup === rp.group);
      const effects = ctx.remoteEffectUntil.get(rp.id);
      const rpInvincible = !!effects && effects.invincibleUntil > effectsNow;
      const rpInvisible = !!effects && effects.invisibleUntil > effectsNow;
      rp.update(dt, camera.position, camRight, revealedByPulse, rpInvincible, rpInvisible);
    }

    // Dev spectator (F6): position/rotation/pitch stay frozen at wherever it was toggled on
    // (see toggleDevSpectator) — only weapon/Invisibility are kept live, so an ability pressed
    // while flying around still visibly reacts on the body being watched. Health no longer rides
    // on this call at all (see updateFromNetwork's own comment — server-authoritative now); this
    // call site previously still passed the old 8-arg (x,y,z,rotY,health,isMoving,weaponId,pitch)
    // shape after that signature changed, silently misaligning every argument from `isMoving`
    // onward (weaponId landed in isMoving's slot, pitch — an actual number — landed in weaponId's
    // slot as a string, etc.), corrupting the arm's rotation math into NaN and making it appear
    // to collapse/disconnect. Fixed to match the current (x,y,z,rotY,isMoving,weaponId,pitch)
    // signature.
    if (ctx.devSpectatorBody) {
      const body = ctx.devSpectatorBody;
      body.updateFromNetwork(body.targetPos.x, body.targetPos.y, body.targetPos.z, ctx.devSpectatorRotY, false, loadout.current.def.id, ctx.devSpectatorPitch);
      body.maxHealth = player.maxHealth; // health/maxHealth aren't part of updateFromNetwork's own args (see its comment) — set directly
      body.health = player.health;
      body.update(dt, camera.position, camRight, false, ctx.invincibleUntil > effectsNow, ctx.invisibleUntil > effectsNow);
    }

    // Invisibility/Overclock/respawn/invincibility are all plain Date.now()-vs-`until`
    // comparisons now (see abilities.js's own comment) — nothing here needs a per-frame `-= dt`
    // tick at all, which is exactly what let pausing (skipping this whole block) permanently
    // freeze them before: a countdown that stops advancing never catches up, but a wall-clock
    // comparison is correct again the instant this block runs, no matter how long the gap was.
    if (ctx.inMatch) {
      if (ctx.respawnAt > 0) {
        // No auto-respawn anymore — respawning is the player's own call, via #respawn-overlay's
        // button (updateDeathUI handles its countdown/enabled state, called unconditionally every
        // frame regardless of ctx.state — see the top of animate()).
        if (ctx.deathHeadPart) {
          ctx.deathCamHeadPos.copy(ctx.deathHeadPart.mesh.position);
          camera.position.copy(ctx.deathCamHeadPos).add(ctx.deathCamOffset);
          camera.lookAt(ctx.deathCamHeadPos);
        }
      } else {
        if (ctx.invincibleUntil > 0) {
          if (effectsNow >= ctx.invincibleUntil) ctx.matchLifecycle.clearInvincible();
          else el.invincibleTimerEl.textContent = `${Math.ceil((ctx.invincibleUntil - effectsNow) / 1000)}s`;
        }
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
            // Health no longer rides along here — see matchLifecycle.js's handleDamageApplied/
            // handlePlayerSpawned, the server-authoritative sources of truth for it now.
            isMoving,
            weaponId: loadout.current.def.id,
          });
        }
      }

      // Time-limit matches used to be ended by each client's own local clock — now the server
      // runs the actual timer and broadcasts "match_ended" (see server/index.js's handleStartMatch/
      // finalizeMatch, and lobbyUi.js's onMatchEnded), so nothing needs checking here anymore.
    }

    ctx.hud.setHud();
  } else if (ctx.showMenuBackdrop) {
    const angle = elapsed * MENU_CAM_ORBIT_SPEED;
    menuCamera.position.set(Math.cos(angle) * MENU_CAM_RADIUS, MENU_CAM_HEIGHT, Math.sin(angle) * MENU_CAM_RADIUS);
    menuCamera.lookAt(0, 4, 0);
  }

  // Whichever camera is actually being displayed this frame — the gameplay camera keeps
  // rendering (frozen, whatever it last showed) while paused, since `showMenuBackdrop` is only
  // true once a match has actually been left, not just paused mid-match.
  const activeCamera = ctx.showMenuBackdrop ? menuCamera : camera;

  // Re-centers the sun/moon/cloud sprites on the camera's *final* position for this frame
  // (after both the "playing" and menu-flyover branches above have had their chance to move
  // it) — see world.js's updateSky comment for why these can't just sit at a fixed world
  // position the way the sky dome itself does.
  ctx.world.updateSky(activeCamera);

  renderer.render(scene, activeCamera);

  debugGraphs.push(rawDt * 1000, renderer.info.memory.geometries, ctx.enemies.length, ctx.vfx.activeFx);
  if (ctx.debugVisible) {
    debugGraphs.draw();
    ctx.debugPanel.updateDebugPanel(rawDt);
  }
}

showAppVersion();
checkForUpdate();
setupQuitGame(ctx);

animate();
