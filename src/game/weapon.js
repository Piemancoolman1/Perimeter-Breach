import * as THREE from "three";

const AIM_LERP_SPEED = 11;
const RECOIL_DECAY = 14;
const FLASH_DURATION = 0.06;
const RELOAD_DIP_POS = 0.22;
const RELOAD_DIP_ROT = 0.6;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const textureLoader = new THREE.TextureLoader();
function loadGunTexture(path, colorSpace) {
  const tex = textureLoader.load(path);
  if (colorSpace) tex.colorSpace = colorSpace;
  return tex;
}

// Exported so third-person weapon props (humanoidParts.js's buildWeaponProp, used for
// AI enemies and networked remote players) can share the exact same textured material
// instead of a flat placeholder color — that mismatch is what read as "doesn't look like
// the first-person gun" once remote players started rendering their held weapon.
export const metalMat = new THREE.MeshStandardMaterial({
  map: loadGunTexture("/textures/gun-color.jpg", THREE.SRGBColorSpace),
  roughnessMap: loadGunTexture("/textures/gun-roughness.jpg"),
  metalnessMap: loadGunTexture("/textures/gun-metalness.jpg"),
  normalMap: loadGunTexture("/textures/gun-normal.jpg"),
  roughness: 1,
  metalness: 1,
});
export const lensMat = new THREE.MeshStandardMaterial({
  color: 0xff3b30,
  emissive: 0xff2a20,
  emissiveIntensity: 1.4,
  roughness: 0.3,
  metalness: 0.1,
});
export const scopeLensMat = new THREE.MeshStandardMaterial({
  color: 0x0a2a3a,
  emissive: 0x1a5a7a,
  emissiveIntensity: 0.6,
  roughness: 0.15,
  metalness: 0.3,
});

function buildMuzzleFlashParts(localPos) {
  const muzzleTip = new THREE.Object3D();
  muzzleTip.position.copy(localPos);

  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xbdf3ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), flashMat);
  flash.position.copy(localPos);

  const flashLight = new THREE.PointLight(0x8fe8ff, 0, 4);
  flashLight.position.copy(localPos);

  return { muzzleTip, flash, flashMat, flashLight };
}

function buildPistolMesh() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.24), metalMat);
  body.position.set(0, 0, 0.02);
  group.add(body);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.14, 8), metalMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.16);
  group.add(barrel);

  const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), metalMat);
  rearSight.position.set(0, 0.062, 0.1);
  group.add(rearSight);

  const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.02, 0.012), metalMat);
  frontSight.position.set(0, 0.035, -0.2);
  group.add(frontSight);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.16, 0.09), metalMat);
  grip.position.set(0, -0.142, 0.11);
  grip.rotation.x = 0.28;
  group.add(grip);

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.055), metalMat);
  mag.position.set(0, -0.2, 0.11);
  group.add(mag);

  const fx = buildMuzzleFlashParts(new THREE.Vector3(0, 0.01, -0.23));
  group.add(fx.muzzleTip, fx.flash, fx.flashLight);

  return {
    group,
    muzzleTip: fx.muzzleTip,
    flash: fx.flash,
    flashMat: fx.flashMat,
    flashLight: fx.flashLight,
    sightLocal: new THREE.Vector3(0, 0.062, 0.1),
    restPos: new THREE.Vector3(0.26, -0.26, -0.42),
    restRot: new THREE.Euler(0.02, -0.14, 0),
  };
}

function buildAk47Mesh() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.13, 0.42), metalMat);
  body.position.set(0, 0, 0.05);
  group.add(body);

  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.015, 0.36), metalMat);
  rail.position.set(0, 0.072, 0.015);
  group.add(rail);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.32, 10), metalMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.315);
  group.add(barrel);

  const barrelTip = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.04, 10), metalMat);
  barrelTip.rotation.x = Math.PI / 2;
  barrelTip.position.set(0, 0.01, -0.475);
  group.add(barrelTip);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22, 0.1), metalMat);
  grip.position.set(0, -0.15, 0.2);
  grip.rotation.x = 0.35;
  group.add(grip);

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 0.09), metalMat);
  mag.position.set(0, -0.19, 0.06);
  mag.rotation.x = -0.28;
  group.add(mag);

  const sightPostFront = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.045, 0.012), metalMat);
  sightPostFront.position.set(0, 0.09, -0.16);
  group.add(sightPostFront);

  const sightPostRear = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.045, 0.012), metalMat);
  sightPostRear.position.set(0, 0.09, 0.12);
  group.add(sightPostRear);

  const sightRing = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.006, 8, 16), lensMat);
  sightRing.position.set(0, 0.115, -0.16);
  group.add(sightRing);

  const fx = buildMuzzleFlashParts(new THREE.Vector3(0, 0.01, -0.495));
  group.add(fx.muzzleTip, fx.flash, fx.flashLight);

  return {
    group,
    muzzleTip: fx.muzzleTip,
    flash: fx.flash,
    flashMat: fx.flashMat,
    flashLight: fx.flashLight,
    sightLocal: new THREE.Vector3(0, 0.115, -0.16),
    restPos: new THREE.Vector3(0.32, -0.32, -0.62),
    restRot: new THREE.Euler(0.03, -0.18, 0),
  };
}

