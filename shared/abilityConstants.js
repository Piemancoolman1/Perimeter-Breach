// Ability/effect timing shared between the client (src/) and the plain-Node server (server/) —
// the server needs the exact same duration/cooldown numbers the client uses in order to validate
// a use_ability claim (see server/index.js's handleUseAbility), and duplicating them server-side
// with a "keep in sync" comment is exactly the kind of thing that silently drifts the next time
// someone tunes a balance number on only one side. Zero framework imports (no THREE, no DOM, no
// `ws`) so both Vite's bundler and plain Node's ESM loader can import this file directly via a
// relative path — no build step or extra package needed for a handful of numbers.

// Keyed by ability id (CLASSES[].ability.id in src/game/weaponDefs.js) — one entry per class,
// since each class has exactly one ability.
export const ABILITY_COOLDOWNS = {
  overclock: 30,
  shield: 14,
  pulse: 16,
  mine: 10,
  invisibility: 20,
};

// The abilities the server actually times — see abilities.js's own comment on why Recon Pulse
// never reaches the server at all. Overclock is included so the server can validate a shooter's
// fire-rate report_fire claim during an active Overclock window (see server/index.js's
// handleReportFire) even though nothing about Overclock is otherwise peer-visible.
export const ABILITY_DURATIONS = {
  shield: 12,
  invisibility: 6,
  mine: 200, // a safety-net despawn only — actual detonation stays client/owner-decided
  overclock: 2,
};

// Self-only, no peer-visible state — but see ABILITY_DURATIONS.overclock's own comment for why
// the server still tracks its timing.
export const OVERCLOCK_DURATION = 2;
export const RECON_PULSE_DURATION = 6;

// combat.js applies this to whatever weapon is currently equipped while the timer is running —
// not SMG-specific, since Scout can also be holding the pistol sidearm when Q is pressed. Lives
// here (not abilities.js, which re-exports it for backward-compatible imports) so the server's
// handleReportFire can import it without dragging in abilities.js's THREE/world.js dependencies.
export const OVERCLOCK_FIRE_RATE_MULT = 0.45; // ~2.2x fire rate (multiplies the per-shot cooldown down)

// Proximity Mine's damage — lives here (not abilities.js) so the server can import it without
// dragging in abilities.js's THREE/world.js dependencies (see server/index.js's report_hit
// splash-damage clamp).
export const MINE_DAMAGE = 300;

export const RESPAWN_DELAY = 3;
export const INVINCIBLE_DURATION = 3;

// Added on top of a stored cooldown-until when the server decides whether to trust a
// use_ability claim — real network transit time means a perfectly legitimate last-instant use
// could otherwise arrive a few ms "too early" by the server's clock and get wrongly rejected.
export const ABILITY_NETWORK_GRACE_MS = 400;
