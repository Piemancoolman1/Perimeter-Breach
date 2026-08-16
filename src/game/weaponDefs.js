// Data-driven weapon config. Visual dimensions live alongside stats since each gun's
// view-model is built to match (rest/aim pose, sight + muzzle offsets derived from these).
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
    id: "ak47",
    name: "AK-47",
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
    fireRate: 0.6, // swing cooldown, not a reload-relevant rate
    damage: 90,
    magSize: Infinity, // no ammo — WeaponSlot's ammo>0/ammo>=magSize checks already degrade
    reloadDuration: 0, // correctly to "always ready, reload always no-ops" with no other changes
    hitscan: true, // still a raycast hit-test, just range-clamped (see combat.js's melee branch)
    melee: true,
    range: 2.2, // matches this project's other close-range constants (SHIELD_PLACE_DISTANCE, MINE_TRIGGER_RADIUS)
    spread: 0,
    kickPos: 0.05,
    kickRot: 0.2,
    aimFov: 65,
    aimViewDistance: 0.4,
  },
];

// One class per weapon — picking a class locks the player to that weapon for the rest of
// that life (see Loadout.setClass), rather than the old "every weapon always available,
// scroll to cycle" behavior. `weaponId` must match a WEAPON_DEFS id. `ability.id` is the key
// main.js's useAbility() switches on; `cooldown` (seconds) is shared generically by the HUD
// indicator and the per-frame countdown regardless of which ability it is. `speedMult`/
// `staminaMult`/`healthMult` (all default to 1 when omitted — see Player.applyClassModifiers)
// let a class diverge from the otherwise-identical movement/stamina/health every class shared
// until Assassin needed to be faster/higher-stamina/squishier than the rest.
export const CLASSES = [
  {
    id: "scout",
    name: "Scout",
    weaponId: "pistol",
    tagline: "Light and precise — a fast-handling sidearm as your only gun.",
    ability: { id: "dash", name: "Dash", cooldown: 4 },
  },
  {
    id: "assault",
    name: "Assault",
    weaponId: "ak47",
    tagline: "Full-auto rifle — the reliable all-rounder.",
    ability: { id: "shield", name: "Shield Wall", cooldown: 14 },
  },
  {
    id: "recon",
    name: "Recon",
    weaponId: "sniper",
    tagline: "One shot, one kill — scoped for long sightlines.",
    ability: { id: "pulse", name: "Recon Pulse", cooldown: 16 },
  },
  {
    id: "demolition",
    name: "Demolition",
    weaponId: "bazooka",
    tagline: "Explosive splash damage — clears rooms and cover alike.",
    ability: { id: "mine", name: "Proximity Mine", cooldown: 10 },
  },
  {
    id: "assassin",
    name: "Assassin",
    weaponId: "knife",
    tagline: "Fast, fragile, and hard to pin down — get in close and vanish.",
    ability: { id: "invisibility", name: "Invisibility", cooldown: 20 },
    speedMult: 1.15,
    staminaMult: 1.3,
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
