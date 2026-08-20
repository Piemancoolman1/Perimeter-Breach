import * as THREE from "three";

// Decision-making/steering/targeting for single-player AI (Enemy, entities.js) — split out so
// entities.js stays the mesh/state container, matching how the rest of the codebase keeps
// behavior logic (combat.js, abilities.js) separate from the entity classes it acts on.

// Per-archetype stat/weapon overrides, applied on top of Enemy's constructor. `gunner` is
// exactly today's original (pre-archetype) Enemy — the unchanged baseline every other archetype
// is judged against. `sniper`/`rusher` take inspiration from the matching real player weapon in
// weaponDefs.js (WEAPON_DEFS.sniper/.smg — long range & hard-hitting vs. fast & close), but their
// numbers are NOT copied verbatim: the AI fires via a single per-shot hit-chance roll, not a real
// per-bullet simulation, so e.g. the sniper's real 100 damage (a one-shot kill against the
// player's 100 max health) is deliberately scaled down to stay fair against an unpredictable
// hit-chance roll instead of being a coin-flip execution.
// `fireSoundId` mirrors combat.js's own `fire_${def.soundId ?? def.id}` resolution for the
// matching real WEAPON_DEFS entry (smg's real soundId is "ak47"; pistol/sniper have no override
// so it's just their own id) — hardcoded here rather than cross-referencing WEAPON_DEFS at
// call time since it's a stable asset mapping, not something that varies at runtime.
export const ENEMY_ARCHETYPES = {
  gunner: {
    health: 30, speed: 3.0, aggroRange: 22, engageRange: 13, retreatRange: 6,
    gunDamage: 6, fireCooldownMin: 1.1, fireCooldownMax: 1.4, weaponId: "pistol", fireSoundId: "fire_pistol",
  },
  sniper: {
    // Long range, hits hard, fires rarely, doesn't really close, and is fragile if you do
    // manage to get close to it.
    health: 18, speed: 2.4, aggroRange: 30, engageRange: 26, retreatRange: 10,
    gunDamage: 24, fireCooldownMin: 2.2, fireCooldownMax: 2.6, weaponId: "sniper", fireSoundId: "fire_sniper",
  },
  rusher: {
    // Fast, closes to short range and stays there (retreatRange 0 disables backing off
    // entirely), tougher than a gunner to survive the approach, fires quickly but for less
    // per hit.
    health: 45, speed: 4.6, aggroRange: 22, engageRange: 7, retreatRange: 0,
    gunDamage: 9, fireCooldownMin: 0.6, fireCooldownMax: 0.85, weaponId: "smg", fireSoundId: "fire_ak47",
  },
};
export const DEFAULT_ENEMY_ARCHETYPE = "gunner";

// Difficulty escalation, keyed by ctx.kills — both which archetypes can spawn (and their
// relative weight) and how many enemies are allowed alive at once ramp up together instead of
// staying flat for the whole round. Kept as one shared table (rather than a separate threshold
// list in each of main.js/matchLifecycle.js) so the two can never drift out of sync with each
// other. Tier 0's maxEnemies(3)/pool (gunner only) exactly matches the original, pre-archetype
// single-player numbers — a fresh round starts exactly as hard as it always did.
export const DIFFICULTY_TIERS = [
  { minKills: 0, maxEnemies: 3, pool: [{ id: "gunner", weight: 1 }] },
  { minKills: 5, maxEnemies: 4, pool: [{ id: "gunner", weight: 70 }, { id: "sniper", weight: 30 }] },
  { minKills: 10, maxEnemies: 5, pool: [{ id: "gunner", weight: 55 }, { id: "sniper", weight: 25 }, { id: "rusher", weight: 20 }] },
];

// The tier for a given kill count — the last entry whose minKills threshold is met wins (kept
// ordered ascending by minKills).
export function currentDifficultyTier(kills) {
  let tier = DIFFICULTY_TIERS[0];
  for (const t of DIFFICULTY_TIERS) {
    if (kills >= t.minKills) tier = t;
  }
  return tier;
}

// Weighted random pick from a pool of `{id, weight}` — shared by every DIFFICULTY_TIERS pool
// (and any future one-off pool), so they all read from the same one implementation.
export function pickWeightedArchetype(pool) {
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  let r = Math.random() * total;
  for (const p of pool) {
    if (r < p.weight) return p.id;
    r -= p.weight;
  }
  return pool[pool.length - 1].id;
}

