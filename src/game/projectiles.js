import * as THREE from "three";
import { collideProjectile, projectileHitsObstacle } from "./world.js";

export const GRENADE_GRAVITY = -16;
export const GRENADE_RADIUS = 0.12;

const grenadeGeo = new THREE.SphereGeometry(GRENADE_RADIUS, 10, 8);
const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x3a4a2f, roughness: 0.6, metalness: 0.3 });

export class Grenade {
  constructor(scene, position, velocity, fuse) {
    this.scene = scene;
    this.velocity = velocity.clone();
    this.fuse = fuse;
    this.mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
    this.mesh.position.copy(position);
    scene.add(this.mesh);
  }

  // Returns true once the fuse has run out (caller should explode() and destroy()).
  update(dt, obstacles) {
    this.velocity.y += GRENADE_GRAVITY * dt;
    this.mesh.position.addScaledVector(this.velocity, dt);
    if (obstacles) collideProjectile(this.mesh.position, this.velocity, GRENADE_RADIUS, obstacles);
    if (this.mesh.position.y <= GRENADE_RADIUS) {
      this.mesh.position.y = GRENADE_RADIUS;
      this.velocity.y *= -0.3;
      this.velocity.x *= 0.5;
      this.velocity.z *= 0.5;
    }
    this.fuse -= dt;
    return this.fuse <= 0;
  }

  get position() {
    return this.mesh.position;
  }

  destroy() {
    this.scene.remove(this.mesh);
  }
}

// Ballistic preview for the cook-and-throw arc — mirrors Grenade.update()'s free-flight physics
// but stops at first ground contact instead of bouncing, since it's just a targeting aid.
export function predictGrenadeArc(origin, velocity, duration, steps = 24) {
  const points = [origin.clone()];
  const pos = origin.clone();
  const vel = velocity.clone();
  const dt = duration / steps;
  for (let i = 0; i < steps; i++) {
    vel.y += GRENADE_GRAVITY * dt;
    pos.addScaledVector(vel, dt);
    if (pos.y <= GRENADE_RADIUS) {
      pos.y = GRENADE_RADIUS;
      points.push(pos.clone());
      break;
    }
    points.push(pos.clone());
  }
  return points;
}

const ROCKET_GROUND_CLEARANCE = 0.06;
const ROCKET_RADIUS = 0.15; // a bit larger than the mesh's own radius — a forgiving contact check, matching GRENADE_RADIUS's spirit
const rocketGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.56, 8); // 2x the original 0.04/0.05/0.28
const rocketMat = new THREE.MeshStandardMaterial({
  color: 0x2a2a2a,
  emissive: 0xff6a2a,
  emissiveIntensity: 0.6,
  roughness: 0.6,
});

export class Rocket {
  constructor(scene, from, to, speed) {
    this.scene = scene;
    this.from = from.clone();
    this.to = to.clone();
    const dist = this.from.distanceTo(this.to);
    this.duration = Math.max(0.05, dist / speed);
    this.t = 0;
    this.arrived = false;

    this.mesh = new THREE.Mesh(rocketGeo, rocketMat);
    this.mesh.position.copy(this.from);
    this.mesh.lookAt(this.to);
    this.mesh.rotateX(Math.PI / 2);
    scene.add(this.mesh);

    this.light = new THREE.PointLight(0xff8a3a, 2, 5);
    this.mesh.add(this.light);
  }

  // Returns true the frame it reaches its target (caller should explode() and destroy()).
  // `obstacles`, when given, lets the rocket detonate the instant it actually touches a wall/
  // rock/building/car along the way, rather than only at its precomputed impact point — the
  // fire-time raycast (combat.js) already accounts for obstacles in the way *at that moment*,
  // but nothing previously re-checked during flight, so anything that moved into the path (or
  // any mismatch between the aim raycast and the rocket's own travel line) let it visibly fly
  // through solid geometry with no explosion at all.
  update(dt, obstacles) {
    if (this.arrived) return false;
    this.t += dt / this.duration;
    if (this.t >= 1) {
      this.mesh.position.copy(this.to);
      this.arrived = true;
      return true;
    }
    this.mesh.position.lerpVectors(this.from, this.to, this.t);
    // Backstop against tunneling through the terrain: even if `to` itself ended up underground
    // (a bad target point), detonate on ground contact instead of visibly clipping through it.
    if (this.mesh.position.y <= ROCKET_GROUND_CLEARANCE) {
      this.mesh.position.y = ROCKET_GROUND_CLEARANCE;
      this.arrived = true;
      return true;
    }
    if (obstacles && projectileHitsObstacle(this.mesh.position, ROCKET_RADIUS, obstacles)) {
      this.arrived = true;
      return true;
    }
    return false;
  }

  get position() {
    return this.mesh.position;
  }

  destroy() {
    this.scene.remove(this.mesh);
  }
}

// Pure damage query — does not touch score/HUD/respawn bookkeeping, that's main.js's job.
export function splashDamageEnemies(position, radius, damage, enemies) {
  const killed = [];
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = e.group.position.distanceTo(position);
    if (d <= radius) {
      const falloff = 1 - d / radius;
      const amount = damage * Math.max(0.35, falloff);
      if (e.takeDamage(amount)) killed.push(e);
    }
  }
  return killed;
}

export function splashDamagePlayer(position, radius, damage, playerPosition) {
  const d = playerPosition.distanceTo(position);
  if (d > radius) return 0;
  const falloff = 1 - d / radius;
  return damage * Math.max(0.35, falloff);
}
