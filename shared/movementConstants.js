// Movement/health-regen numbers shared between the client (src/game/player.js) and the plain-Node
// server — the server's stamina speed sanity-check (server/index.js's handleRelayToRoom "pos"
// case) needs the same base speed the client actually moves at, and handleReportHit needs the
// same passive-regen formula the client ticks locally so a server-tracked player's health doesn't
// silently drift from what their own client already shows them, same "one source of truth"
// reasoning as shared/abilityConstants.js.
export const WALK_SPEED = 6.5;
export const SPRINT_MULT = 1.6;

// See player.js's Player.regenHealth() for the client-side per-frame version of this same
// formula — server/index.js computes it lazily (elapsed wall-clock time) instead of ticking it
// every frame, same idiom shared/abilityConstants.js's ability timers already use.
export const HEALTH_REGEN_DELAY = 15;
export const HEALTH_REGEN_RATE = 15;
