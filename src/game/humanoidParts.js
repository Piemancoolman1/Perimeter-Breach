import * as THREE from "three";
import { metalMat, lensMat, scopeLensMat } from "./weapon.js";

// Shared low-poly humanoid builder — geometry/materials/body assembly used by both AI
// enemies (entities.js) and networked remote-player avatars (remotePlayer.js), so the
// two don't drift into two different-looking bodies built twice.
//
// Held weapon props reuse weapon.js's exact textured `metalMat`/`lensMat`/`scopeLensMat`
// (the same materials the first-person view models use) instead of a flat placeholder
// color, and use cylindrical barrels/scopes instead of boxes — matching the first-person
// silhouette is the whole point once other players' held weapons are visible at all.

const HEIGHT = 1.8;

// Walk-cycle swing amplitudes shared by every humanoid (Enemy, RemotePlayer) so their
// animation reads identically rather than drifting apart if tuned in only one place.
export const WALK_LEG_SWING = 0.7;
export const WALK_ARM_SWING = 0.5;

// Muzzle-flash timing shared by every held weapon prop (Enemy's pistol, RemotePlayer's
// currently-equipped weapon) so a caller's flash-decay loop can reuse the same constant.
export const WEAPON_FLASH_DURATION = 0.08;

// Raising a forearm to rotation.x = +PI/2 swings it from hanging straight down to pointing
// straight forward (verified against the actual rig math, not just derived by eye) — 0.92
// keeps it just short of fully horizontal so the pose doesn't look robotically locked out.
// Shared by Enemy (raises while in gun range) and RemotePlayer (raises while its player is
// aiming down sights).
export const AIM_ARM_ANGLE = (Math.PI / 2) * 0.92;

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Shared geometry/material across every humanoid instance — one copy on the GPU, not
// one per spawn. Every material carries a small constant `emissive` floor: low-poly
// boxy geometry under directional-dominant lighting can read as near-black from a lot
// of viewing angles (same issue hit with the faceted rock boulders in world.js) — the
// floor guarantees these never go fully black regardless of light angle.
let SHARED;
export function sharedHumanoidParts() {
  if (SHARED) return SHARED;
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xc99a6b,
    roughness: 0.7,
    metalness: 0.02,
    emissive: 0x2a1c10,
  });
  const clothingMat = new THREE.MeshStandardMaterial({
    color: 0x4f5f45,
    roughness: 0.82,
    metalness: 0.08,
    emissive: 0x141a10,
  });
  const bootMat = new THREE.MeshStandardMaterial({
    color: 0x332c24,
    roughness: 0.8,
    metalness: 0.1,
    emissive: 0x120f0a,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xff2a2a,
    emissive: 0xff2020,
    emissiveIntensity: 1.4,
    roughness: 0.4,
  });
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x1c1410, roughness: 0.75 });
  // Solid-color sprites (no map) for the floating health bar — always billboarded to the
  // camera for free since THREE.Sprite handles that itself, no manual per-frame facing math.
  const healthBarBgMat = new THREE.SpriteMaterial({
    color: 0x0c1012,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
  });
  SHARED = {
    torsoGeo: new THREE.BoxGeometry(0.5, 0.7, 0.32),
    headGeo: new THREE.BoxGeometry(0.34, 0.34, 0.34),
    legGeo: new THREE.BoxGeometry(0.16, 0.8, 0.18),
    armGeo: new THREE.BoxGeometry(0.14, 0.55, 0.14),
    bootGeo: new THREE.BoxGeometry(0.19, 0.14, 0.22),
    handGeo: new THREE.BoxGeometry(0.13, 0.13, 0.13),
    eyeGeo: new THREE.BoxGeometry(0.07, 0.06, 0.05),
    mouthGeo: new THREE.BoxGeometry(0.14, 0.035, 0.04),
    hitboxGeo: new THREE.BoxGeometry(0.7, HEIGHT, 0.5),
    // Sized up ~30% from the original pass — at typical combat range (8-10 units) the
    // original sizes read as barely-visible slivers even once clear of the hand-overlap fix.
    // Barrels are cylinders (not boxes) and everything uses weapon.js's real textured
    // metalMat/lensMat/scopeLensMat now — matching the first-person silhouette/material was
    // the point once other players' held weapons became visible at all.
    // Every part below is dimensioned and positioned to match its first-person counterpart
    // in weapon.js exactly (same BUILDERS function), converted through one fixed axis
    // mapping (see buildWeaponProp's comment) rather than re-derived by eye — otherwise a
    // third-person weapon reads as a different gun entirely from its own first-person view,
    // which is exactly what was reported ("the guns look entirely different").
    gunBodyGeo: new THREE.BoxGeometry(0.09, 0.24, 0.11),
    gunBarrelGeo: new THREE.CylinderGeometry(0.016, 0.018, 0.14, 8),
    gunRearSightGeo: new THREE.BoxGeometry(0.02, 0.02, 0.02),
    gunFrontSightGeo: new THREE.BoxGeometry(0.012, 0.012, 0.02),
    gunGripGeo: new THREE.BoxGeometry(0.075, 0.09, 0.16),
    gunMagGeo: new THREE.BoxGeometry(0.05, 0.055, 0.09),
    gunFlashGeo: new THREE.SphereGeometry(0.055, 8, 8),
    akBodyGeo: new THREE.BoxGeometry(0.12, 0.42, 0.13),
    akRailGeo: new THREE.BoxGeometry(0.02, 0.36, 0.015),
    akBarrelGeo: new THREE.CylinderGeometry(0.025, 0.03, 0.32, 10),
    akBarrelTipGeo: new THREE.CylinderGeometry(0.032, 0.032, 0.04, 10),
    akGripGeo: new THREE.BoxGeometry(0.09, 0.1, 0.22),
    akMagGeo: new THREE.BoxGeometry(0.07, 0.09, 0.26),
    akSightPostGeo: new THREE.BoxGeometry(0.012, 0.012, 0.045),
    akSightRingGeo: new THREE.TorusGeometry(0.032, 0.006, 8, 16),
    sniperBodyGeo: new THREE.BoxGeometry(0.1, 0.55, 0.12),
    sniperBarrelGeo: new THREE.CylinderGeometry(0.02, 0.024, 0.42, 10),
    sniperStockGeo: new THREE.BoxGeometry(0.06, 0.24, 0.09),
    sniperGripGeo: new THREE.BoxGeometry(0.08, 0.09, 0.2),
    sniperMagGeo: new THREE.BoxGeometry(0.05, 0.06, 0.1),
    sniperScopeGeo: new THREE.CylinderGeometry(0.03, 0.03, 0.32, 12),
    sniperScopeFrontLensGeo: new THREE.CylinderGeometry(0.032, 0.032, 0.01, 12),
    sniperScopeRearLensGeo: new THREE.CylinderGeometry(0.026, 0.026, 0.01, 12),
    bazookaTubeGeo: new THREE.CylinderGeometry(0.09, 0.09, 0.85, 12),
    bazookaCapGeo: new THREE.CylinderGeometry(0.11, 0.1, 0.08, 12),
    bazookaGripGeo: new THREE.BoxGeometry(0.08, 0.09, 0.2),
    bazookaHandguardGeo: new THREE.BoxGeometry(0.05, 0.2, 0.05),
    bazookaSightPostGeo: new THREE.BoxGeometry(0.014, 0.014, 0.05),
    bazookaSightRingGeo: new THREE.TorusGeometry(0.028, 0.005, 8, 16),
    knifeHandleGeo: new THREE.BoxGeometry(0.035, 0.14, 0.035),
    knifeGuardGeo: new THREE.BoxGeometry(0.09, 0.02, 0.02),
    knifeBladeGeo: new THREE.BoxGeometry(0.016, 0.26, 0.006),
    skinMat,
    clothingMat,
    bootMat,
    eyeMat,
    mouthMat,
    healthBarBgMat,
  };
  return SHARED;
}

