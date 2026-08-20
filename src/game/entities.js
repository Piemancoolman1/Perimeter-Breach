import * as THREE from "three";
import { ARENA_BOUND, resolveCollisions } from "./world.js";
import {
  clamp,
  sharedHumanoidParts,
  buildWeaponProp,
  buildHumanoidBody,
  buildHealthBar,
  updateHealthBarSprite,
  updateNameplateVisibility,
  WALK_LEG_SWING,
  WALK_ARM_SWING,
  AIM_ARM_ANGLE,
  breakApartHumanoid,
} from "./humanoidParts.js";
import {
  hasLineOfSight,
  chooseSteeringDirection,
  findCoverPoint,
  chooseFlankBias,
  ENEMY_ARCHETYPES,
  DEFAULT_ENEMY_ARCHETYPE,
} from "./enemyAI.js";

const RADIUS = 0.35;
const FLASH_DURATION = 0.08;
const STEER_RECHECK_INTERVAL = 0.3; // seconds — see chooseSteeringDirection's own comment for why this doesn't need to be per-frame

const LEAD_TIME = 0.2; // seconds of player velocity aimed ahead of, for both the fire-LOS check and the hit-chance roll
const LATERAL_DODGE_PENALTY = 0.015; // per unit/s of player lateral speed, subtracted from hit chance — leading claws most, not all, of this back

const COVER_HEALTH_FRACTION = 0.35; // health/maxHealth below which a cover cycle can trigger
const COVER_EXIT_FRACTION = 0.6; // health/maxHealth above which the cycle voluntarily ends early (from "hiding")
const COVER_ABANDON_RANGE_MULT = 1.3; // beyond aggroRange * this, or invisible, abandons cover back to normal
const COVER_HIDE_DURATION = 1.4;
const COVER_PEEK_DURATION = 1.1;
const COVER_ARRIVE_TOLERANCE = 0.6;
const CROUCH_LERP_RATE = 6; // same lerp style as aimAmount/swingAmount below
const CROUCH_HEIGHT_DROP = 0.22;
const CROUCH_LEG_BEND = 0.35; // radians, additive on top of the existing walk-swing rotation

const SEARCH_DURATION = 4; // seconds spent pushing toward a lost last-known position before giving up
const SEARCH_ARRIVE_TOLERANCE = 1.2;
const FLANK_LATERAL_OFFSET_MAX = 6; // world units, capped so flanking doesn't send an enemy on a wide detour when already close

const IDLE_WANDER_RADIUS = 6; // stays within this of its own spawn point — no aggro means no reason to roam the map
const IDLE_WALK_SPEED_MULT = 0.4;
const IDLE_ARRIVE_TOLERANCE = 0.5;
const IDLE_PAUSE_MIN = 1.5;
const IDLE_PAUSE_MAX = 4;
const IDLE_LOOK_AMPLITUDE = 0.5; // radians either side of idleBaseFacing while paused
const IDLE_LOOK_SPEED = 0.4;

function buildEnemyMesh(weaponId) {
  const s = sharedHumanoidParts();
  const { group, visual, torso, head, leftLeg, rightLeg, leftArm, rightArm } = buildHumanoidBody(s);

  const gun = buildWeaponProp(s, weaponId);
  rightArm.add(gun.group);

  const hitbox = new THREE.Mesh(s.hitboxGeo, s.clothingMat);
  hitbox.position.y = 0.9;
  hitbox.visible = false;
  group.add(hitbox);

  // Health bar attaches to `group` (not `visual`), so it stays level and never spins
  // with the body's facing rotation.
  const { healthBarBg, healthBarFg, healthBarFgMat } = buildHealthBar(s, group);

  // Whole-limb chunks used for the death ragdoll — detaching at this granularity (rather than
  // every individual box) keeps corpse breakup readable (arms/legs/head/torso flying apart)
  // instead of exploding into a dozen tiny cubes, and keeps the per-frame physics cost small.
  const parts = [torso, head, leftLeg, rightLeg, leftArm, rightArm];

  return {
    group,
    visual,
    hitbox,
    leftLeg,
    rightLeg,
    leftArm,
    rightArm,
    gun,
    parts,
    healthBarBg,
    healthBarFg,
    healthBarFgMat,
  };
}