// Shared by every raycast-based query below (line-of-sight, steering probes, cover checks) —
// synchronous/single-threaded, so one module-level Raycaster/vector set is safe as long as
// nothing here re-enters before a prior call returns (none of these call each other mid-flight).
const rayCaster = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();
const rayDir = new THREE.Vector3();

const EYE_HEIGHT = 1.5; // shooting/sighting height for these checks, not a rendered eye

// True if anything in obstacleMeshes blocks a straight line from `from` to `to` (both {x,z[,y]},
// y defaults to `originHeight` so callers can pass plain ground-plane positions). The one
// raycast primitive every steering/cover/LOS check below is built from — same obstacle meshes
// the player's own hitscan already raycasts against (walls + rocks; trees aren't in this list
// either, matching the player-side simplification in main.js).
export function raycastBlocked(from, to, obstacleMeshes, originHeight = EYE_HEIGHT) {
  if (!obstacleMeshes || obstacleMeshes.length === 0) return false;
  rayOrigin.set(from.x, originHeight, from.z);
  rayDir.set(to.x - rayOrigin.x, (to.y ?? originHeight) - rayOrigin.y, to.z - rayOrigin.z);
  const dist = rayDir.length();
  if (dist < 0.001) return false;
  rayDir.divideScalar(dist);
  rayCaster.set(rayOrigin, rayDir);
  rayCaster.near = 0.05;
  rayCaster.far = Math.max(0.1, dist - 0.3);
  return rayCaster.intersectObjects(obstacleMeshes, false).length > 0;
}

// Inverse convenience — reads better at a fire-decision call site than `!raycastBlocked(...)`.
export function hasLineOfSight(from, to, obstacleMeshes, originHeight = EYE_HEIGHT) {
  return !raycastBlocked(from, to, obstacleMeshes, originHeight);
}

// Rotates an XZ direction by `angle` radians around Y — same convention already used by
// world.js's localOffsetToWorld (positive angle = the standard THREE Y-rotation sense).
function rotateXZ(x, z, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: x * c + z * s, z: -x * s + z * c };
}

const STEER_PROBE_DEGREES = [25, 50, 80]; // tried both signs at each step, closest-to-direct first

// Picks a movement direction from `fromPos` toward `towardPos` that isn't walking straight into
// an obstacle. resolveCollisions (world.js) only prevents clipping *through* a wall once already
// touching it — it doesn't route around one — so without this, an enemy with the player (or its
// retreat point) behind a wall just walks into the wall and stalls there. This is cheap steering,
// not real pathfinding: raycast the direct line first, and only if that's blocked, sample a
// handful of lateral angles and take the first clear one. `preferSign` biases which side (left/
// right) gets tried first, so a caller that keeps passing back the sign it was given (see
// `Enemy.steerSign`) avoids flickering between left/right choices call to call.
export function chooseSteeringDirection(fromPos, towardPos, obstacleMeshes, preferSign = 1) {
  const dx = towardPos.x - fromPos.x, dz = towardPos.z - fromPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) return { dir: { x: 0, z: 1 }, sign: preferSign };
  const dirX = dx / dist, dirZ = dz / dist;

  if (!raycastBlocked(fromPos, towardPos, obstacleMeshes)) {
    return { dir: { x: dirX, z: dirZ }, sign: preferSign };
  }

  const probeDist = Math.min(dist, 6);
  for (const deg of STEER_PROBE_DEGREES) {
    for (const sign of preferSign >= 0 ? [1, -1] : [-1, 1]) {
      const angle = ((deg * Math.PI) / 180) * sign;
      const rotated = rotateXZ(dirX, dirZ, angle);
      const probeTarget = { x: fromPos.x + rotated.x * probeDist, z: fromPos.z + rotated.z * probeDist };
      if (!raycastBlocked(fromPos, probeTarget, obstacleMeshes)) {
        return { dir: rotated, sign };
      }
    }
  }
  // Boxed in on every sampled angle — fall back to direct anyway. resolveCollisions still
  // prevents clipping through whatever's in the way; this just stops pretending there's a clear
  // route when there genuinely isn't one nearby.
  return { dir: { x: dirX, z: dirZ }, sign: preferSign };
}

const COVER_MIN_OBSTACLE_HEIGHT = 1.2; // shorter than this doesn't actually block a standing player's LOS
const COVER_MAX_SEEK_DISTANCE = 16; // don't bother retreating across the map for cover
const COVER_HIDE_CLEARANCE = 1.2; // hide point's distance outside the obstacle's own half-extent, straight back from the player
const COVER_PEEK_LATERAL_CLEARANCE = 0.6; // peek point's sideways clearance outside the obstacle's own half-extent
const COVER_PEEK_DEPTH_FRACTION = 0.3; // how far forward (toward the obstacle) the peek point sits, as a fraction of its half-extent — keeps hide/peek close together for a quick duck back

