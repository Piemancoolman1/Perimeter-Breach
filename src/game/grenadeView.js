import * as THREE from "three";

const BODY_GEO = new THREE.SphereGeometry(0.09, 12, 10);
const BODY_MAT = new THREE.MeshStandardMaterial({ color: 0x3a4a2f, roughness: 0.6, metalness: 0.3 });
const PIN_GEO = new THREE.TorusGeometry(0.03, 0.006, 6, 12);
const PIN_MAT = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.8, roughness: 0.3 });

const REST_POS = new THREE.Vector3(0.22, -0.28, -0.32);
const READY_POS = new THREE.Vector3(0.08, -0.13, -0.26);
const REST_ROT = new THREE.Euler(0.15, 0.3, 0);

// The view-model grenade held while aiming a throw. Raises into a ready pose on pickup and
// blinks steadily to read as "live" — no escalation, since holding it carries no risk.
export class GrenadeHeldView {
  constructor(camera) {
    this.group = new THREE.Group();

    const body = new THREE.Mesh(BODY_GEO, BODY_MAT);
    this.group.add(body);

    const pin = new THREE.Mesh(PIN_GEO, PIN_MAT);
    pin.position.set(0.07, 0.05, 0);
    pin.rotation.z = Math.PI / 2;
    this.group.add(pin);

    this.light = new THREE.PointLight(0xff4433, 0, 1.2);
    this.light.position.set(0, 0.05, 0.02);
    this.group.add(this.light);

    this.group.position.copy(REST_POS);
    this.group.rotation.copy(REST_ROT);
    this.group.visible = false;
    camera.add(this.group);
  }

  setHeld(held) {
    this.group.visible = held;
    if (!held) this.light.intensity = 0;
  }

  update(heldTime, elapsed) {
    if (!this.group.visible) return;
    this.group.position.lerpVectors(REST_POS, READY_POS, Math.min(1, heldTime * 6));
    this.light.intensity = Math.sin(elapsed * 5) > 0 ? 1.2 : 0;
  }

  getWorldPosition(target) {
    return this.group.getWorldPosition(target);
  }
}
