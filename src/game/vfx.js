import * as THREE from "three";
import { el } from "./dom.js";

// Short-lived scene decorations (tracer bolts, sparks, explosions) plus a few HUD micro-
// animations. `ctx.scene` is read fresh on every call (never destructured at construction
// time) since it's the one THREE.Scene built once in main.js and never reassigned.
export function createVfx(ctx) {
  const vfx = { activeFx: 0 };

  vfx.bolt = function bolt(from, to, color) {
    const path = new THREE.Vector3().subVectors(to, from);
    const length = Math.max(0.05, path.length());

    const geo = new THREE.CylinderGeometry(0.025, 0.025, length, 6);
    geo.translate(0, length / 2, 0);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(from);
    mesh.lookAt(to);
    ctx.scene.add(mesh);
    vfx.activeFx++;

    let life = 0.09;
    const fade = () => {
      life -= 1 / 60;
      mat.opacity = Math.max(0, life / 0.09) * 0.95;
      if (life <= 0) {
        ctx.scene.remove(mesh);
        geo.dispose();
        mat.dispose();
        vfx.activeFx--;
      } else {
        requestAnimationFrame(fade);
      }
    };
    fade();
  };

  vfx.sparkBurst = function sparkBurst(point, color) {
    const geo = new THREE.SphereGeometry(0.12, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(point);
    ctx.scene.add(mesh);
    vfx.activeFx++;

    let life = 0.18;
    const fade = () => {
      life -= 1 / 60;
      const t = Math.max(0, life / 0.18);
      mat.opacity = t * 0.9;
      mesh.scale.setScalar(1 + (1 - t) * 2.2);
      if (life <= 0) {
        ctx.scene.remove(mesh);
        geo.dispose();
        mat.dispose();
        vfx.activeFx--;
      } else {
        requestAnimationFrame(fade);
      }
    };
    fade();
  };

  vfx.explosionBurst = function explosionBurst(point, radius) {
    const geo = new THREE.SphereGeometry(0.3, 12, 10);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(point);
    ctx.scene.add(mesh);
    vfx.activeFx++;

    const light = new THREE.PointLight(0xff8a3a, 6, radius * 2.5);
    light.position.copy(point);
    ctx.scene.add(light);

    const maxScale = Math.max(1.5, radius * 0.7);
    let life = 0.35;
    const fade = () => {
      life -= 1 / 60;
      const t = Math.max(0, life / 0.35);
      mat.opacity = t * 0.95;
      mesh.scale.setScalar(1 + (1 - t) * maxScale);
      light.intensity = t * 6;
      if (life <= 0) {
        ctx.scene.remove(mesh);
        geo.dispose();
        mat.dispose();
        ctx.scene.remove(light);
        vfx.activeFx--;
      } else {
        requestAnimationFrame(fade);
      }
    };
    fade();
  };

  vfx.pulseCrosshair = function pulseCrosshair() {
    el.crosshair.classList.remove("fire");
    void el.crosshair.offsetWidth;
    el.crosshair.classList.add("fire");
  };

  vfx.pulseAmmoEmpty = function pulseAmmoEmpty() {
    el.ammoText.classList.remove("empty-pulse");
    void el.ammoText.offsetWidth;
    el.ammoText.classList.add("empty-pulse");
  };

  vfx.flashHit = function flashHit() {
    el.hitFlash.classList.add("show");
    setTimeout(() => el.hitFlash.classList.remove("show"), 90);
  };

  return vfx;
}