export const WEAPON_IDS = ["pistol", "ak47", "sniper", "bazooka", "knife"];

// A held weapon prop clipped to a gun hand, built part-for-part to match its first-person
// counterpart in weapon.js (same body/barrel/grip/mag/sights, same relative proportions) —
// a third-person player used to hold a much simpler generic shape than their own
// first-person view showed, which read as "a completely different gun."
//
// The two builders use different local-axis conventions (weapon.js's FP rig has the camera
// looking down -Z with +Y up; this rig's forearm pivot hangs along -Y with sights "up" at
// -Z — see below), so every position/rotation here is that same FP part run through one
// fixed conversion rather than re-eyeballed:
//   TP.x = FP.x
//   TP.y = FP.z        (FP's forward axis -Z <-> TP's forward axis -Y — same sign convention)
//   TP.z = -FP.y        (FP's up axis +Y <-> TP's up axis -Z — sign flips)
//   TP box(w,h,d) = FP box(w, d, h)   (height/depth swap to match the axis swap above)
//   a plain X-axis tilt (rotation.x) carries over completely unchanged — the mapping above
//   is itself a rotation about the shared X axis, so rotations about that same axis commute
//   with it (verified algebraically, not just by eye)
//   FP cylinders rotated rotation.x=PI/2 (to align their axis with FP's forward Z) need NO
//   added rotation in TP (their default axis is already TP's forward Y)
//   FP torus rings (no rotation, hole faces FP's forward Z) need rotation.x=PI/2 in TP (to
//   swing the hole to face TP's forward Y instead) — getting this backwards on a cylinder
//   is exactly the bug that made the sniper scope render as a sideways cross.
//
// Local-axis convention for every part below (the group's own space, before the arm pivot's
// rotation is applied): Y is the gun's length, -Y = muzzle/forward; Z is "up" relative to
// the gun's own barrel (sights/scopes sit at -Z) — chosen so that once the arm swings from
// hanging (rotation.x=0) to the raised aim pose (rotation.x=+PI/2), a -Z-offset part ends up
// correctly *above* the barrel in world space rather than below it.
export function buildWeaponProp(s, weaponId = "pistol") {
  const group = new THREE.Group();
  let muzzle;

  if (weaponId === "ak47") {
    group.add(new THREE.Mesh(s.akBodyGeo, metalMat));
    const rail = new THREE.Mesh(s.akRailGeo, metalMat);
    rail.position.set(0, 0.015, -0.072);
    group.add(rail);
    const barrel = new THREE.Mesh(s.akBarrelGeo, metalMat);
    barrel.position.set(0, -0.315, -0.01);
    group.add(barrel);
    const barrelTip = new THREE.Mesh(s.akBarrelTipGeo, metalMat);
    barrelTip.position.set(0, -0.475, -0.01);
    group.add(barrelTip);
    const grip = new THREE.Mesh(s.akGripGeo, metalMat);
    grip.position.set(0, 0.2, 0.15);
    grip.rotation.x = 0.35;
    group.add(grip);
    const mag = new THREE.Mesh(s.akMagGeo, metalMat);
    mag.position.set(0, 0.06, 0.19);
    mag.rotation.x = -0.28;
    group.add(mag);
    const sightPostFront = new THREE.Mesh(s.akSightPostGeo, metalMat);
    sightPostFront.position.set(0, -0.16, -0.09);
    group.add(sightPostFront);
    const sightPostRear = new THREE.Mesh(s.akSightPostGeo, metalMat);
    sightPostRear.position.set(0, 0.12, -0.09);
    group.add(sightPostRear);
    const sightRing = new THREE.Mesh(s.akSightRingGeo, lensMat);
    sightRing.position.set(0, -0.16, -0.115);
    sightRing.rotation.x = Math.PI / 2;
    group.add(sightRing);
    muzzle = { x: 0, y: -0.495, z: -0.01 };
  } else if (weaponId === "sniper") {
    group.add(new THREE.Mesh(s.sniperBodyGeo, metalMat));
    const barrel = new THREE.Mesh(s.sniperBarrelGeo, metalMat);
    barrel.position.set(0, -0.45, -0.005);
    group.add(barrel);
    const stock = new THREE.Mesh(s.sniperStockGeo, metalMat);
    stock.position.set(0, 0.34, 0.03);
    group.add(stock);
    const grip = new THREE.Mesh(s.sniperGripGeo, metalMat);
    grip.position.set(0, 0.16, 0.14);
    grip.rotation.x = 0.3;
    group.add(grip);
    const mag = new THREE.Mesh(s.sniperMagGeo, metalMat);
    mag.position.set(0, 0.06, 0.17);
    group.add(mag);
    // The scope tube keeps its default Y-axis orientation (same as the barrel, since
    // CylinderGeometry's axis is already Y) so it runs parallel above the barrel — rotating
    // it 90° here (as the sight rings above correctly do, to face their ring-hole down the
    // barrel) would instead swing the tube's long axis out to the side, reading as a
    // perpendicular cross rather than a scope.
    const scope = new THREE.Mesh(s.sniperScopeGeo, metalMat);
    scope.position.set(0, -0.02, -0.087);
    group.add(scope);
    const scopeFrontLens = new THREE.Mesh(s.sniperScopeFrontLensGeo, scopeLensMat);
    scopeFrontLens.position.set(0, -0.18, -0.087);
    group.add(scopeFrontLens);
    const scopeRearLens = new THREE.Mesh(s.sniperScopeRearLensGeo, scopeLensMat);
    scopeRearLens.position.set(0, 0.14, -0.087);
    group.add(scopeRearLens);
    muzzle = { x: 0, y: -0.66, z: -0.005 };
  } else if (weaponId === "bazooka") {
    group.add(new THREE.Mesh(s.bazookaTubeGeo, metalMat));
    const rearCap = new THREE.Mesh(s.bazookaCapGeo, metalMat);
    rearCap.position.set(0, 0.38, 0); // rear cap, toward the hand — opposite the firing end
    group.add(rearCap);
    const grip = new THREE.Mesh(s.bazookaGripGeo, metalMat);
    grip.position.set(0, 0.05, 0.15);
    grip.rotation.x = 0.3;
    group.add(grip);
    const handguard = new THREE.Mesh(s.bazookaHandguardGeo, metalMat);
    handguard.position.set(0, -0.2, 0.11);
    group.add(handguard);
    const sightPost = new THREE.Mesh(s.bazookaSightPostGeo, metalMat);
    sightPost.position.set(0, -0.15, -0.11);
    group.add(sightPost);
    const sightRing = new THREE.Mesh(s.bazookaSightRingGeo, lensMat);
    sightRing.position.set(0, -0.15, -0.13);
    sightRing.rotation.x = Math.PI / 2;
    group.add(sightRing);
    muzzle = { x: 0, y: -0.48, z: 0 };
  } else if (weaponId === "knife") {
    const handle = new THREE.Mesh(s.knifeHandleGeo, metalMat);
    handle.position.set(0, 0.09, 0);
    group.add(handle);
    const guard = new THREE.Mesh(s.knifeGuardGeo, metalMat);
    guard.position.set(0, 0.02, 0);
    group.add(guard);
    const blade = new THREE.Mesh(s.knifeBladeGeo, metalMat);
    blade.position.set(0, -0.15, 0);
    group.add(blade);
    muzzle = { x: 0, y: -0.28, z: 0 };
  } else {
    group.add(new THREE.Mesh(s.gunBodyGeo, metalMat));
    const barrel = new THREE.Mesh(s.gunBarrelGeo, metalMat);
    barrel.position.set(0, -0.16, -0.01);
    group.add(barrel);
    const rearSight = new THREE.Mesh(s.gunRearSightGeo, metalMat);
    rearSight.position.set(0, 0.1, -0.062);
    group.add(rearSight);
    const frontSight = new THREE.Mesh(s.gunFrontSightGeo, metalMat);
    frontSight.position.set(0, -0.2, -0.035);
    group.add(frontSight);
    const grip = new THREE.Mesh(s.gunGripGeo, metalMat);
    grip.position.set(0, 0.11, 0.142);
    grip.rotation.x = 0.28;
    group.add(grip);
    const mag = new THREE.Mesh(s.gunMagGeo, metalMat);
    mag.position.set(0, 0.11, 0.2);
    group.add(mag);
    muzzle = { x: 0, y: -0.23, z: -0.01 };
  }

  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffb85c,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const flash = new THREE.Mesh(s.gunFlashGeo, flashMat);
  flash.position.set(muzzle.x, muzzle.y, muzzle.z);
  group.add(flash);

  const flashLight = new THREE.PointLight(0xffb85c, 0, 3.5);
  flashLight.position.copy(flash.position);
  group.add(flashLight);

  // The hand cube is centered at (0, -0.58, 0) in this same pivot-local space with a 0.065
  // half-extent — the old (0.02, -0.58, -0.03) offset put the gun's origin almost exactly
  // there too, so the gun body rendered mostly *inside* the opaque hand mesh (invisible in
  // practice, confirmed by screenshotting it up close). Pushed further out along the same
  // -Y/-Z the gun already rigidly follows, so it now sits just past the hand instead.
  group.position.set(0.02, -0.7, -0.06);

  return { group, flash, flashMat, flashLight };
}