export class Enemy {
  constructor(scene, x, z, archetypeId = DEFAULT_ENEMY_ARCHETYPE) {
    const archetype = ENEMY_ARCHETYPES[archetypeId] || ENEMY_ARCHETYPES[DEFAULT_ENEMY_ARCHETYPE];
    this.archetypeId = ENEMY_ARCHETYPES[archetypeId] ? archetypeId : DEFAULT_ENEMY_ARCHETYPE;

    this.alive = true;
    this.health = archetype.health;
    this.maxHealth = archetype.health;
    this.speed = archetype.speed;
    this.aggroRange = archetype.aggroRange;
    this.engageRange = archetype.engageRange; // stops closing and starts shooting once inside this
    this.retreatRange = archetype.retreatRange; // backs away if the player gets this close (0 disables retreat entirely — see the rusher archetype)
    this.gunDamage = archetype.gunDamage;
    this.fireSoundId = archetype.fireSoundId;
    this.fireCooldownMax = archetype.fireCooldownMin + Math.random() * (archetype.fireCooldownMax - archetype.fireCooldownMin);
    this.fireCooldown = Math.random() * this.fireCooldownMax; // desync volleys across spawns
    this.flashTime = 0;
    this.justFired = false;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafePhase = Math.random() * Math.PI * 2;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.facing = 0;
    this.swingAmount = 0;
    this.aimAmount = 0; // 0 = arms hang/walk-swing, 1 = raised into an aiming stance

    // Obstacle-aware steering cache (see chooseSteeringDirection in enemyAI.js) — recomputed on
    // a timer, not every frame, and only when the movement mode (close/retreat) actually changes
    // in between; `steerSign` is fed back in each recompute so the chosen side doesn't flicker.
    this.steerDir = null;
    this.steerSign = Math.random() < 0.5 ? 1 : -1;
    this.steerMode = null;
    this.steerRecheckAt = 0;

    // Cover-seeking cycle (see findCoverPoint in enemyAI.js): "normal" is today's plain range-
    // band behavior; the other three states are a self-contained detour that overrides it until
    // health recovers or the cycle completes/aborts.
    this.state = "normal"; // "normal" | "moveToCover" | "hiding" | "peeking"
    this.coverHidePoint = null;
    this.coverPeekPoint = null;
    this.coverPhaseUntil = 0;
    this.crouchAmount = 0; // 0 = standing, 1 = full cover crouch — lerped, same technique as aimAmount

    // Last-known-position search: `hasVisualLock` is a throttled (not per-frame) raycast check,
    // separate from `playerVisible`/aggro range — a bot can be aggro'd (knows roughly where the
    // player is) without currently having a clear sightline to them (e.g. a wall's now between
    // them). Losing the lock after having it starts a `searching` episode toward the last spot
    // it was actually seen, instead of the original code's omniscient live-position tracking.
    this.hasVisualLock = true;
    this.lastKnownPlayerPos = null;
    this.searching = false;
    this.searchUntil = 0;
    this.visualCheckAt = 0;

    // Idle wander (no aggro at all) — stays within IDLE_WANDER_RADIUS of its own spawn point,
    // walking to a new nearby point, pausing with a subtle look-around, then picking another.
    this.spawnX = x;
    this.spawnZ = z;
    this.idleTarget = null;
    this.idleWaitUntil = 0;
    this.idleBaseFacing = 0;
    this.idleFacingPhase = Math.random() * Math.PI * 2;

    const built = buildEnemyMesh(archetype.weaponId);
    this.group = built.group;
    this.visual = built.visual;
    this.mesh = built.hitbox; // raycast target used by combat code
    this.leftLeg = built.leftLeg;
    this.rightLeg = built.rightLeg;
    this.leftArm = built.leftArm;
    this.rightArm = built.rightArm;
    this.gunFlash = built.gun.flash;
    this.gunFlashMat = built.gun.flashMat;
    this.gunFlashLight = built.gun.flashLight;
    this.parts = built.parts; // whole-limb chunks used for the death ragdoll
    this.healthBarBg = built.healthBarBg;
    this.healthBarFg = built.healthBarFg;
    this.healthBarFgMat = built.healthBarFgMat;

    this.group.position.set(x, 0, z);
    scene.add(this.group);
  }

  updateHealthBar(cameraRight) {
    updateHealthBarSprite(this.healthBarFg, this.healthBarFgMat, this.health / this.maxHealth, cameraRight);
  }

