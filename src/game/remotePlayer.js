import * as THREE from "three";
import {
  sharedHumanoidParts,
  buildWeaponProp,
  buildHumanoidBody,
  buildHealthBar,
  updateHealthBarSprite,
  updateNameplateVisibility,
  breakApartHumanoid,
  clamp,
  WALK_LEG_SWING,
  WALK_ARM_SWING,
  AIM_ARM_ANGLE,
  WEAPON_FLASH_DURATION,
  WEAPON_IDS,
} from "./humanoidParts.js";
import { metalMat, lensMat, scopeLensMat } from "./weapon.js";

// The gun arm stays raised into a ready stance permanently (never drops back to hanging at
// the sides, per explicit request) — only a small sway layers on top while walking, and the
// whole pose tilts with the player's actual look pitch so a peer can see roughly where
// someone is aiming without needing them to fire a shot. The off-hand arm is unused (holds
// nothing) and keeps its normal hanging walk-swing instead — only the arm actually holding
// the gun needs to read as "aiming."
const IDLE_ARM_SWAY = 0.12;
const ARM_PITCH_SCALE = 0.6;
const ARM_ANGLE_MIN = 0.3;
const ARM_ANGLE_MAX = 2.3;
const HEAD_PITCH_SCALE = 0.8;
const HEAD_PITCH_MAX = 1.1;

// Distinct clothing tints cycled by join order so peers are told apart at a glance —
// separate from the name tag, which needs to be read up close to matter.
const PLAYER_COLORS = [0x3a5f7a, 0x7a3a3a, 0x7a6a3a, 0x5a3a7a, 0x3a7a6a, 0x7a3a6a, 0x6a6a3a, 0x4a7a3a];

const POS_LERP_SPEED = 12;
const ROT_LERP_SPEED = 10;

// Assassin's Invisibility (main.js's `invisibleTimer`, broadcast as `invisible` in the
// position tick) — a lerp rate rather than a tracked fade timer, same trick position/rotation
// already use. This exponential approach (`opacity += (target - opacity) * rate * dt`)
// reaches ~95% of the way to its target after 3/rate seconds — at rate 6 that's ~0.5s,
// which is what reads as "fades over half a second" rather than snapping.
const INVISIBLE_FADE_RATE = 6;

// Post-respawn invincibility shield — broadcast by the owning client (main.js's `invincibleTimer
// > 0`) in every position tick, so peers can see at a glance that shooting this player won't
// land a hit rather than only finding out via a "no damage" surprise. A low-poly sphere
// enveloping the whole body (shared geometry across every RemotePlayer instance — it never
// changes shape, only opacity — but a per-instance material, since opacity is mutated every
// frame and two players can be invincible at once with independent pulse phases). Same cyan-blue
// accent color as the local player's own screen-edge invincibility vignette, so it reads as the
// same effect from both sides of the encounter.
const INVINCIBLE_GLOW_RADIUS = 1.15;
const INVINCIBLE_GLOW_COLOR = 0x4de3ff;
const INVINCIBLE_GLOW_MIN_OPACITY = 0.12;
const INVINCIBLE_GLOW_MAX_OPACITY = 0.32;
const INVINCIBLE_GLOW_PULSE_SPEED = 5.7; // radians/sec — matches the ~1.1s period of the local invincible-vignette CSS pulse
const invincibleGlowGeo = new THREE.SphereGeometry(INVINCIBLE_GLOW_RADIUS, 12, 8);

function buildNameTagSprite(name) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(6, 14, 18, 0.72)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "bold 34px sans-serif";
  ctx.fillStyle = "#e8f6ff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(name).slice(0, 24), canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.9, 0.9 * (canvas.height / canvas.width), 1);
  sprite.renderOrder = 1;
  return { sprite, mat, texture };
}