// Builds just the body — torso/head/face/limbs/boots/hands — with no gun, hitbox,
// health bar, or ragdoll bookkeeping; callers (Enemy, RemotePlayer) attach whichever of
// those they need on top. `materialOverrides` lets a caller (e.g. a per-player color
// tint, or Assassin's per-instance Invisibility fade) swap in its own material instances
// instead of the shared defaults — skin/boot needed alongside clothing so a full-body
// fade doesn't leave a floating head/hands/boots behind (eyes/mouth are left on the
// shared material regardless; too small a detail to be worth their own per-instance copy).
export function buildHumanoidBody(s, materialOverrides = {}) {
  const clothingMat = materialOverrides.clothingMat || s.clothingMat;
  const skinMat = materialOverrides.skinMat || s.skinMat;
  const bootMat = materialOverrides.bootMat || s.bootMat;

  const group = new THREE.Group();
  const visual = new THREE.Group();
  group.add(visual);

  const torso = new THREE.Mesh(s.torsoGeo, clothingMat);
  torso.position.y = 1.15;
  torso.castShadow = true;
  visual.add(torso);

  // Eyes + mouth are nested under the head mesh (not `visual` directly) so they stay
  // rigidly attached to it if the head is ever detached on its own (e.g. a death ragdoll).
  const head = new THREE.Mesh(s.headGeo, skinMat);
  head.position.y = 1.65;
  head.castShadow = true;
  visual.add(head);

  const eyeL = new THREE.Mesh(s.eyeGeo, s.eyeMat);
  eyeL.position.set(-0.085, 0.02, -0.175);
  head.add(eyeL);
  const eyeR = new THREE.Mesh(s.eyeGeo, s.eyeMat);
  eyeR.position.set(0.085, 0.02, -0.175);
  head.add(eyeR);

  const mouth = new THREE.Mesh(s.mouthGeo, s.mouthMat);
  mouth.position.set(0, -0.09, -0.17);
  head.add(mouth);

  // Hip height matches the torso's own bottom edge (torso.position.y=1.15 minus its half-
  // height 0.35) exactly, so the leg's top sits flush against the torso instead of leaving a
  // visible gap at the waist — and the leg's own height (0.8) was extended to match, so the
  // foot/boot position on the ground doesn't move. Legs sit close together under the torso
  // center (offset 0.09, just past the leg's own half-width of 0.08) rather than the older,
  // more widely-spaced stance.
  const hipHeight = 0.8;
  function buildLeg(x) {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, hipHeight, 0);
    const mesh = new THREE.Mesh(s.legGeo, clothingMat);
    mesh.position.y = -0.4;
    mesh.castShadow = true;
    pivot.add(mesh);
    const boot = new THREE.Mesh(s.bootGeo, bootMat);
    boot.position.y = -0.8;
    boot.position.z = -0.03;
    boot.castShadow = true;
    pivot.add(boot);
    visual.add(pivot);
    return pivot;
  }
  const leftLeg = buildLeg(-0.09);
  const rightLeg = buildLeg(0.09);

  const shoulderHeight = 1.4;
  function buildArm(x) {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, shoulderHeight, 0);
    const mesh = new THREE.Mesh(s.armGeo, clothingMat);
    mesh.position.y = -0.275;
    mesh.castShadow = true;
    pivot.add(mesh);
    const hand = new THREE.Mesh(s.handGeo, skinMat);
    hand.position.y = -0.58;
    hand.castShadow = true;
    pivot.add(hand);
    visual.add(pivot);
    return pivot;
  }
  const leftArm = buildArm(-0.32);
  const rightArm = buildArm(0.32);

  return { group, visual, torso, head, leftLeg, rightLeg, leftArm, rightArm };
}