function buildSniperMesh() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.55), metalMat);
  body.position.set(0, 0, 0.02);
  group.add(body);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.42, 10), metalMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.005, -0.45);
  group.add(barrel);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.24), metalMat);
  stock.position.set(0, -0.03, 0.34);
  group.add(stock);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.09), metalMat);
  grip.position.set(0, -0.14, 0.16);
  grip.rotation.x = 0.3;
  group.add(grip);

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.06), metalMat);
  mag.position.set(0, -0.17, 0.06);
  group.add(mag);

  const scopeTube = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 12), metalMat);
  scopeTube.rotation.x = Math.PI / 2;
  scopeTube.position.set(0, 0.087, -0.02);
  group.add(scopeTube);

  const scopeFrontLens = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.01, 12), scopeLensMat);
  scopeFrontLens.rotation.x = Math.PI / 2;
  scopeFrontLens.position.set(0, 0.087, -0.18);
  group.add(scopeFrontLens);

  const scopeRearLens = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.01, 12), scopeLensMat);
  scopeRearLens.rotation.x = Math.PI / 2;
  scopeRearLens.position.set(0, 0.087, 0.14);
  group.add(scopeRearLens);

  // Bipod legs are pivot-mounted so the top always sits exactly on the barrel's underside
  // regardless of splay angle, rather than being a straight box that only touches by luck.
  function buildBipodLeg(xSign) {
    const pivot = new THREE.Object3D();
    pivot.position.set(0, -0.019, -0.4);
    pivot.rotation.z = xSign * 0.5;
    const legLength = 0.18;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.012, legLength, 0.012), metalMat);
    leg.position.y = -legLength / 2;
    pivot.add(leg);
    group.add(pivot);
    return pivot;
  }
  buildBipodLeg(-1);
  buildBipodLeg(1);

  const fx = buildMuzzleFlashParts(new THREE.Vector3(0, 0.005, -0.66));
  group.add(fx.muzzleTip, fx.flash, fx.flashLight);

  return {
    group,
    muzzleTip: fx.muzzleTip,
    flash: fx.flash,
    flashMat: fx.flashMat,
    flashLight: fx.flashLight,
    sightLocal: new THREE.Vector3(0, 0.087, 0.14),
    restPos: new THREE.Vector3(0.3, -0.32, -0.58),
    restRot: new THREE.Euler(0.02, -0.15, 0),
  };
}

function buildBazookaMesh() {
  const group = new THREE.Group();

  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.85, 12), metalMat);
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, 0, -0.05);
  group.add(tube);

  const rearCap = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.1, 0.08, 12), metalMat);
  rearCap.rotation.x = Math.PI / 2;
  rearCap.position.set(0, 0, 0.38);
  group.add(rearCap);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.09), metalMat);
  grip.position.set(0, -0.15, 0.05);
  grip.rotation.x = 0.3;
  group.add(grip);

  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.2), metalMat);
  handguard.position.set(0, -0.11, -0.2);
  group.add(handguard);

  const sightPost = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.05, 0.014), metalMat);
  sightPost.position.set(0, 0.11, -0.15);
  group.add(sightPost);

  const sightRing = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.005, 8, 16), lensMat);
  sightRing.position.set(0, 0.13, -0.15);
  group.add(sightRing);

  const fx = buildMuzzleFlashParts(new THREE.Vector3(0, 0, -0.48));
  group.add(fx.muzzleTip, fx.flash, fx.flashLight);

  return {
    group,
    muzzleTip: fx.muzzleTip,
    flash: fx.flash,
    flashMat: fx.flashMat,
    flashLight: fx.flashLight,
    sightLocal: new THREE.Vector3(0, 0.13, -0.15),
    restPos: new THREE.Vector3(0.28, -0.3, -0.4),
    restRot: new THREE.Euler(0.02, -0.1, 0),
  };
}

// No muzzle to speak of on a blade — buildMuzzleFlashParts is still used (getMuzzleWorldPosition
// is called unconditionally by fireWeapon() regardless of weapon type) but placed at the blade
// tip, where the brief flash on a swing reads as a glint rather than a gunshot.
function buildKnifeMesh() {
  const group = new THREE.Group();

  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.14), metalMat);
  handle.position.set(0, 0, 0.09);
  group.add(handle);

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.02), metalMat);
  guard.position.set(0, 0, 0.02);
  group.add(guard);

  // A single flattened box for the whole blade (no separate tapered tip) — keeps this
  // in the same box-primitive language as the rest of the low-poly art, and avoids the
  // FP/TP axis-conversion ambiguity a rotated cone would add for one small detail.
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.006, 0.26), metalMat);
  blade.position.set(0, 0, -0.15);
  group.add(blade);

  const fx = buildMuzzleFlashParts(new THREE.Vector3(0, 0, -0.28));
  group.add(fx.muzzleTip, fx.flash, fx.flashLight);

  return {
    group,
    muzzleTip: fx.muzzleTip,
    flash: fx.flash,
    flashMat: fx.flashMat,
    flashLight: fx.flashLight,
    sightLocal: new THREE.Vector3(0, 0, -0.24),
    restPos: new THREE.Vector3(0.2, -0.22, -0.3),
    restRot: new THREE.Euler(0.1, -0.3, 0.15),
  };
}

