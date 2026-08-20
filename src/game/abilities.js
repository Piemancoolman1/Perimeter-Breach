import * as THREE from "three";
import { CLASSES } from "./weaponDefs.js";
import { buildShieldWall, removeShieldWall, buildMineMesh, buildReconMarkerSprite } from "./world.js";
import {
  ABILITY_DURATIONS,
  MINE_DAMAGE,
  OVERCLOCK_DURATION,
  OVERCLOCK_FIRE_RATE_MULT,
  RECON_PULSE_DURATION,
} from "../../shared/abilityConstants.js";

// Re-exported so combat.js's existing `from "./abilities.js"` import keeps working unchanged —
// the real definition now lives in shared/abilityConstants.js (see its own comment for why).
export { OVERCLOCK_FIRE_RATE_MULT };

const SHIELD_PLACE_DISTANCE = 2.2; // how far in front of the player the wall's center lands
// combat.js applies this to whatever weapon is currently equipped while the timer is running —
// not SMG-specific, since Scout can also be holding the pistol sidearm when Q is pressed.
export const OVERCLOCK_RECOIL_MULT = 0.15; // near-zero viewmodel kick, not literally zero (still reads as "firing")
// Exported (not just used internally) — matchLifecycle's handleAbilityUsed needs this as a
// fallback/constant when spawning a peer's shield from a server broadcast.
export const SHIELD_DURATION = ABILITY_DURATIONS.shield;
const MINE_TRIGGER_RADIUS = 2.2;
export const MINE_BLAST_RADIUS = 4;