export const HEALTH_BAR_WIDTH = 0.6;
export const HEALTH_BAR_Y = 2.0;

// Attaches a background + foreground health-bar sprite pair to `root` (should be the
// non-rotating root group, not the facing-rotated `visual`, so the bar stays level).
export function buildHealthBar(s, root, width = HEALTH_BAR_WIDTH, y = HEALTH_BAR_Y) {
  const healthBarBg = new THREE.Sprite(s.healthBarBgMat);
  healthBarBg.position.set(0, y, 0);
  healthBarBg.scale.set(width + 0.03, 0.1, 1);
  healthBarBg.renderOrder = 1;
  root.add(healthBarBg);

  // depthTest is already off on both sprites, but sorting *within* the transparent queue
  // still defaulted to camera-distance — relying on the 0.001 local z-offset above to keep
  // the foreground in front. That offset is small enough to lose float precision at normal
  // gameplay distances, which read as the colored bar intermittently disappearing behind
  // its own background while walking around (confirmed against the reported symptom).
  // Explicit renderOrder makes the draw order deterministic regardless of distance.
  const healthBarFgMat = new THREE.SpriteMaterial({ color: 0x4ddc7a, depthTest: false, depthWrite: false });
  const healthBarFg = new THREE.Sprite(healthBarFgMat);
  healthBarFg.position.set(0, y, 0.001);
  healthBarFg.scale.set(width, 0.08, 1);
  healthBarFg.renderOrder = 2;
  root.add(healthBarFg);

  return { healthBarBg, healthBarFg, healthBarFgMat };
}

