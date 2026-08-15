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

const RADIUS = 0.35;
const FLASH_DURATION = 0.08;
const LOS_EYE_HEIGHT = 1.5; // shooting height used for the line-of-sight check, not a rendered eye

// Reused across all enemies' line-of-sight checks each frame — synchronous, single-threaded,
// so one shared Raycaster/vector set is safe (no call re-enters before the previous returns).
const losRaycaster = new THREE.Raycaster();
const losOrigin = new THREE.Vector3();
const losDir = new THREE.Vector3();

// Same obstacle meshes the player's hitscan already raycasts against (walls + rocks; trees
// aren't in this list either, matching the player-side simplification in main.js).
function hasLineOfSight(enemyPos, playerPos, obstacleMeshes) {
  if (!obstacleMeshes || obstacleMeshes.length === 0) return true;
  losOrigin.set(enemyPos.x, LOS_EYE_HEIGHT, enemyPos.z);
  losDir.set(playerPos.x - losOrigin.x, playerPos.y - losOrigin.y, playerPos.z - losOrigin.z);
  const dist = losDir.length();
  if (dist < 0.001) return true;
  losDir.divideScalar(dist);
  losRaycaster.set(losOrigin, losDir);
  losRaycaster.near = 0.05;
  losRaycaster.far = Math.max(0.1, dist - 0.3);
  return losRaycaster.intersectObjects(obstacleMeshes, false).length === 0;
}

function buildEnemyMesh() {
  const s = sharedHumanoidParts();
  const { group, visual, torso, head, leftLeg, rightLeg, leftArm, rightArm } = buildHumanoidBody(s);

  const gun = buildWeaponProp(s, "pistol");
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
  constructor(scene, x, z) {
    this.alive = true;
    this.health = 30;
    this.maxHealth = 30;
    this.speed = 3.0;
    this.aggroRange = 22;
    this.engageRange = 13; // stops closing and starts shooting once inside this
    this.retreatRange = 6; // backs away if the player gets this close — a gunner, not a brawler
    this.gunDamage = 6;
    this.fireCooldownMax = 1.1 + Math.random() * 0.3;
    this.fireCooldown = Math.random() * this.fireCooldownMax; // desync volleys across spawns
    this.flashTime = 0;
    this.justFired = false;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafePhase = Math.random() * Math.PI * 2;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.facing = 0;
    this.swingAmount = 0;
    this.aimAmount = 0; // 0 = arms hang/walk-swing, 1 = raised into an aiming stance

    const built = buildEnemyMesh();
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

  update(dt, elapsed, playerPos, obstacles, obstacleMeshes, cameraRight) {
    if (!this.alive) return null;
    this.justFired = false;

    const toPlayer = new THREE.Vector3(
      playerPos.x - this.group.position.x,
      0,
      playerPos.z - this.group.position.z
    );
    const dist = toPlayer.length();
    const dir = dist > 0.0001 ? toPlayer.divideScalar(dist) : new THREE.Vector3(0, 0, 1);

    let moving = false;
    if (dist < this.aggroRange) {
      // Negated on purpose: THREE's rotation.y convention maps local -Z (the model's front,
      // where the eye sits) to (-sin θ, -cos θ), which is -dir at θ = atan2(dir.x, dir.z) — i.e.
      // the un-negated form actually turns the character's back to the player. Verified
      // numerically against the real rig; this is a pre-existing bug, not new in this change.
      this.facing = Math.atan2(-dir.x, -dir.z);

      if (dist > this.engageRange) {
        // out of range — close the distance
        this.group.position.x += dir.x * this.speed * dt;
        this.group.position.z += dir.z * this.speed * dt;
        moving = true;
      } else if (dist < this.retreatRange) {
        // too close for a gunner to want to be — back off while still facing the player
        this.group.position.x -= dir.x * this.speed * 0.7 * dt;
        this.group.position.z -= dir.z * this.speed * 0.7 * dt;
        moving = true;
      } else {
        // holds range and strafes side to side instead of standing still in the open
        this.strafePhase += dt * 1.6;
        const strafeSpeed = Math.sin(this.strafePhase) * this.speed * 0.5 * this.strafeDir;
        this.group.position.x += dir.z * strafeSpeed * dt;
        this.group.position.z += -dir.x * strafeSpeed * dt;
        moving = Math.abs(strafeSpeed) > 0.15;
      }
    }

    if (obstacles) resolveCollisions(this.group.position, RADIUS, obstacles, 0);

    this.visual.rotation.y += (this.facing - this.visual.rotation.y) * Math.min(1, 8 * dt);

    const swingTarget = moving ? 1 : 0;
    this.walkPhase += dt * (moving ? 7 : 2.5);
    this.swingAmount += (swingTarget - this.swingAmount) * Math.min(1, 6 * dt);
    const swing = this.swingAmount;

    // Raises only the gun arm into an aiming stance whenever it's in gun range, rather than
    // just leaving the gun hanging at the hip — that's what read as "weird" before. The off
    // hand stays on its normal walk-swing, not raised too.
    const wantsToAim = dist < this.aggroRange && dist <= this.engageRange;
    this.aimAmount += ((wantsToAim ? 1 : 0) - this.aimAmount) * Math.min(1, 7 * dt);
    const aim = this.aimAmount;

    this.leftLeg.rotation.x = Math.sin(this.walkPhase) * WALK_LEG_SWING * swing;
    this.rightLeg.rotation.x = Math.sin(this.walkPhase + Math.PI) * WALK_LEG_SWING * swing;
    this.leftArm.rotation.x = Math.sin(this.walkPhase + Math.PI) * WALK_ARM_SWING * swing;

    const rightWalkSwing = Math.sin(this.walkPhase) * WALK_ARM_SWING * swing;
    this.rightArm.rotation.x = rightWalkSwing + (AIM_ARM_ANGLE - rightWalkSwing) * aim;
    this.visual.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.04 * swing;

    this.updateHealthBar(cameraRight);
    updateNameplateVisibility([this.healthBarBg, this.healthBarFg], dist);

    let damage = null;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (dist < this.aggroRange && dist <= this.engageRange && this.fireCooldown <= 0) {
      if (hasLineOfSight(this.group.position, playerPos, obstacleMeshes)) {
        this.fireCooldown = this.fireCooldownMax;
        this.justFired = true;
        this.flashTime = FLASH_DURATION;
        const hitChance = clamp(1.05 - dist / 30, 0.3, 0.92); // closer shots land more often
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
