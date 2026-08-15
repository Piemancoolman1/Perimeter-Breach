import { Weapon } from "./weapon.js";
import { WEAPON_DEFS } from "./weaponDefs.js";

class WeaponSlot {
  constructor(def) {
    this.def = def;
    this.ammo = def.magSize;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.fireCooldown = 0;
  }

  get reloadFraction() {
    return this.isReloading ? 1 - Math.max(0, this.reloadTimer / this.def.reloadDuration) : 0;
  }

  canFire() {
    return !this.isReloading && this.ammo > 0 && this.fireCooldown <= 0;
  }

  fire() {
    if (!this.canFire()) return false;
    this.ammo--;
    this.fireCooldown = this.def.fireRate;
    return true;
  }

  startReload() {
    if (this.isReloading || this.ammo >= this.def.magSize) return false;
    this.isReloading = true;
    this.reloadTimer = this.def.reloadDuration;
    return true;
  }

  reset() {
    this.ammo = this.def.magSize;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.fireCooldown = 0;
  }

  update(dt) {
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.isReloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.isReloading = false;
        this.reloadTimer = 0;
        this.ammo = this.def.magSize;
      }
    }
  }
}

const DEFAULT_WEAPON_ID = "ak47";

export class Loadout {
  constructor(camera) {
    this.entries = WEAPON_DEFS.map((def) => ({
      def,
      slot: new WeaponSlot(def),
      view: new Weapon(camera, def),
    }));
    const defaultIndex = Math.max(0, this.entries.findIndex((e) => e.def.id === DEFAULT_WEAPON_ID));
    this.currentIndex = defaultIndex;
    this.entries.forEach((e, i) => e.view.setActive(i === defaultIndex));
    // Set by setClass() once the player has picked a class — while locked, cycling through
    // the other weapons is disabled (see switchTo below) since a class means "this one gun",
    // not "everything, starting from this one". Still built as a full Loadout of all weapons
    // internally (nothing else about entries/views changes) so switching classes later is
    // just picking a different already-built entry, not rebuilding anything.
    this.lockedWeaponId = null;
  }

  get current() {
    return this.entries[this.currentIndex];
  }

  switchTo(index, aimingHeld) {
    if (this.lockedWeaponId) return; // class-restricted — no free weapon switching
    const wrapped = ((index % this.entries.length) + this.entries.length) % this.entries.length;
    if (wrapped === this.currentIndex) return;
    this.current.view.setActive(false);
    this.current.view.setAiming(false);
    this.currentIndex = wrapped;
    this.current.view.setActive(true);
    this.current.view.setAiming(!!aimingHeld);
  }

  // Locks the loadout to one weapon (see the class-select screen in main.js). Always gives
  // the newly-selected weapon a fresh mag/reload state itself, independent of whether a full
  // reset() also happens right after (it doesn't for a single-player mid-game class change,
  // which intentionally skips resetGame() so kills/enemies/health aren't wiped just for a
  // loadout swap — so this can't rely on reset() to be the one place ammo gets cleared).
  setClass(weaponId) {
    this.lockedWeaponId = weaponId;
    const idx = Math.max(0, this.entries.findIndex((e) => e.def.id === weaponId));
    const entry = this.entries[idx];
    entry.slot.reset();
    if (idx === this.currentIndex) return;
    this.current.view.setActive(false);
    this.current.view.setAiming(false);
    this.currentIndex = idx;
    this.current.view.setActive(true);
  }

  cycle(direction, aimingHeld) {
    this.switchTo(this.currentIndex + direction, aimingHeld);
  }

  fire() {
    return this.current.slot.fire();
  }

  startReload() {
    return this.current.slot.startReload();
  }

  setAiming(aiming) {
    this.current.view.setAiming(aiming);
  }

  setForceHidden(hidden) {
    this.current.view.setForceHidden(hidden);
  }

  reset() {
    for (const e of this.entries) {
      e.slot.reset();
      e.view.recoil = 0;
      e.view.flashTime = 0;
      e.view.aiming = false;
      e.view.aimProgress = 0;
      e.view.setForceHidden(false);
    }
    // Respects a class lock if one's set (i.e. respawning keeps your chosen class's weapon,
    // not always the plain default) — falls back to the old always-AK47 default only if
    // setClass() was never called at all.
    const targetId = this.lockedWeaponId || DEFAULT_WEAPON_ID;
    const targetIndex = Math.max(0, this.entries.findIndex((e) => e.def.id === targetId));
    this.currentIndex = targetIndex;
    this.entries.forEach((e, i) => e.view.setActive(i === targetIndex));
  }

  update(dt, elapsed, isMoving) {
    for (const e of this.entries) e.slot.update(dt);
    this.current.view.update(dt, elapsed, isMoving, this.current.slot.reloadFraction);
  }
}
