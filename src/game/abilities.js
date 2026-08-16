import * as THREE from "three";
import { CLASSES } from "./weaponDefs.js";
import { buildShieldWall, removeShieldWall, buildMineMesh, buildReconMarkerSprite } from "./world.js";

const DASH_SPEED = 200; // vs WALK_SPEED 6.5 / sprint ~10.4 — a genuinely dramatic burst (>5x walk
// speed), reined back in by the same ACCEL-based damping normal movement already uses (see
// Player.dash). First attempt (16, ~2.5x walk) read as barely-there; this is a real launch.
const SHIELD_PLACE_DISTANCE = 2.2; // how far in front of the player the wall's center lands
// Exported (not just used internally) — matchLifecycle's handleRelay needs these as fallbacks/
// constants for the "shield_place"/"mine_explode" relay cases.
export const SHIELD_DURATION = 12;
const RECON_PULSE_DURATION = 6;
const MINE_TRIGGER_RADIUS = 2.2;
export const MINE_BLAST_RADIUS = 4;
const MINE_DAMAGE = 300;
const MINE_MAX_LIFETIME = 200; // safety net if it's never triggered (e.g. owner disconnects)
const INVISIBILITY_DURATION = 6;

// The four class abilities (Q): dash, shield wall, recon pulse, proximity mine. Every entry in
// activeShields/activeMines/activeReconMarkers is tracked *regardless of whose it is* —
// including ones placed by peers, synced via relay so this client's own collision/hitscan
// actually respects them (see buildShieldWall's comment for why that's the whole point).
// `ctx.animate()` (main.js) ticks `remaining` on all three every frame; this module only
// creates/destroys entries.
export function createAbilities(ctx) {
  let abilityIdCounter = 0; // -> unique per-shield/mine ids, combined with myPlayerId/"sp"
  const activeShields = new Map(); // id -> { entry, mesh, hitboxMesh, ownerId, remaining }
  const activeMines = new Map(); // id -> { mesh, x, z, ownerId, remaining }
  const activeReconMarkers = []; // [{ sprite, targetGroup, remaining }]

  function useAbility() {
    if (ctx.state !== "playing" || ctx.grenadeHeld || ctx.respawnTimer > 0 || ctx.abilityCooldownRemaining > 0) return;
    const cls = CLASSES.find((c) => c.id === ctx.selectedClassId);
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
      case "invisibility":
        doInvisibility();
        break;
      default:
        return; // unknown ability id — don't burn the cooldown on nothing
    }
    ctx.abilityCooldownRemaining = cls.ability.cooldown;
  }

  // Scout: an instant burst in whatever direction is currently held (falls back to camera-
  // forward if no movement key is pressed) — the same forward/right basis Player.update() uses
  // for normal movement, recomputed here since that math lives inside the Player class, not
  // exposed for reuse.
  function doDash() {
    const forward = new THREE.Vector3();
    ctx.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, ctx.camera.up).normalize();

    let moveX = 0, moveZ = 0;
    if (ctx.input.forward) moveZ += 1;
    if (ctx.input.back) moveZ -= 1;
    if (ctx.input.right) moveX += 1;
    if (ctx.input.left) moveX -= 1;

    const dir = new THREE.Vector3();
    if (moveX !== 0 || moveZ !== 0) dir.addScaledVector(forward, moveZ).addScaledVector(right, moveX);
    else dir.copy(forward);
    ctx.player.dash(dir.x, dir.z, DASH_SPEED);
    ctx.sounds.play("footstep", { volume: 0.6, rate: 1.7 }); // no dedicated dash sfx — a pitched-up footstep reads as a quick burst
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

    spawnLocalShield(id, x, z, rotY, ctx.myPlayerId, SHIELD_DURATION);
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.relayToRoom({ t: "shield_place", id, x, z, rotY, ownerId: ctx.myPlayerId, duration: SHIELD_DURATION });
    }
  }

  function spawnLocalShield(id, x, z, rotY, ownerId, duration) {
    const { mesh, hitboxMesh, entry } = buildShieldWall(ctx.scene, x, z, rotY);
    ctx.obstacles.push(entry);
    ctx.obstacleMeshes.push(hitboxMesh);
    activeShields.set(id, { entry, mesh, hitboxMesh, ownerId, remaining: duration });
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
  function doReconPulse() {
    const targets = ctx.inMatch ? [...ctx.remotePlayers.values()] : ctx.enemies.filter((e) => e.alive);
    for (const t of targets) {
      const sprite = buildReconMarkerSprite();
      ctx.scene.add(sprite);
      activeReconMarkers.push({ sprite, targetGroup: t.group, remaining: RECON_PULSE_DURATION });
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
    spawnLocalMine(id, x, z, ctx.myPlayerId);
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.relayToRoom({ t: "mine_place", id, x, z, ownerId: ctx.myPlayerId });
    }
  }

  function spawnLocalMine(id, x, z, ownerId) {
    const mesh = buildMineMesh();
    mesh.position.set(x, 0, z);
    ctx.scene.add(mesh);
    activeMines.set(id, { mesh, x, z, ownerId, remaining: MINE_MAX_LIFETIME });
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
    ctx.combat.explodeAt(new THREE.Vector3(m.x, 0.15, m.z), MINE_BLAST_RADIUS, MINE_DAMAGE);
    despawnLocalMine(id);
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.relayToRoom({ t: "mine_explode", id });
    }
  }

  // Assassin: no placed object and no relay message of its own — a peer finds out purely by
  // watching `invisible` ride along in this player's own position ticks (main.js), the exact
  // same mechanism the post-respawn invincibility shield already uses for its glow. Fades
  // in/out client-side on every observer's own RemotePlayer instance (remotePlayer.js) rather
  // than needing the fade's progress itself to be networked.
  function doInvisibility() {
    ctx.invisibleTimer = INVISIBILITY_DURATION;
  }

  // Clears every active shield/mine/recon marker regardless of ownership — used wherever match
  // state is already torn down wholesale (match start/end/disconnect, single-player restart),
  // same treatment corpseParts/remotePlayers already get in those same spots.
  function clearAllAbilityEffects() {
    for (const id of [...activeShields.keys()]) despawnLocalShield(id);
    for (const id of [...activeMines.keys()]) despawnLocalMine(id);
    for (const marker of activeReconMarkers) ctx.scene.remove(marker.sprite);
    activeReconMarkers.length = 0;
    ctx.abilityCooldownRemaining = 0;
    ctx.invisibleTimer = 0;
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
