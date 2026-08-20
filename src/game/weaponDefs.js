// Data-driven weapon config. Visual dimensions live alongside stats since each gun's
// view-model is built to match (rest/aim pose, sight + muzzle offsets derived from these).
import { ABILITY_COOLDOWNS } from "../../shared/abilityConstants.js";

export const WEAPON_DEFS = [
  {
    id: "pistol",
    name: "Pistol",
    fireMode: "semi",
    fireRate: 0.28,
    damage: 20,
    magSize: 12,
    reloadDuration: 1.0,
    hitscan: true,
    spread: 0.006,
    kickPos: 0.1,
    kickRot: 0.28,
    aimFov: 55,
    aimViewDistance: 0.48,
  },
  {
    // Scout's new primary — same gun (stats and model) the AK-47 used to be, just recast as a
    // nimble SMG and handed to Scout instead of Assault, which now gets its own new weapon
    // (see "battlerifle" below). `soundId` keeps it pointed at the existing fire_ak47.mp3
    // asset rather than needing a duplicated/renamed audio file for what's mechanically the
    // exact same gun.
    id: "smg",
    name: "SMG",
    fireMode: "auto",
    fireRate: 0.11,
    damage: 14,
    magSize: 30,
    reloadDuration: 1.8,
    hitscan: true,
    spread: 0.02,
    kickPos: 0.15,
    kickRot: 0.36,
    aimFov: 48,
    aimViewDistance: 0.72,
    soundId: "ak47",
  },
  {
    // Assault's new primary, replacing the AK-47 (now Scout's SMG above). Fires a fixed
    // 3-round burst per trigger pull instead of full-auto — `fireRate` here is reused for its
    // normal WeaponSlot meaning ("minimum time between two individual shots"), which doubles
    // as the pacing *within* one burst; `burstCount`/`burstCooldown` are burst-mode-only
    // fields combat.js's updateBurstFire() reads to know how many shots make up a burst and
    // how long to wait after one finishes before the next can start. No dedicated audio asset
    // yet, so it reuses the existing rifle gunshot via soundId.
    id: "battlerifle",
    name: "Battle Rifle",
    fireMode: "burst",
    burstCount: 3,
    burstCooldown: 0.55,
    fireRate: 0.08,
    damage: 26,
    magSize: 24,
    reloadDuration: 2.1,
    hitscan: true,
    spread: 0.01,
    kickPos: 0.2,
    kickRot: 0.42,
    aimFov: 50,
    aimViewDistance: 0.68,
    soundId: "ak47",
  },
  {
    id: "sniper",
    name: "Sniper",
    fireMode: "semi",
    fireRate: 1.3,
    damage: 100,
    magSize: 5,
    reloadDuration: 2.4,
    hitscan: true,
    spread: 0.0006,
    kickPos: 0.32,
    kickRot: 0.7,
    aimFov: 18,
    aimViewDistance: 0.95,
    scoped: true,
  },
  {
    id: "bazooka",
    name: "Bazooka",
    fireMode: "semi",
    fireRate: 1.8,
    damage: 0,
    magSize: 1,
    reloadDuration: 3.2,
    hitscan: false,
    splashRadius: 4.5,
    splashDamage: 150,
    projectileSpeed: 40,
    kickPos: 0.42,
    kickRot: 0.9,
    aimFov: 62,
    aimViewDistance: 0.55,
  },
  {
    id: "knife",
    name: "Knife",
    fireMode: "semi",
    fireRate: 0.5, // swing cooldown, not a reload-relevant rate
    damage: 400,
    magSize: Infinity, // no ammo — WeaponSlot's ammo>0/ammo>=magSize checks already degrade
    reloadDuration: 0, // correctly to "always ready, reload always no-ops" with no other changes
    hitscan: true, // still a raycast hit-test, just range-clamped (see combat.js's melee branch)
    melee: true,
    range: 3.2, // matches this project's other close-range constants (SHIELD_PLACE_DISTANCE, MINE_TRIGGER_RADIUS)
    spread: 0,
    kickPos: 0.05,
    kickRot: 0.2,
    aimFov: 65,
    aimViewDistance: 0.4,
  },
];

// One primary weapon per class, picking a class locks the player to that weapon *plus* a
// pistol sidearm — Loadout.setClass() sets up both, and the scroll wheel (main.js) switches
// between exactly those two, never the full weapon roster. `weaponId` must match a
// WEAPON_DEFS id. `ability.id` is the key main.js's useAbility() switches on; `cooldown`
// (seconds) is shared generically by the HUD indicator and the per-frame countdown regardless
// of which ability it is. `speedMult`/`staminaMult`/`healthMult` (all default to 1 when
// omitted — see Player.applyClassModifiers) let a class diverge from the otherwise-identical
// movement/stamina/health every class shared until Assassin needed to be faster/higher-
// stamina/squishier than the rest.
export const CLASSES = [
  {
    id: "scout",
    name: "Scout",
    weaponId: "smg",
    tagline: "Fast and light — a nimble SMG, plus a pistol sidearm.",
    ability: { id: "overclock", name: "Overclock", cooldown: ABILITY_COOLDOWNS.overclock },
  },
  {
    id: "assault",
    name: "Assault",
    weaponId: "battlerifle",
    tagline: "Precision 3-round bursts, plus a pistol sidearm — the reliable all-rounder.",
    ability: { id: "shield", name: "Shield Wall", cooldown: ABILITY_COOLDOWNS.shield },
  },
  {
    id: "recon",
    name: "Recon",
    weaponId: "sniper",
    tagline: "One shot, one kill, plus a pistol sidearm — scoped for long sightlines.",
    ability: { id: "pulse", name: "Recon Pulse", cooldown: ABILITY_COOLDOWNS.pulse },
  },
  {
    id: "demolition",
    name: "Demolition",
    weaponId: "bazooka",
    tagline: "Explosive splash damage, plus a pistol sidearm — clears rooms and cover alike.",
    ability: { id: "mine", name: "Proximity Mine", cooldown: ABILITY_COOLDOWNS.mine },
  },
  {
    id: "assassin",
    name: "Assassin",
    weaponId: "knife",
    tagline: "Fast, fragile, and hard to pin down — get in close, vanish, or fall back to the pistol.",
    ability: { id: "invisibility", name: "Invisibility", cooldown: ABILITY_COOLDOWNS.invisibility },
    speedMult: 1.265, // +10% on top of the previous 1.15
    staminaMult: 1.43, // +10% on top of the previous 1.3
    healthMult: 0.7,
  },
];

export const GRENADE_DEF = {
  count: 3,
  throwSpeed: 18,
  fuse: 3.6,
  splashRadius: 5,
  splashDamage: 90,
  cooldown: 1.0,
};