// A networked peer's avatar: no AI, but otherwise built from the same shared parts as an
// Enemy (entities.js) — holds one prop per weapon type (built once, toggled visible on
// switch rather than rebuilt) so it always shows whichever weapon that peer actually has
// equipped, holds a permanent ready/aiming stance that tilts up/down with the peer's actual
// look pitch, and can be blown apart into ragdoll pieces on elimination the same way an
// Enemy can. Position/rotation are lerped toward the latest network update rather than
// snapping, since updates only arrive at ~15Hz.
export class RemotePlayer {
  constructor(scene, id, name, colorIndex, x = 0, z = 0) {
    this.id = id;
    this.name = name;
    this.health = 100;
    this.maxHealth = 100;
    this.isMoving = false;
    this.pitch = 0; // current (lerped) up/down look angle, mirrored from the owner's camera
    this.targetPitch = 0;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.swingAmount = 0;
    this.gunFlashTime = 0;
    this.invincible = false;
    this.invincibleGlowPhase = 0;
    this.targetInvisible = false; // set from network; body opacity lerps toward 0 (this) or 1

    this.targetPos = new THREE.Vector3(x, 0, z);
    this.targetRotY = 0;

    const s = sharedHumanoidParts();
    const clothingMat = new THREE.MeshStandardMaterial({
      color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
      roughness: 0.82,
      metalness: 0.08,
      emissive: 0x141a10,
      transparent: true, // needed for the Invisibility fade below, even at opacity 1 the rest of the time
    });
    // Cloned (not the shared s.skinMat/s.bootMat every Enemy/other RemotePlayer also uses) —
    // Invisibility fades THIS player's whole body, and mutating a shared material's opacity
    // would invisibly (pun intended) affect every other humanoid in the scene too.
    const skinMat = s.skinMat.clone();
    skinMat.transparent = true;
    const bootMat = s.bootMat.clone();
    bootMat.transparent = true;
    const eyeMat = s.eyeMat.clone();
    eyeMat.transparent = true;
    const mouthMat = s.mouthMat.clone();
    mouthMat.transparent = true;
    const built = buildHumanoidBody(s, { clothingMat, skinMat, bootMat, eyeMat, mouthMat });
    this.clothingMat = clothingMat;
    this.skinMat = skinMat;
    this.bootMat = bootMat;
    this.eyeMat = eyeMat;
    this.mouthMat = mouthMat;
    this.group = built.group;
    this.visual = built.visual;
    this.torso = built.torso;
    this.head = built.head;
    this.leftLeg = built.leftLeg;
    this.rightLeg = built.rightLeg;
    this.leftArm = built.leftArm;
    this.rightArm = built.rightArm;

    // Whole-limb chunks used for the death ragdoll — same grouping Enemy uses, so a kill
    // "explodes" a player the same way it explodes an AI enemy.
    this.parts = [this.torso, this.head, this.leftLeg, this.rightLeg, this.leftArm, this.rightArm];

    // buildWeaponProp hard-codes the shared metalMat/lensMat/scopeLensMat from weapon.js on
    // every gun/knife mesh it builds — swapped here for per-instance clones (same reasoning
    // as clothing/skin/boot above) so fading THIS player doesn't fade every other player's
    // (and every AI enemy's) held weapon along with it. Cheap to do for every weapon prop up
    // front rather than only the currently-equipped one, since it's a one-time per-player cost.
    this.weaponMetalMat = metalMat.clone();
    this.weaponMetalMat.transparent = true;
    this.weaponLensMat = lensMat.clone();
    this.weaponLensMat.transparent = true;
    this.weaponScopeLensMat = scopeLensMat.clone();
    this.weaponScopeLensMat.transparent = true;

    this.weaponId = "pistol";
    this.weaponProps = {};
    for (const wid of WEAPON_IDS) {
      const prop = buildWeaponProp(s, wid);
      prop.group.traverse((obj) => {
        if (!obj.isMesh) return;
        if (obj.material === metalMat) obj.material = this.weaponMetalMat;
        else if (obj.material === lensMat) obj.material = this.weaponLensMat;
        else if (obj.material === scopeLensMat) obj.material = this.weaponScopeLensMat;
      });
      prop.group.visible = wid === this.weaponId;
      this.rightArm.add(prop.group);
      this.weaponProps[wid] = prop;
    }

    // Invisible raycast target — same role as Enemy.mesh in entities.js, so fireWeapon()
    // in main.js can hit-test remote players the same way it already hit-tests AI enemies.
    this.mesh = new THREE.Mesh(s.hitboxGeo, s.clothingMat);
    this.mesh.position.y = 0.9;
    this.mesh.visible = false;
    this.group.add(this.mesh);

    const { healthBarBg, healthBarFg, healthBarFgMat } = buildHealthBar(s, this.group);
    this.healthBarBg = healthBarBg;
    this.healthBarFg = healthBarFg;
    this.healthBarFgMat = healthBarFgMat;

    const nameTag = buildNameTagSprite(name);
    nameTag.sprite.position.set(0, 2.3, 0);
    this.group.add(nameTag.sprite);
    this.nameTagSprite = nameTag.sprite;
    this.nameTagMat = nameTag.mat;
    this.nameTagTexture = nameTag.texture;

    this.invincibleGlowMat = new THREE.MeshBasicMaterial({
      color: INVINCIBLE_GLOW_COLOR,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.invincibleGlow = new THREE.Mesh(invincibleGlowGeo, this.invincibleGlowMat);
    this.invincibleGlow.position.y = 0.95;
    this.invincibleGlow.visible = false;
    this.group.add(this.invincibleGlow);

    this.group.position.set(x, 0, z);
    scene.add(this.group);
  }

  setWeapon(weaponId) {
    if (weaponId === this.weaponId || !this.weaponProps[weaponId]) return;
    this.weaponProps[this.weaponId].group.visible = false;
    this.weaponId = weaponId;
    this.weaponProps[this.weaponId].group.visible = true;
  }

  triggerMuzzleFlash() {
    this.gunFlashTime = WEAPON_FLASH_DURATION;
  }

  getMuzzleWorldPosition(target = new THREE.Vector3()) {
    return this.weaponProps[this.weaponId].flash.getWorldPosition(target);
  }

  // Latest state from a "pos" relay message — stored as a lerp target, not applied
  // immediately, so movement between the ~15Hz updates still reads smoothly. Includes
  // the network Y (feet height) so jumps/falls are visible, not just XZ movement.
  updateFromNetwork(x, y, z, rotY, health, isMoving, weaponId, pitch, invincible, invisible) {
    this.targetPos.set(x, y, z);
    this.targetRotY = rotY;
    this.health = health;
    this.isMoving = isMoving;
    this.targetPitch = pitch || 0;
    this.invincible = !!invincible;
    this.targetInvisible = !!invisible;
    if (weaponId) this.setWeapon(weaponId);
  }

  update(dt, cameraPos, cameraRight, revealedByPulse = false) {
    this.group.position.lerp(this.targetPos, Math.min(1, POS_LERP_SPEED * dt));

    // Shortest-path angle wrap into [-PI, PI). JS's `%` is a remainder operator, not a
    // true modulo — it can return a negative result, which left this under-wrapped right
    // at the +-180 crossing (a small further turn there could read back as a huge jump).
    // The extra `+ TAU) % TAU` normalizes it to [0, TAU) first regardless of sign, then
    // shifting by -PI maps it into [-PI, PI) — verified against a simulated 360 turn.
    const TAU = Math.PI * 2;
    let diff = this.targetRotY - this.visual.rotation.y;
    diff = (((diff + Math.PI) % TAU) + TAU) % TAU - Math.PI;
    this.visual.rotation.y += diff * Math.min(1, ROT_LERP_SPEED * dt);
    this.pitch += (this.targetPitch - this.pitch) * Math.min(1, ROT_LERP_SPEED * dt);

    const swingTarget = this.isMoving ? 1 : 0;
    this.walkPhase += dt * (this.isMoving ? 7 : 2.5);
    this.swingAmount += (swingTarget - this.swingAmount) * Math.min(1, 6 * dt);
    const swing = this.swingAmount;

    this.leftLeg.rotation.x = Math.sin(this.walkPhase) * WALK_LEG_SWING * swing;
    this.rightLeg.rotation.x = Math.sin(this.walkPhase + Math.PI) * WALK_LEG_SWING * swing;
    this.leftArm.rotation.x = Math.sin(this.walkPhase + Math.PI) * WALK_ARM_SWING * swing;

    // The gun arm holds a permanent ready/aiming stance (never drops to hanging) — a small
    // sway keeps the walk cycle alive, and the whole pose tilts with the owner's actual look
    // pitch so an onlooker can tell roughly where someone is aiming without them needing to
    // fire.
    const armSway = Math.sin(this.walkPhase) * IDLE_ARM_SWAY * swing;
    const pitchTilt = clamp(this.pitch * ARM_PITCH_SCALE, -0.9, 0.9);
    this.rightArm.rotation.x = clamp(AIM_ARM_ANGLE + pitchTilt + armSway, ARM_ANGLE_MIN, ARM_ANGLE_MAX);

    this.head.rotation.x = clamp(this.pitch * HEAD_PITCH_SCALE, -HEAD_PITCH_MAX, HEAD_PITCH_MAX);

    this.visual.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.04 * swing;

    this.invincibleGlow.visible = this.invincible;
    if (this.invincible) {
      this.invincibleGlowPhase += dt * INVINCIBLE_GLOW_PULSE_SPEED;
      const pulse = (Math.sin(this.invincibleGlowPhase) + 1) / 2; // 0..1
      this.invincibleGlowMat.opacity =
        INVINCIBLE_GLOW_MIN_OPACITY + pulse * (INVINCIBLE_GLOW_MAX_OPACITY - INVINCIBLE_GLOW_MIN_OPACITY);
    }

    // Purely visual concealment (still hittable — see combat.js's damage handling, which
    // never checks this) — fades the whole body toward transparent/opaque rather than an
    // instant on/off, at a rate tuned to read as "fades over about half a second."
    const targetOpacity = this.targetInvisible ? 0 : 1;
    const opacityLerp = Math.min(1, INVISIBLE_FADE_RATE * dt);
    this.clothingMat.opacity += (targetOpacity - this.clothingMat.opacity) * opacityLerp;
    this.skinMat.opacity += (targetOpacity - this.skinMat.opacity) * opacityLerp;
    this.bootMat.opacity += (targetOpacity - this.bootMat.opacity) * opacityLerp;
    this.eyeMat.opacity += (targetOpacity - this.eyeMat.opacity) * opacityLerp;
    this.mouthMat.opacity += (targetOpacity - this.mouthMat.opacity) * opacityLerp;
    this.weaponMetalMat.opacity += (targetOpacity - this.weaponMetalMat.opacity) * opacityLerp;
    this.weaponLensMat.opacity += (targetOpacity - this.weaponLensMat.opacity) * opacityLerp;
    this.weaponScopeLensMat.opacity += (targetOpacity - this.weaponScopeLensMat.opacity) * opacityLerp;

    updateHealthBarSprite(this.healthBarFg, this.healthBarFgMat, this.health / this.maxHealth, cameraRight);
    if (cameraPos) {
      const distToCamera = this.group.position.distanceTo(cameraPos);
      // Name tags disabled for now (2026-08-16) — reported as not making sense alongside the
      // sniper's scoped view. Forcing -Infinity through the same shared visibility helper hides
      // it unconditionally without touching how the sprite itself is built, so re-enabling later
      // is just swapping this back to `distToCamera`.
      updateNameplateVisibility([this.nameTagSprite], -Infinity);
      // Health is only ever visible while this specific player is actively revealed by a
      // Recon Pulse (main.js tracks that per-target, not globally) — the same distance rule
      // still applies underneath so it doesn't show right in someone's face either. Passing
      // -Infinity when not revealed forces `visible = false` through the exact same shared
      // helper rather than duplicating its distance-comparison logic here.
      updateNameplateVisibility([this.healthBarBg, this.healthBarFg], revealedByPulse ? distToCamera : -Infinity);
    }

    const activeProp = this.weaponProps[this.weaponId];
    if (this.gunFlashTime > 0) {
      this.gunFlashTime -= dt;
      const t = Math.max(0, this.gunFlashTime / WEAPON_FLASH_DURATION);
      activeProp.flashMat.opacity = t * 0.9;
      activeProp.flash.scale.setScalar(0.6 + (1 - t) * 1.2);
      activeProp.flashLight.intensity = t * 4;
    } else {
      activeProp.flashMat.opacity = 0;
      activeProp.flashLight.intensity = 0;
    }
  }

  // Detaches this player's limb chunks into free-flying ragdoll pieces on elimination —
  // same mechanism/physics an AI enemy uses (see breakApartHumanoid in humanoidParts.js).
  // Returns the tracked parts for the caller to push into its usual updateCorpseParts()
  // list; the caller should remove this RemotePlayer from its tracking map afterward
  // (it's gone until the player's next position tick after respawning, which lazily
  // recreates it).
  breakApart(scene, blast = null) {
    const activeProp = this.weaponProps[this.weaponId];
    activeProp.flashMat.opacity = 0;
    activeProp.flashLight.intensity = 0;
    // Always a fully-visible explosion, regardless of Invisibility's current fade state or
    // remaining duration — a killer should always get clear visual confirmation of the kill,
    // never watch an invisible (or mid-fade) corpse fly apart. matchLifecycle.js separately
    // zeroes the *victim's own* invisibleTimer on death; this is what guarantees the same for
    // every observer's already-rendered copy, regardless of network timing between the two.
    this.clothingMat.opacity = 1;
    this.skinMat.opacity = 1;
    this.bootMat.opacity = 1;
    this.eyeMat.opacity = 1;
    this.mouthMat.opacity = 1;
    this.weaponMetalMat.opacity = 1; // the weapon stays attached to whichever arm it's on through the explosion
    this.weaponLensMat.opacity = 1;
    this.weaponScopeLensMat.opacity = 1;
    const parts = breakApartHumanoid(scene, this.group, this.parts, blast);
    this.nameTagMat.dispose();
    this.nameTagTexture.dispose();
    this.invincibleGlowMat.dispose(); // per-instance material (opacity mutated independently per player) — the geometry itself is shared, so only this needs disposing
    this.skinMat.dispose();
    this.bootMat.dispose();
    this.eyeMat.dispose();
    this.mouthMat.dispose();
    this.weaponMetalMat.dispose();
    this.weaponLensMat.dispose();
    this.weaponScopeLensMat.dispose();
    return parts;
  }

  destroy(scene) {
    scene.remove(this.group);
    this.nameTagMat.dispose();
    this.nameTagTexture.dispose();
    this.invincibleGlowMat.dispose();
    this.skinMat.dispose();
    this.bootMat.dispose();
    this.eyeMat.dispose();
    this.mouthMat.dispose();
    this.weaponMetalMat.dispose();
    this.weaponLensMat.dispose();
    this.weaponScopeLensMat.dispose();
  }
}
