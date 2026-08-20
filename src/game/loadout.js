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

  fire(rateMult = 1) {
    if (!this.canFire()) return false;
    this.ammo--;
    this.fireCooldown = this.def.fireRate * rateMult;
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

const DEFAULT_WEAPON_ID = "smg";
const SIDEARM_WEAPON_ID = "pistol"; // every class's secondary — see setClass()

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
    // Set by setClass() once the player has picked a class — [primaryWeaponId, pistolId].
    // cycle() only ever steps between these two (see below), never the full weapon roster —
    // a class means "this gun, plus a pistol sidearm," not "everything." Still built
    // as a full Loadout of every weapon internally (nothing else about entries/views changes)
    // so switching classes later is just picking different already-built entries, not
    // rebuilding anything.
    this.allowedWeaponIds = null;
  }

  get current() {
    return this.entries[this.currentIndex];
  }

  _indexForId(id) {
    return Math.max(0, this.entries.findIndex((e) => e.def.id === id));
  }

  switchToIndex(index, aimingHeld) {
    if (index === this.currentIndex) return;
    this.current.view.setActive(false);
    this.current.view.setAiming(false);
    this.currentIndex = index;
    this.current.view.setActive(true);
    this.current.view.setAiming(!!aimingHeld);
  }

  // Locks the loadout to one primary weapon plus the universal pistol sidearm (see the
  // class-select screen in main.js). Always gives both a fresh mag/reload state itself,
  // independent of whether a full reset() also happens right after (it doesn't for a
  // single-player mid-game class change, which intentionally skips startSession() so kills/
  // enemies/health aren't wiped just for a loadout swap — so this can't rely on reset() to be
  // the one place ammo gets cleared).
  setClass(weaponId) {
    this.allowedWeaponIds = [weaponId, SIDEARM_WEAPON_ID];
    const idx = this._indexForId(weaponId);
    this.entries[idx].slot.reset();
    this.entries[this._indexForId(SIDEARM_WEAPON_ID)].slot.reset();
    if (idx === this.currentIndex) return;
    this.current.view.setActive(false);
    this.current.view.setAiming(false);
    this.currentIndex = idx;
    this.current.view.setActive(true);
  }

  // Steps to the other weapon in allowedWeaponIds — the only form of weapon switching once a
  // class is locked in. With exactly two allowed weapons per class, any nonzero `direction`
  // (the scroll wheel's up/down) toggles between them; kept as a general step-through-the-list
  // rather than a hardcoded toggle in case a class ever gets more than one sidearm option.
  cycle(direction, aimingHeld) {
    if (!this.allowedWeaponIds || this.allowedWeaponIds.length < 2) return;
    const ids = this.allowedWeaponIds;
    const curPos = ids.indexOf(this.current.def.id);
    const nextPos = ((curPos + direction) % ids.length + ids.length) % ids.length;
    this.switchToIndex(this._indexForId(ids[nextPos]), aimingHeld);
  }

  fire(rateMult = 1) {
    return this.current.slot.fire(rateMult);
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
    // Respects a class lock if one's set (i.e. respawning keeps your chosen class's primary
    // weapon, not always the plain default) — falls back to the default only if setClass()
    // was never called at all.
    const targetId = (this.allowedWeaponIds && this.allowedWeaponIds[0]) || DEFAULT_WEAPON_ID;
    const targetIndex = Math.max(0, this.entries.findIndex((e) => e.def.id === targetId));
    this.currentIndex = targetIndex;
    this.entries.forEach((e, i) => e.view.setActive(i === targetIndex));
  }

  update(dt, elapsed, isMoving) {
    for (const e of this.entries) e.slot.update(dt);
    this.current.view.update(dt, elapsed, isMoving, this.current.slot.reloadFraction);
  }
}