// The class abilities (Q): overclock, shield wall, recon pulse, proximity mine, invisibility. Every entry in
// activeShields/activeMines/activeReconMarkers is tracked *regardless of whose it is* —
// including ones placed by peers, synced via relay so this client's own collision/hitscan
// actually respects them (see buildShieldWall's comment for why that's the whole point).
// Every entry's `until` is an absolute Date.now()-style timestamp, not a countdown — comparing
// against the wall clock (rather than ticking a `remaining` field down by `dt` every frame,
// the old approach) means expiry is correct the instant `ctx.animate()` (main.js) resumes
// running after any gap, including the whole game being paused — a `dt`-based countdown simply
// stops advancing while paused and never catches up. `ctx.animate()` only *checks* `until`
// against `Date.now()`; this module only creates/destroys entries.
export function createAbilities(ctx) {
  let abilityIdCounter = 0; // -> unique per-shield/mine ids, combined with myPlayerId/"sp"
  const activeShields = new Map(); // id -> { entry, mesh, hitboxMesh, ownerId, until }
  const activeMines = new Map(); // id -> { mesh, x, z, ownerId, until }
  const activeReconMarkers = []; // [{ sprite, targetGroup, until }]

  function useAbility() {
    if (ctx.state !== "playing" || ctx.grenadeHeld || ctx.respawnAt > Date.now() || ctx.abilityCooldownUntil > Date.now()) return;
    const cls = CLASSES.find((c) => c.id === ctx.selectedClassId);
    if (!cls) return;
    switch (cls.ability.id) {
      case "overclock":
        doOverclock();
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
      case "invisibility":
        doInvisibility();
        break;
      default:
        return; // unknown ability id — don't burn the cooldown on nothing
    }
    ctx.abilityCooldownUntil = Date.now() + cls.ability.cooldown * 1000;
  }

  // Scout: temporarily boosts whatever weapon is currently equipped — faster fire rate, no
  // spread, minimal viewmodel recoil kick — applied by combat.js/loadout.js/weapon.js checking
  // ctx.overclockUntil directly (the same "set a ctx timestamp, let consumers compare it" pattern
  // Assassin's Invisibility already established), rather than this module reaching into weapon
  // state itself. Purely local/self-only, unlike Invisibility or Shield — nothing about it needs
  // to be network-synced, since a peer just observes faster incoming fire, not a distinct pose
  // or a world object they need their own client to respect.
  function doOverclock() {
    ctx.overclockUntil = Date.now() + OVERCLOCK_DURATION * 1000;
    ctx.sounds.play("hitmarker", { volume: 0.5, rate: 1.4 }); // no dedicated activation sfx — a pitched-up hitmarker reads as a quick power-up blip
    // Still self-only (no peer ever needs to *see* this), but the server now needs to know a
    // player's Overclock window to legitimately allow their faster server-side fire-rate check
    // (see report_fire/handleReportFire) — same use_ability round trip as Shield/Mine/
    // Invisibility, just correcting ctx.overclockUntil's optimistic local estimate afterward.
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.useAbility({ abilityId: "overclock" });
    }
  }

  // Assault: deploys a solid, temporary wall directly in front of the player, facing them —
  // its thin axis lines up with the camera's own forward direction via getNetworkYaw() (the
  // same yaw convention already used to orient a RemotePlayer avatar), so a peer's synced copy
  // renders at the exact angle this player is actually facing. Pushed into the *live*
  // obstacles/obstacleMeshes arrays (not just the visual scene) so it actually blocks
  // movement/hitscan/AI line-of-sight, not just decoration — see buildShieldWall's own comment.
  function placeShield() {
    const rotY = ctx.getNetworkYaw();
    const forward = new THREE.Vector3();
    ctx.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const x = ctx.camera.position.x + forward.x * SHIELD_PLACE_DISTANCE;
    const z = ctx.camera.position.z + forward.z * SHIELD_PLACE_DISTANCE;
    const id = `${ctx.myPlayerId || "sp"}_shield_${abilityIdCounter++}`;
    const until = Date.now() + SHIELD_DURATION * 1000;

    spawnLocalShield(id, x, z, rotY, ctx.myPlayerId, until);
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.useAbility({ abilityId: "shield", id, x, z, rotY });
    }
  }

  function spawnLocalShield(id, x, z, rotY, ownerId, until) {
    const { mesh, hitboxMesh, entry } = buildShieldWall(ctx.scene, x, z, rotY);
    ctx.obstacles.push(entry);
    ctx.obstacleMeshes.push(hitboxMesh);
    activeShields.set(id, { entry, mesh, hitboxMesh, ownerId, until });
  }

  function despawnLocalShield(id) {
    const s = activeShields.get(id);
    if (!s) return;
    const oi = ctx.obstacles.indexOf(s.entry);
    if (oi !== -1) ctx.obstacles.splice(oi, 1);
    const mi = ctx.obstacleMeshes.indexOf(s.hitboxMesh);
    if (mi !== -1) ctx.obstacleMeshes.splice(mi, 1);
    removeShieldWall(ctx.scene, s);
    activeShields.delete(id);
  }

  // Recon: reveals every enemy currently known to this client (AI in single-player, remote
  // players in multiplayer — never both, there's no AI at all during a match) with a marker
  // rendered through walls. No networking involved at all: this only visualizes information the
  // client already has locally (AI state / position ticks), it isn't asking anyone for anything.
  // A remote player currently in Invisibility is excluded — the whole point of that ability is
  // to vanish, and Recon Pulse shouldn't be able to see through it (AI enemies have no
  // equivalent concept, so the single-player branch is untouched).
  function doReconPulse() {
    const targets = ctx.inMatch
      ? [...ctx.remotePlayers.values()].filter((rp) => !rp.targetInvisible)
      : ctx.enemies.filter((e) => e.alive);
    for (const t of targets) {
      const sprite = buildReconMarkerSprite();
      ctx.scene.add(sprite);
      activeReconMarkers.push({ sprite, targetGroup: t.group, until: Date.now() + RECON_PULSE_DURATION * 1000 });
    }
  }

  // Demolition: places a mine at the player's feet. Deliberately not a collision obstacle at
  // all (meant to be walked over, not blocked by) — trigger detection is a plain per-frame
  // proximity check owned entirely by *this* client for mines *this* client placed (see the
  // per-frame update loop in animate()), matching the project's established "each client is
  // authoritative for damage it deals" trust model. A mine synced from a peer's placement is
  // purely a visual copy here; their own client is what actually decides when it goes off.
  function placeMine() {
    const x = ctx.camera.position.x;
    const z = ctx.camera.position.z;
    const id = `${ctx.myPlayerId || "sp"}_mine_${abilityIdCounter++}`;
    spawnLocalMine(id, x, z, ctx.myPlayerId, Date.now() + ABILITY_DURATIONS.mine * 1000);
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.useAbility({ abilityId: "mine", id, x, z });
    }
  }

  function spawnLocalMine(id, x, z, ownerId, until) {
    const mesh = buildMineMesh();
    mesh.position.set(x, 0, z);
    ctx.scene.add(mesh);
    activeMines.set(id, { mesh, x, z, ownerId, until });
  }

  function despawnLocalMine(id) {
    const m = activeMines.get(id);
    if (!m) return;
    ctx.scene.remove(m.mesh);
    activeMines.delete(id);
  }

  // Detonates a mine THIS client owns (called only from the per-frame trigger check, never for
  // a peer's mine) — full splash damage via the same explodeAt() a grenade/rocket already uses
  // (so kill-crediting/remote-hit-relay/enemy-splash all just work, no separate path needed),
  // plus telling peers to remove their copy of it (and see the explosion) too.
  function triggerMine(id) {
    const m = activeMines.get(id);
    if (!m) return;
    ctx.combat.explodeAt(new THREE.Vector3(m.x, 0.15, m.z), MINE_BLAST_RADIUS, MINE_DAMAGE, "mine");
    despawnLocalMine(id);
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.relayToRoom({ t: "mine_explode", id });
    }
  }

  // Assassin: no placed object, so the only thing peers need is the server-issued expiry — sent
  // via use_ability/ability_used (see matchLifecycle's handleAbilityUsed) rather than a
  // self-reported flag riding along in this player's own position ticks, which is what let a
  // modified client simply claim to be invisible forever. Fades in/out client-side on every
  // observer's own RemotePlayer instance (remotePlayer.js) rather than needing the fade's
  // progress itself to be networked.
  function doInvisibility() {
    ctx.invisibleUntil = Date.now() + ABILITY_DURATIONS.invisibility * 1000;
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.useAbility({ abilityId: "invisibility" });
    }
  }

  // Clears every active shield/mine/recon marker regardless of ownership — used wherever match
  // state is already torn down wholesale (match start/end/disconnect, single-player restart),
  // same treatment corpseParts/remotePlayers already get in those same spots.
  function clearAllAbilityEffects() {
    for (const id of [...activeShields.keys()]) despawnLocalShield(id);
    for (const id of [...activeMines.keys()]) despawnLocalMine(id);
    for (const marker of activeReconMarkers) ctx.scene.remove(marker.sprite);
    activeReconMarkers.length = 0;
    ctx.abilityCooldownUntil = 0;
    ctx.invisibleUntil = 0;
    ctx.overclockUntil = 0;
  }

  return {
    activeShields,
    activeMines,
    activeReconMarkers,
    MINE_TRIGGER_RADIUS,
    useAbility,
    spawnLocalShield,
    despawnLocalShield,
    spawnLocalMine,
    despawnLocalMine,
    triggerMine,
    clearAllAbilityEffects,
  };
}
