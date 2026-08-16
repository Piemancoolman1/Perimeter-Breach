import * as THREE from "three";
import { el } from "./dom.js";
import { settings } from "./settings.js";
import { formatGrenadeCount } from "./hud.js";
import { GRENADE_DEF } from "./weaponDefs.js";
import { Grenade, Rocket, splashDamageEnemies, splashDamagePlayer } from "./projectiles.js";
import { breakApartEnemy } from "./entities.js";
import { loadPlayerName } from "./lobbyUi.js";

// Weapon firing, grenade throwing, and explosion/splash-damage handling — the local player's
// entire "deal damage" surface. Never touches a remote player's health directly (see
// explodeAt/fireWeapon's own comments): a hit on a peer sends *them* a message and their own
// client decides what happens, the trust model this whole game is built on.
export function createCombat(ctx) {
  function grenadeThrowVelocity() {
    const forward = new THREE.Vector3();
    ctx.camera.getWorldDirection(forward);
    const velocity = forward.clone().multiplyScalar(GRENADE_DEF.throwSpeed);
    velocity.y += GRENADE_DEF.throwSpeed * 0.35;
    return velocity;
  }

  function consumeGrenadeCharge() {
    if (!ctx.INFINITE_GRENADES) ctx.grenadeCount--;
    ctx.grenadeCooldown = GRENADE_DEF.cooldown;
    el.grenadeCount.textContent = formatGrenadeCount(ctx.grenadeCount);
  }

  function stopHoldingGrenade() {
    ctx.grenadeHeld = false;
    ctx.grenadeHeldTime = 0;
    ctx.grenadeHeldView.setHeld(false);
    ctx.trajectoryLine.visible = false;
    ctx.loadout.current.view.setForceHidden(false);
  }

  function startHoldingGrenade() {
    if (ctx.grenadeHeld || ctx.grenadeCooldown > 0) return;
    if (!ctx.INFINITE_GRENADES && ctx.grenadeCount <= 0) return;
    ctx.grenadeHeld = true;
    ctx.grenadeHeldTime = 0;
    ctx.grenadeHeldView.setHeld(true);
    ctx.loadout.current.view.setForceHidden(true);
  }

  function releaseGrenade() {
    if (!ctx.grenadeHeld) return;
    const velocity = grenadeThrowVelocity();
    const origin = ctx.grenadeHeldView.getWorldPosition(new THREE.Vector3());

    stopHoldingGrenade();
    consumeGrenadeCharge();
    ctx.grenades.push(new Grenade(ctx.scene, origin, velocity, GRENADE_DEF.fuse));
  }

  function registerKill(enemy, blast = null) {
    ctx.corpseParts.push(...breakApartEnemy(ctx.scene, enemy, blast));
    ctx.pendingSpawns.push(ctx.ENEMY_RESPAWN_DELAY);
    ctx.debugGraphs.markKill();
    ctx.kills++;
    el.kills.textContent = `${ctx.kills} / ${ctx.TOTAL_KILLS_TO_WIN}`;
    if (ctx.kills >= ctx.TOTAL_KILLS_TO_WIN) ctx.hud.endGame(true);
  }

  // The look/sound of an explosion with none of the damage side effects — used both by a
  // real explosion below and by the visual-only echo of a peer's bazooka rocket arriving
  // (that one must never deal damage locally; only the original shooter's client does).
  function explodeVisualOnly(position, radius) {
    ctx.vfx.explosionBurst(position, radius);
    ctx.sounds.play("explosion", { volume: 0.8, rate: 0.96 + Math.random() * 0.08 });
  }

  function explodeAt(position, radius, damage) {
    explodeVisualOnly(position, radius);

    const killed = splashDamageEnemies(position, radius, damage, ctx.enemies);
    const blast = { origin: position, strength: damage * 0.06 };
    for (const e of killed) registerKill(e, blast);

    if (ctx.inMatch && ctx.lobby) {
      // Same "send them the hit, never touch their health directly" rule as hitscan. `blast`
      // (already computed above for the enemy ragdoll) rides along so that if this hit is
      // lethal, the victim's peers see their avatar scatter apart like an explosive enemy
      // kill instead of a plain-gunshot collapse.
      for (const rp of ctx.remotePlayers.values()) {
        const dmg = splashDamagePlayer(position, radius, damage, rp.group.position);
        if (dmg > 0) {
          ctx.lobby.relayToPlayer(rp.id, { t: "hit", damage: dmg, fromId: ctx.myPlayerId, fromName: loadPlayerName(), blast });
        }
      }
    }

    const playerDmg = splashDamagePlayer(position, radius, damage, ctx.camera.position);
    if (playerDmg > 0) {
      if (ctx.inMatch) {
        ctx.matchLifecycle.damageLocalPlayer(playerDmg, null, "", blast); // a suicide via your own blast — no kill credit
      } else {
        ctx.player.takeDamage(playerDmg);
        ctx.vfx.flashHit();
        if (ctx.player.health <= 0) ctx.hud.endGame(false);
      }
    }
  }

  function fireWeapon() {
    const def = ctx.loadout.current.def;
    if (!ctx.loadout.fire()) {
      if (!ctx.loadout.current.slot.isReloading && ctx.loadout.current.slot.ammo <= 0) ctx.vfx.pulseAmmoEmpty();
      return;
    }

    ctx.loadout.current.view.fire();
    ctx.vfx.pulseCrosshair();
    ctx.fovKick = 2.2;
    ctx.debugGraphs.markShot();
    ctx.sounds.play(`fire_${def.id}`, { volume: 0.8, rate: 0.98 + Math.random() * 0.04 });

    ctx.raycaster.setFromCamera(ctx.screenCenter, ctx.camera);
    // A shared Raycaster instance is reused for every weapon's shot — always set `.far`
    // explicitly each time rather than only for melee, or a knife's short range would
    // otherwise leak into whatever weapon fires next after a class change.
    ctx.raycaster.far = def.range ?? Infinity;
    if (def.spread > 0) {
      ctx.raycaster.ray.direction.x += (Math.random() - 0.5) * def.spread;
      ctx.raycaster.ray.direction.y += (Math.random() - 0.5) * def.spread;
      ctx.raycaster.ray.direction.normalize();
    }

    const enemyMeshes = ctx.enemies.filter((e) => e.alive).map((e) => e.mesh);
    const remoteMeshes = [...ctx.remotePlayers.values()].map((rp) => rp.mesh);
    const hits = ctx.raycaster.intersectObjects([...enemyMeshes, ...remoteMeshes, ...ctx.obstacleMeshes], false);

    const muzzleOrigin = ctx.loadout.current.view.getMuzzleWorldPosition(new THREE.Vector3());
    let hitPoint;
    if (hits.length > 0) {
      hitPoint = hits[0].point.clone();
    } else {
      // Nothing hit (no obstacle/enemy raycast target includes the ground plane) — a flat
      // 60-unit-out fallback point can end up underground on any downward-angled shot, which is
      // what let the bazooka's rocket travel straight through the terrain. Clamp the fallback to
      // where the aim ray actually crosses ground level (y=0) when it's heading downward.
      const dir = ctx.raycaster.ray.direction;
      const groundDist = dir.y < -1e-4 ? -ctx.camera.position.y / dir.y : Infinity;
      const dist = Math.min(def.range ?? 60, groundDist);
      hitPoint = ctx.camera.position.clone().addScaledVector(dir, dist);
    }

    let hitRemote = false;
    if (def.hitscan) {
      if (hits.length > 0) {
        const hit = hits[0];
        const enemy = ctx.enemies.find((e) => e.mesh === hit.object);
        const remote = enemy ? null : [...ctx.remotePlayers.values()].find((rp) => rp.mesh === hit.object);
        // No bullet tracer for a knife swing — a spark at the hit point is enough feedback.
        if (!def.melee) ctx.vfx.bolt(muzzleOrigin, hit.point, enemy || remote ? 0x4de3ff : 0x8a8172);
        ctx.vfx.sparkBurst(hit.point, enemy || remote ? 0x9be9ff : 0xbfae8a);
        if (enemy) {
          ctx.sounds.play("hitmarker", { volume: 0.6 });
          if (enemy.takeDamage(def.damage)) registerKill(enemy);
        } else if (remote) {
          // Never touch the remote player's health directly — send *them* the hit and let
          // their own client decide what happens, same trust model as everything else here.
          hitRemote = true;
          ctx.sounds.play("hitmarker", { volume: 0.6 });
          if (ctx.lobby) {
            ctx.lobby.relayToPlayer(remote.id, { t: "hit", damage: def.damage, fromId: ctx.myPlayerId, fromName: loadPlayerName() });
          }
        }
      } else if (!def.melee) {
        ctx.vfx.bolt(muzzleOrigin, hitPoint, 0x2a6b7a);
      }
    } else {
      const rocket = new Rocket(ctx.scene, muzzleOrigin, hitPoint, def.projectileSpeed);
      rocket.splashRadius = def.splashRadius;
      rocket.splashDamage = def.splashDamage;
      ctx.rockets.push(rocket);
    }

    // Let peers see and hear this shot too — a plain visual/audio echo (handled on their
    // end by handleRelay's "fire" case), never a source of damage authority on its own.
    // The muzzle point itself isn't sent: each receiver draws the tracer from *their own*
    // replicated copy of the shooter's rig (rp.getMuzzleWorldPosition()), which is more
    // accurate than trusting a raw coordinate that may be a tick stale by arrival.
    if (ctx.inMatch && ctx.lobby) {
      ctx.lobby.relayToRoom({
        t: "fire",
        weaponId: def.id,
        hitPoint: { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
        hitPlayer: hitRemote,
      });
    }
  }

  function setAiming(aiming) {
    ctx.aimHeld = aiming;
    ctx.loadout.setAiming(aiming);
    if (settings.hideCrosshairWhileAiming) el.crosshair.style.display = aiming ? "none" : "";
  }

  function doReload() {
    if (ctx.state !== "playing" || ctx.grenadeHeld) return;
    if (ctx.loadout.startReload() && ctx.aimHeld) setAiming(false);
  }

  // Extracted so the touch Fire/Aim buttons drive the exact same state the mouse handlers
  // below do, instead of duplicating the state === "playing"/grenadeHeld guard and the
  // toggleAim branching a second time.
  function handleFireStart() {
    if (ctx.state !== "playing" || ctx.grenadeHeld) return;
    ctx.leftMouseHeld = true;
    fireWeapon();
  }
  function handleFireEnd() {
    ctx.leftMouseHeld = false;
  }
  function handleAimStart() {
    if (ctx.state !== "playing" || ctx.grenadeHeld) return;
    setAiming(settings.toggleAim ? !ctx.aimHeld : true);
  }
  function handleAimEnd() {
    if (!settings.toggleAim) setAiming(false);
  }

  return {
    grenadeThrowVelocity,
    consumeGrenadeCharge,
    stopHoldingGrenade,
    startHoldingGrenade,
    releaseGrenade,
    registerKill,
    explodeVisualOnly,
    explodeAt,
    fireWeapon,
    setAiming,
    doReload,
    handleFireStart,
    handleFireEnd,
    handleAimStart,
    handleAimEnd,
  };
}