  // Refreshes `this.steerDir` from chooseSteeringDirection, but only when actually needed: the
  // movement mode changed since the last call (close vs retreat want a different target/steering
  // decision), the recheck timer elapsed, or this is the very first call. Otherwise reuses the
  // cached direction — this is what keeps the extra raycast(s) this adds bounded to roughly one
  // every STEER_RECHECK_INTERVAL per enemy, not one every frame.
  updateSteering(mode, target, obstacleMeshes, elapsed) {
    if (this.steerDir !== null && this.steerMode === mode && elapsed < this.steerRecheckAt) return;
    const steered = chooseSteeringDirection(this.group.position, target, obstacleMeshes, this.steerSign);
    this.steerDir = steered.dir;
    this.steerSign = steered.sign;
    this.steerMode = mode;
    this.steerRecheckAt = elapsed + STEER_RECHECK_INTERVAL;
  }

  pickIdleTarget() {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * IDLE_WANDER_RADIUS;
    return { x: this.spawnX + Math.cos(angle) * radius, z: this.spawnZ + Math.sin(angle) * radius };
  }

  // `playerVisible` (default true — every other caller/context has nothing to hide) is
  // Assassin's Invisibility: false makes the AI treat the player as if they'd walked out of
  // aggro range entirely — no tracking, no aiming, no shots — rather than just making shots
  // less likely to land. A human opponent can still land a lucky hit on an invisible player
  // (see combat.js — that's a deliberate difference from AI, which has no way to "remember"
  // a rough last-known position the way a person tracking sound/movement might).
  update(dt, elapsed, playerPos, obstacles, obstacleMeshes, cameraRight, playerVisible = true, playerVelocity = null, teammates = null) {
    if (!this.alive) return null;
    this.justFired = false;

    const toPlayer = new THREE.Vector3(
      playerPos.x - this.group.position.x,
      0,
      playerPos.z - this.group.position.z
    );
    const dist = toPlayer.length();
    const dir = dist > 0.0001 ? toPlayer.divideScalar(dist) : new THREE.Vector3(0, 0, 1);

    // Cover-seeking: triggers once per low-health episode (health has to climb back above
    // COVER_EXIT_FRACTION, or the cycle has to abort/complete, before it can retrigger — see the
    // abandon check below and the "hiding" exit condition further down). See findCoverPoint in
    // enemyAI.js for how a hide/peek pair is chosen; this only starts the cycle.
    if (this.state === "normal" && playerVisible && dist < this.aggroRange && this.health / this.maxHealth < COVER_HEALTH_FRACTION) {
      const cover = findCoverPoint(this.group.position, playerPos, obstacles);
      if (cover) {
        this.coverHidePoint = cover.hidePoint;
        this.coverPeekPoint = cover.peekPoint;
        this.state = "moveToCover";
      }
    }
    // Abandon an in-progress cycle if the player's gone (out of range or invisible) — otherwise
    // an enemy could get stuck permanently peeking at nothing.
    if (this.state !== "normal" && (!playerVisible || dist >= this.aggroRange * COVER_ABANDON_RANGE_MULT)) {
      this.state = "normal";
    }

    let moving = false;
    let canFireNow = false;
    if (this.state !== "normal") {
      // Cover cycle overrides normal range-band movement entirely until it exits back to
      // "normal" (health recovered, or the cycle is abandoned above). Still tracks/faces the
      // player throughout, same as normal engagement.
      this.facing = Math.atan2(-dir.x, -dir.z);

      if (this.state === "moveToCover") {
        this.updateSteering("cover", this.coverHidePoint, obstacleMeshes, elapsed);
        this.group.position.x += this.steerDir.x * this.speed * dt;
        this.group.position.z += this.steerDir.z * this.speed * dt;
        moving = true;
        const distToHide = Math.hypot(
          this.group.position.x - this.coverHidePoint.x,
          this.group.position.z - this.coverHidePoint.z
        );
        if (distToHide < COVER_ARRIVE_TOLERANCE) {
          this.state = "hiding";
          this.coverPhaseUntil = elapsed + COVER_HIDE_DURATION;
        }
      } else if (this.state === "hiding") {
        if (this.health / this.maxHealth > COVER_EXIT_FRACTION) {
          this.state = "normal"; // recovered enough to voluntarily rejoin the fight
        } else if (elapsed >= this.coverPhaseUntil) {
          this.state = "peeking";
          this.coverPhaseUntil = elapsed + COVER_PEEK_DURATION;
        }
      } else if (this.state === "peeking") {
        this.updateSteering("cover", this.coverPeekPoint, obstacleMeshes, elapsed);
        const distToPeek = Math.hypot(
          this.group.position.x - this.coverPeekPoint.x,
          this.group.position.z - this.coverPeekPoint.z
        );
        if (distToPeek > 0.4) {
          this.group.position.x += this.steerDir.x * this.speed * 0.8 * dt;
          this.group.position.z += this.steerDir.z * this.speed * 0.8 * dt;
          moving = true;
        } else {
          canFireNow = playerVisible && dist < this.aggroRange; // holding the peek spot — not gated by engageRange, this is a fixed defensive position
        }
        if (elapsed >= this.coverPhaseUntil) {
          this.state = "hiding";
          this.coverPhaseUntil = elapsed + COVER_HIDE_DURATION;
        }
      }
    } else {
      const hasAggro = playerVisible && dist < this.aggroRange;
      if (!hasAggro) {
        // Player's gone entirely (out of range or invisible) — reset search state so a stale
        // episode doesn't linger into a later, unrelated aggro window.
        this.searching = false;
        this.hasVisualLock = true;

        // Idle wander instead of standing completely frozen — reads as "alive," not a dummy
        // waiting to be aggro'd. Never leaves the vicinity of its own spawn point.
        if (this.idleTarget === null) {
          this.idleTarget = this.pickIdleTarget();
        }
        const idleDx = this.group.position.x - this.idleTarget.x;
        const idleDz = this.group.position.z - this.idleTarget.z;
        if (Math.hypot(idleDx, idleDz) > IDLE_ARRIVE_TOLERANCE) {
          this.updateSteering("idle", this.idleTarget, obstacleMeshes, elapsed);
          this.group.position.x += this.steerDir.x * this.speed * IDLE_WALK_SPEED_MULT * dt;
          this.group.position.z += this.steerDir.z * this.speed * IDLE_WALK_SPEED_MULT * dt;
          moving = true;
          this.facing = Math.atan2(-this.steerDir.x, -this.steerDir.z);
          this.idleWaitUntil = 0;
        } else {
          if (this.idleWaitUntil === 0) {
            this.idleWaitUntil = elapsed + IDLE_PAUSE_MIN + Math.random() * (IDLE_PAUSE_MAX - IDLE_PAUSE_MIN);
            this.idleBaseFacing = this.facing;
          }
          this.facing = this.idleBaseFacing + Math.sin(elapsed * IDLE_LOOK_SPEED + this.idleFacingPhase) * IDLE_LOOK_AMPLITUDE;
          if (elapsed >= this.idleWaitUntil) {
            this.idleTarget = this.pickIdleTarget();
            this.idleWaitUntil = 0;
          }
        }
      } else {
        // Throttled (not per-frame) real raycast, separate from the plain aggro-range/visibility
        // gate above — see the field comment in the constructor for why this exists.
        if (elapsed >= this.visualCheckAt) {
          this.hasVisualLock = hasLineOfSight(this.group.position, playerPos, obstacleMeshes);
          this.visualCheckAt = elapsed + STEER_RECHECK_INTERVAL;
        }
        if (this.hasVisualLock) {
          this.lastKnownPlayerPos = { x: playerPos.x, z: playerPos.z };
          this.searching = false;
        } else if (this.lastKnownPlayerPos && !this.searching) {
          this.searching = true;
          this.searchUntil = elapsed + SEARCH_DURATION;
        }

        if (this.hasVisualLock || !this.lastKnownPlayerPos) {
          // Live engagement — today's original range-band behavior, unchanged except for the
          // steering/flanking layered on top of the "close" sub-branch.
          // Negated on purpose: THREE's rotation.y convention maps local -Z (the model's front,
          // where the eye sits) to (-sin θ, -cos θ), which is -dir at θ = atan2(dir.x, dir.z) —
          // i.e. the un-negated form actually turns the character's back to the player. Verified
          // numerically against the real rig; this is a pre-existing bug, not new in this change.
          this.facing = Math.atan2(-dir.x, -dir.z);

          if (dist > this.engageRange) {
            // out of range — close the distance, steering around anything directly in the way
            // instead of walking straight into it (see chooseSteeringDirection), and biased
            // sideways if a teammate's already converging on the same angle (see chooseFlankBias)
            let closeTarget = playerPos;
            const flankSign = chooseFlankBias(this, teammates, playerPos);
            if (flankSign !== 0) {
              const perpX = -dir.z, perpZ = dir.x;
              const lateral = Math.min(FLANK_LATERAL_OFFSET_MAX, dist * 0.4);
              closeTarget = {
                x: playerPos.x + perpX * lateral * flankSign,
                z: playerPos.z + perpZ * lateral * flankSign,
              };
            }
            this.updateSteering("close", closeTarget, obstacleMeshes, elapsed);
            this.group.position.x += this.steerDir.x * this.speed * dt;
            this.group.position.z += this.steerDir.z * this.speed * dt;
            moving = true;
          } else if (dist < this.retreatRange) {
            // too close for a gunner to want to be — back off (still facing the player via `dir`
            // below), steering around anything in the way of the retreat path
            const retreatTarget = {
              x: this.group.position.x - dir.x * 6,
              z: this.group.position.z - dir.z * 6,
            };
            this.updateSteering("retreat", retreatTarget, obstacleMeshes, elapsed);
            this.group.position.x += this.steerDir.x * this.speed * 0.7 * dt;
            this.group.position.z += this.steerDir.z * this.speed * 0.7 * dt;
            moving = true;
          } else {
            // holds range and strafes side to side instead of standing still in the open
            this.strafePhase += dt * 1.6;
            const strafeSpeed = Math.sin(this.strafePhase) * this.speed * 0.5 * this.strafeDir;
            this.group.position.x += dir.z * strafeSpeed * dt;
            this.group.position.z += -dir.x * strafeSpeed * dt;
            moving = Math.abs(strafeSpeed) > 0.15;
          }
          // Matches the original behavior: eligible to fire whenever within engage range,
          // regardless of which movement sub-branch (close/retreat/strafe) is currently active.
          if (dist <= this.engageRange) canFireNow = true;
        } else if (this.searching && elapsed < this.searchUntil) {
          // Lost the visual lock but still remembers roughly where the player was — pushes
          // toward that spot instead of freezing back to idle immediately (see hasVisualLock's
          // comment). Deliberately faces/steers toward the *last known* point, not the live one
          // it no longer actually has — a real per-frame `playerPos` is still passed in, but
          // treating it as known here would defeat the point of this whole mechanic.
          const toLastX = this.lastKnownPlayerPos.x - this.group.position.x;
          const toLastZ = this.lastKnownPlayerPos.z - this.group.position.z;
          const toLastDist = Math.hypot(toLastX, toLastZ);
          if (toLastDist > SEARCH_ARRIVE_TOLERANCE) {
            this.facing = Math.atan2(-toLastX / toLastDist, -toLastZ / toLastDist);
            this.updateSteering("search", this.lastKnownPlayerPos, obstacleMeshes, elapsed);
            this.group.position.x += this.steerDir.x * this.speed * dt;
            this.group.position.z += this.steerDir.z * this.speed * dt;
            moving = true;
          } else {
            this.searching = false; // arrived at the last known spot with nothing there — give up early
          }
        }
        // Otherwise: search timed out or gave up on arrival, and the lock hasn't been regained —
        // falls through to standing idle this frame, same as the original "out of range" case.
      }
    }

    if (obstacles) resolveCollisions(this.group.position, RADIUS, obstacles, 0);

    this.visual.rotation.y += (this.facing - this.visual.rotation.y) * Math.min(1, 8 * dt);

    const swingTarget = moving ? 1 : 0;
    this.walkPhase += dt * (moving ? 7 : 2.5);
    this.swingAmount += (swingTarget - this.swingAmount) * Math.min(1, 6 * dt);
    const swing = this.swingAmount;

    // Raises only the gun arm into an aiming stance whenever it's actually able to fire, rather
    // than just leaving the gun hanging at the hip — that's what read as "weird" before. The off
    // hand stays on its normal walk-swing, not raised too.
    this.aimAmount += ((canFireNow ? 1 : 0) - this.aimAmount) * Math.min(1, 7 * dt);
    const aim = this.aimAmount;

    // Crouch cycles in for the whole cover detour (advancing into cover, hiding, and peeking all
    // read as ducked — only "normal" stands fully upright), same lerp-toward-target technique
    // player.js's own crouch uses for eyeHeight.
    const crouchTarget = this.state === "normal" ? 0 : 1;
    this.crouchAmount += (crouchTarget - this.crouchAmount) * Math.min(1, CROUCH_LERP_RATE * dt);
    const crouch = this.crouchAmount;

    this.leftLeg.rotation.x = Math.sin(this.walkPhase) * WALK_LEG_SWING * swing + CROUCH_LEG_BEND * crouch;
    this.rightLeg.rotation.x = Math.sin(this.walkPhase + Math.PI) * WALK_LEG_SWING * swing + CROUCH_LEG_BEND * crouch;
    this.leftArm.rotation.x = Math.sin(this.walkPhase + Math.PI) * WALK_ARM_SWING * swing;

    const rightWalkSwing = Math.sin(this.walkPhase) * WALK_ARM_SWING * swing;
    this.rightArm.rotation.x = rightWalkSwing + (AIM_ARM_ANGLE - rightWalkSwing) * aim;
    this.visual.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.04 * swing - CROUCH_HEIGHT_DROP * crouch;

    this.updateHealthBar(cameraRight);
    updateNameplateVisibility([this.healthBarBg, this.healthBarFg], dist);

    let damage = null;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (canFireNow && this.fireCooldown <= 0) {
      // Aim at a short lead on the player's current velocity rather than their exact spot — lets
      // fire react to movement a beat sooner (including for the LOS check itself, so a shot can
      // track around a corner slightly ahead of the player reaching it) instead of only ever
      // aiming at where they already are.
      const leadX = playerVelocity ? playerPos.x + playerVelocity.x * LEAD_TIME : playerPos.x;
      const leadZ = playerVelocity ? playerPos.z + playerVelocity.z * LEAD_TIME : playerPos.z;
      const aimAtPos = { x: leadX, y: playerPos.y, z: leadZ };
      if (hasLineOfSight(this.group.position, aimAtPos, obstacleMeshes)) {
        this.fireCooldown = this.fireCooldownMax;
        this.justFired = true;
        this.flashTime = FLASH_DURATION;
        const lateralSpeed = playerVelocity ? Math.hypot(playerVelocity.x, playerVelocity.z) : 0;
        // Closer shots land more often; a fast-strafing target is harder to hit even with
        // leading (which claws back most, not all, of that penalty) — makes strafing matter.
        const hitChance = clamp(1.05 - dist / 30 - lateralSpeed * LATERAL_DODGE_PENALTY, 0.25, 0.92);
        if (Math.random() < hitChance) damage = this.gunDamage;
      }
    }

    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const t = Math.max(0, this.flashTime / FLASH_DURATION);
      this.gunFlashMat.opacity = t * 0.9;
      this.gunFlash.scale.setScalar(0.6 + (1 - t) * 1.2);
      this.gunFlashLight.intensity = t * 4;
    } else {
      this.gunFlashMat.opacity = 0;
      this.gunFlashLight.intensity = 0;
    }

    return damage;
  }

  takeDamage(amount) {
    this.health -= amount;
    if (this.health <= 0 && this.alive) {
      this.alive = false;
      return true;
    }
    return false;
  }

  // Instant removal, no ragdoll — used for a full match reset, not a normal kill.
  die(scene) {
    scene.remove(this.group);
  }
}

// Detaches this enemy's limb chunks into free-flying scene objects (see
// breakApartHumanoid in humanoidParts.js for the shared physics/mechanics — this just
// clears the enemy-specific gun flash first, since that state lives outside `parts`).
export function breakApartEnemy(scene, enemy, blast = null) {
  enemy.gunFlashMat.opacity = 0;
  enemy.gunFlashLight.intensity = 0;
  return breakApartHumanoid(scene, enemy.group, enemy.parts, blast);
}

export function randomSpawnPoint(minDistFromCenter = 12, arenaBound = ARENA_BOUND) {
  let x, z;
  do {
    x = (Math.random() * 2 - 1) * (arenaBound - 4);
    z = (Math.random() * 2 - 1) * (arenaBound - 4);
  } while (Math.hypot(x, z) < minDistFromCenter);
  return { x, z };
}