// Shared left-anchored shrink-and-recolor update for a health bar built above.
//
// `cameraRight` must be the camera's current local +X axis in world space (e.g.
// `new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)`) — a Sprite's quad is
// always billboarded to face the camera, so its own "left/right" only lines up with the
// parent's fixed local X axis when the camera happens to be looking at it head-on. Shifting
// the anchor by a fixed local-X offset (the previous approach) reads as a correct left-cut
// only from that one viewing angle; from the side it shifts mostly in depth instead of
// screen-space, which is what read as "the entire bar shrinks in place" rather than a clip.
// Compensating along the camera's actual screen-right direction keeps the left edge visually
// anchored regardless of where the viewer is standing.
const DEFAULT_CAMERA_RIGHT = new THREE.Vector3(1, 0, 0);
export function updateHealthBarSprite(healthBarFg, healthBarFgMat, frac, cameraRight = DEFAULT_CAMERA_RIGHT, width = HEALTH_BAR_WIDTH) {
  const clamped = clamp(frac, 0, 1);
  healthBarFg.scale.x = width * clamped;
  const shift = -(width - healthBarFg.scale.x) / 2;
  healthBarFg.position.x = cameraRight.x * shift;
  healthBarFg.position.z = 0.001 + cameraRight.z * shift;
  healthBarFgMat.color.set(clamped > 0.6 ? 0x4ddc7a : clamped > 0.3 ? 0xf2c94c : 0xff4d5e);
}