// Finds the nearest usable obstacle to duck behind, given the enemy's and player's current
// positions. Deliberately geometry-light (only uses each obstacle's existing x/z/hx/hz/top —
// no dependency on world.js's private box/ellipse footprint math) since this only needs an
// approximate stand point, not an exact one — good enough for a cheap "read as smart" AI trick.
// Returns `{hidePoint, peekPoint, obstacle}` (both points on the side of the obstacle away from
// the player — `hidePoint` fully behind it, `peekPoint` a step closer so LOS opens back up) or
// `null` if nothing suitable is nearby.
export function findCoverPoint(enemyPos, playerPos, obstacles) {
  if (!obstacles || obstacles.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const o of obstacles) {
    if (o.groundOnly || o.shape === "ramp" || o.shape === "roofPrism") continue; // not real standing cover
    if (!o.top || o.top < COVER_MIN_OBSTACLE_HEIGHT) continue;
    const dx = o.x - playerPos.x, dz = o.z - playerPos.z;
    const awayDist = Math.hypot(dx, dz) || 1;
    const awayX = dx / awayDist, awayZ = dz / awayDist;
    // Rotate `away` 90° for a lateral (sideways) direction — peeking has to step to the *side*
    // of the obstacle, not just less-far-back along the same away/player axis, or a ray from the
    // peek point back to the player would still clip straight through the obstacle's own bulk
    // (it's sitting directly between the peek point and the player on that axis either way).
    const perpX = -awayZ, perpZ = awayX;
    const halfExtent = Math.max(o.hx, o.hz);
    const standoff = halfExtent + COVER_HIDE_CLEARANCE;
    const hidePoint = { x: o.x + awayX * standoff, z: o.z + awayZ * standoff };
    const distFromEnemy = Math.hypot(hidePoint.x - enemyPos.x, hidePoint.z - enemyPos.z);
    if (distFromEnemy > COVER_MAX_SEEK_DISTANCE || distFromEnemy >= bestDist) continue;
    bestDist = distFromEnemy;
    const peekLateral = halfExtent + COVER_PEEK_LATERAL_CLEARANCE;
    const peekDepth = halfExtent * COVER_PEEK_DEPTH_FRACTION;
    best = {
      hidePoint,
      peekPoint: {
        x: o.x + awayX * peekDepth + perpX * peekLateral,
        z: o.z + awayZ * peekDepth + perpZ * peekLateral,
      },
      obstacle: o,
    };
  }
  return best;
}

const FLANK_TRIGGER_ANGLE = (35 * Math.PI) / 180; // teammates within this angular separation (as seen from the player) count as "converging on the same line"
const FLANK_ENGAGE_RANGE_MULT = 1.5; // only teammates roughly within their own engage range (times this) count as "already engaging," not just anyone alive on the map

// Cheap angle-only check (no raycasts) for whether `self` is converging on the player from
// roughly the same angle as an already-engaging teammate — if so, returns which side (+1/-1) to
// peel off toward so the group spreads out instead of stacking on one line; returns 0 if there's
// no such conflict (nothing to correct for). `teammates` is the full enemy list — self and dead
// entries are skipped internally, so a caller can just pass the whole array.
export function chooseFlankBias(self, teammates, playerPos) {
  if (!teammates || teammates.length === 0) return 0;
  const selfAngle = Math.atan2(self.group.position.x - playerPos.x, self.group.position.z - playerPos.z);
  let closestDelta = Math.PI;
  let conflictSign = 0;
  for (const other of teammates) {
    if (other === self || !other.alive) continue;
    const otherDist = Math.hypot(other.group.position.x - playerPos.x, other.group.position.z - playerPos.z);
    if (otherDist > other.engageRange * FLANK_ENGAGE_RANGE_MULT) continue;
    const otherAngle = Math.atan2(other.group.position.x - playerPos.x, other.group.position.z - playerPos.z);
    let delta = selfAngle - otherAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    if (Math.abs(delta) < Math.abs(closestDelta)) {
      closestDelta = delta;
      conflictSign = delta >= 0 ? 1 : -1;
    }
  }
  return Math.abs(closestDelta) < FLANK_TRIGGER_ANGLE ? conflictSign : 0;
}