const BUILDERS = {
  pistol: buildPistolMesh,
  ak47: buildAk47Mesh,
  sniper: buildSniperMesh,
  bazooka: buildBazookaMesh,
  knife: buildKnifeMesh,
};

export class Weapon {
  constructor(camera, def) {
    const built = BUILDERS[def.id]();
    this.def = def;
    this.group = built.group;
    this.muzzleTip = built.muzzleTip;
    this.flash = built.flash;
    this.flashMat = built.flashMat;
    this.flashLight = built.flashLight;

    this.restPos = built.restPos;
    this.restRot = built.restRot;
    this.aimRot = new THREE.Euler(0, 0, 0);
    this.aimPos = new THREE.Vector3(
      -built.sightLocal.x,
      -built.sightLocal.y,
      -def.aimViewDistance - built.sightLocal.z
    );

    this.group.position.copy(this.restPos);
    this.group.rotation.copy(this.restRot);
    camera.add(this.group);

    this.recoil = 0;
    this.flashTime = 0;
    this.bobPhase = 0;
    this.aiming = false;
    this.aimProgress = 0;
    this.isActive = false;
    this.forceHidden = false;
    this._pos = new THREE.Vector3();
  }

  setActive(active) {
    this.isActive = active;
    this.group.visible = active && !this.forceHidden;
  }

  // Holsters the view model without touching isActive/aiming state — used while both hands
  // are busy with a cooking grenade, so the gun reappears exactly as it was on release.
  // Applies visibility immediately rather than waiting for the next update()/setActive() —
  // callers may invoke this while the game loop is paused (e.g. hiding the gun on the menu),
  // where no per-frame update() ever runs to pick up the change.
  setForceHidden(hidden) {
    this.forceHidden = hidden;
    this.group.visible = this.isActive && !this.scopedIn && !this.forceHidden;
  }

  // True once fully zoomed on a scoped weapon — the view model (including the scope tube
  // itself) is hidden past this point so nothing physically blocks the zoomed-in view.
  get scopedIn() {
    return !!this.def.scoped && this.aimProgress > 0.85;
  }

  fire() {
    this.recoil = 1;
    this.flashTime = FLASH_DURATION;
  }

  setAiming(aiming) {
    this.aiming = aiming;
  }

  update(dt, elapsed, isMoving, reloadFraction = 0) {
    this.recoil *= Math.exp(-RECOIL_DECAY * dt);
    if (this.recoil < 0.002) this.recoil = 0;

    const aimTarget = this.aiming ? 1 : 0;
    this.aimProgress += (aimTarget - this.aimProgress) * Math.min(1, AIM_LERP_SPEED * dt);
    if (Math.abs(aimTarget - this.aimProgress) < 0.001) this.aimProgress = aimTarget;
    const aim = this.aimProgress;

    const reloadDip = Math.sin(Math.min(1, Math.max(0, reloadFraction)) * Math.PI);

    this.bobPhase += dt * (isMoving ? 9 : 1.5);
    const bobAmt = (isMoving ? 0.006 : 0.0018) * (1 - aim * 0.9);
    const kickPos = this.def.kickPos * (1 - aim * 0.5);
    const kickRot = this.def.kickRot * (1 - aim * 0.5);

    this._pos.copy(this.restPos).lerp(this.aimPos, aim);
    this.group.position.set(
      this._pos.x,
      this._pos.y + Math.sin(this.bobPhase * 2) * bobAmt - reloadDip * RELOAD_DIP_POS,
      this._pos.z + this.recoil * kickPos
    );
    this.group.rotation.set(
      lerp(this.restRot.x, this.aimRot.x, aim) - this.recoil * kickRot + reloadDip * RELOAD_DIP_ROT,
      lerp(this.restRot.y, this.aimRot.y, aim) + Math.sin(this.bobPhase) * bobAmt * 0.6,
      lerp(this.restRot.z, this.aimRot.z, aim)
    );

    this.group.visible = this.isActive && !this.scopedIn && !this.forceHidden;

    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const t = Math.max(0, this.flashTime / FLASH_DURATION);
      this.flashMat.opacity = t * 0.95;
      this.flash.scale.setScalar(0.6 + (1 - t) * 1.4);
      this.flashLight.intensity = t * 6;
    } else {
      this.flashMat.opacity = 0;
      this.flashLight.intensity = 0;
    }
  }

  getMuzzleWorldPosition(target) {
    return this.muzzleTip.getWorldPosition(target);
  }
}