// Below this distance, hide the floating health bar / name tag instead of letting them
// render at whatever their perspective-scaled world size works out to. These are
// fixed-world-size sprites with depthTest disabled (so they're never occluded, needed so
// they stay legible from any angle) — get the camera close enough and that combination
// means a small sprite grows to fill the screen *and* draws straight through the body in
// front of it instead of being hidden behind it. Confirmed by reproducing at ~0.6 units:
// the bar ballooned and rendered on top of the torso. Not useful at melee range anyway.
export const NAMEPLATE_MIN_DISTANCE = 2.2;

export function updateNameplateVisibility(sprites, distanceToCamera) {
  const visible = distanceToCamera > NAMEPLATE_MIN_DISTANCE;
  for (const sprite of sprites) sprite.visible = visible;
}

// Death ragdoll physics — shared by AI enemies (entities.js) and eliminated PvP players
// (remotePlayer.js) so both "explode apart" the same way.
const CORPSE_GRAVITY = -14;
const CORPSE_SINK_START = 5; // seconds before a settled part starts sinking through the floor
const CORPSE_SINK_SPEED = -0.6;
const CORPSE_DELETE_Y = -6; // once a part falls below this, drop it — keeps corpse count bounded
const CORPSE_MAX_SPEED = 12; // caps how hard even a point-blank blast can fling a limb

// Detaches a humanoid's limb chunks into free-flying scene objects and removes the (now
// empty) rig group. `blast`, if given as {origin: Vector3, strength: number}, adds an
// outward impulse scaled by proximity to the blast — this is what makes an explosive kill
// scatter the pieces much harder than a plain gunshot kill, which only gets a small random
// "collapse" scatter. Returns an array of tracked parts for updateCorpseParts() each frame.
// Caller is responsible for clearing its own held-weapon flash state first (Enemy has one
// gun's flash to zero; RemotePlayer has one per weapon prop) since that varies by caller.
export function breakApartHumanoid(scene, group, parts, blast = null) {
  const tracked = [];
  for (const mesh of parts) {
    scene.attach(mesh); // reparents mesh -> scene while preserving its current world transform

    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6 + 0.3, Math.random() - 0.5).normalize();
    const velocity = dir.multiplyScalar(1.5 + Math.random() * 1.5);

    if (blast) {
      const toPart = mesh.position.clone().sub(blast.origin);
      const dist = Math.max(0.8, toPart.length());
      const impulse = toPart.normalize().multiplyScalar(blast.strength / dist);
      velocity.add(impulse);
      velocity.y += (blast.strength / dist) * 0.4; // extra upward pop from the blast
    }
    if (velocity.length() > CORPSE_MAX_SPEED) velocity.setLength(CORPSE_MAX_SPEED);

    tracked.push({
      mesh,
      velocity,
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6
      ),
      age: 0,
    });
  }

  scene.remove(group);
  return tracked;
}

// Steps every tracked corpse part one frame: free-fall + a simple ground stop for the first
// few seconds (so a death still looks like it lands), then an unconditional slow sink through
// the floor past CORPSE_SINK_START, deleting each part once it clears CORPSE_DELETE_Y. That
// sink-and-delete is deliberate — a match spawns kills continuously, so without it corpse
// geometry would accumulate for the rest of the match instead of getting cleaned up.
export function updateCorpseParts(parts, dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.age += dt;
    const mesh = p.mesh;

    if (p.age < CORPSE_SINK_START) {
      p.velocity.y += CORPSE_GRAVITY * dt;
      mesh.position.addScaledVector(p.velocity, dt);
      if (mesh.position.y <= 0.05) {
        mesh.position.y = 0.05;
        p.velocity.y = 0;
        p.velocity.x *= 0.85;
        p.velocity.z *= 0.85;
        p.angularVelocity.multiplyScalar(0.85);
      }
      mesh.rotation.x += p.angularVelocity.x * dt;
      mesh.rotation.y += p.angularVelocity.y * dt;
      mesh.rotation.z += p.angularVelocity.z * dt;
    } else {
      mesh.position.y += CORPSE_SINK_SPEED * dt;
    }

    if (mesh.position.y < CORPSE_DELETE_Y) {
      if (mesh.parent) mesh.parent.remove(mesh);
      parts.splice(i, 1);
    }
  }
}
