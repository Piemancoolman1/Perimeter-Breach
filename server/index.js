import "./loadEnv.js";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolveUserId, bearerTokenFromHeader } from "./auth.js";
import { getStatsForUser, recordMatchResult } from "./stats.js";
import { isRateLimited } from "./rateLimit.js";
import {
  ABILITY_COOLDOWNS,
  ABILITY_DURATIONS,
  ABILITY_NETWORK_GRACE_MS,
  RESPAWN_DELAY,
  INVINCIBLE_DURATION,
  MINE_DAMAGE,
  OVERCLOCK_FIRE_RATE_MULT,
} from "../shared/abilityConstants.js";
import { WALK_SPEED, SPRINT_MULT, HEALTH_REGEN_DELAY, HEALTH_REGEN_RATE } from "../shared/movementConstants.js";
// Plain data, framework-free (weaponDefs.js's only import is shared/abilityConstants.js) — safe
// to import directly into plain Node rather than duplicating weapon/grenade/class numbers
// server-side (see report_fire/report_hit's own comments for why the server needs these).
import { WEAPON_DEFS, GRENADE_DEF, CLASSES } from "../src/game/weaponDefs.js";

const PORT = process.env.PORT || 8787;
const MAX_PLAYERS = 8;
// A generous, physically-honest ceiling on how many remote players a single splash source
// (grenade/bazooka/mine) can ever be credited with hitting — see report_grenade_throw/
// handleUseAbility's mine branch/handleReportFire for where this budget is granted, and
// handleReportHit for where it's spent. Never more than every other player in the room.
const MAX_SPLASH_TARGETS = MAX_PLAYERS - 1;
// A separate, much smaller network-transit grace than ABILITY_NETWORK_GRACE_MS (400ms) — that
// constant is sized for 10-30s ability cooldowns, where 400ms is negligible. Weapon fire-rate and
// grenade cooldowns run as low as ~80ms (Battle Rifle), so reusing the ability grace there would
// let a shooter fire meaningfully faster than the real cooldown allows — effectively un-doing the
// rate limit this whole plan exists to enforce. Small enough to absorb real jitter, nowhere near
// large enough to matter against an 80ms+ cooldown.
const FIRE_RATE_GRACE_MS = 50;
// Shield/Mine/Invisibility are peer-visible and need server-issued timing for that reason.
// Overclock is included too — not because a peer observes it directly, but because
// handleReportFire needs to know a shooter's actual Overclock window to legitimately allow their
// faster fire rate (see src/game/abilities.js's own comment on the same split). Recon Pulse
// never reaches the server at all — purely self-observed, nothing else needs to know about it.
const KNOWN_SERVER_ABILITIES = new Set(["shield", "mine", "invisibility", "overclock"]);
// Nothing is exchanged at all while players just sit in a room waiting for a match to start
// (no app traffic flows until "pos" ticks during an actual match) — long enough idle silence
// gets read as a dead connection and dropped by whatever's between the two peers, most notably
// the free Cloudflare Quick Tunnels this project's `npm run tunnel:server`/`tunnel:client`
// scripts use for testing across two machines (observed disconnecting an idle lobby after
// ~5 minutes). A plain WebSocket ping/pong keeps real bytes flowing on the wire regardless of
// app state, well under that — and needs no client-side code at all, since every WebSocket
// implementation (browsers, WebView2) answers a protocol-level ping with a pong automatically.
const PING_INTERVAL_MS = 25000;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1 — easy to read aloud

function randomRoomId() {
  let id = "";
  for (let i = 0; i < 6; i++) id += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return id;
}

// roomId -> Room. Purely in-memory — a lobby only needs to live as long as this process does.
const rooms = new Map();
// connection id -> { ws, roomId }
const conns = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws, message) {
  send(ws, { type: "error", message });
}

function publicRoomInfo(room) {
  return {
    id: room.id,
    name: room.name,
    isPublic: room.isPublic,
    playerCount: room.players.size,
    maxPlayers: room.maxPlayers,
  };
}

function playerList(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, isHost: p.id === room.hostId }));
}

function broadcast(room, msg, exceptId = null) {
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    const conn = conns.get(p.id);
    if (conn) send(conn.ws, msg);
  }
}

function joinedPayload(room, you) {
  return {
    type: "room_joined",
    room: { id: room.id, name: room.name, isPublic: room.isPublic },
    players: playerList(room),
    you: { id: you.id, name: you.name, isHost: you.id === room.hostId },
  };
}

function handleListRooms(ws) {
  send(ws, { type: "room_list", rooms: [...rooms.values()].map(publicRoomInfo) });
}

// Both handlers below are async now (resolving an optional session token is a DB lookup) — the
// `ws.on("message", ...)` dispatch just returns the promise unawaited, which is fine since
// resolveUserId() itself never throws (see auth.js) and everything either function needs to do in
// response (send/broadcast) happens from inside its own body, not via a return value.
async function handleCreateRoom(ws, connId, msg) {
  const name = String(msg.name || "").trim().slice(0, 40);
  const playerName = String(msg.playerName || "").trim().slice(0, 24);
  const isPublic = !!msg.isPublic;
  const password = isPublic ? null : String(msg.password || "");

  if (!name) return sendError(ws, "Room name is required.");
  if (!playerName) return sendError(ws, "Player name is required.");
  if (!isPublic && !password) return sendError(ws, "Private rooms need a password.");

  // No client sends this yet (that's Phase 3 of the accounts+stats plan) — every real caller
  // resolves to a guest (null) today, which is exactly the correct, harmless fallback once a
  // client actually starts sending one.
  const userId = await resolveUserId(msg.token);

  const id = randomRoomId();
  const room = {
    id,
    name,
    isPublic,
    password,
    hostId: connId,
    players: new Map(),
    maxPlayers: MAX_PLAYERS,
    matchConfig: null,
    // Match-scoped state, (re)initialized fresh by handleStartMatch on every match — see there.
    matchStats: null,
    matchStartedAt: null,
    matchEnded: false,
    matchTimer: null,
    abilityState: new Map(), // connId -> { cooldownUntil: { [abilityId]: epochMs } }
    combatState: new Map(), // connId -> CombatState (health/ammo/grenades — see handleSpawnReady)
    // Whoever creates the room sets its version — every join_room checks against this (see
    // handleJoinRoom), since two clients on different builds could disagree on match/network
    // payload shapes in ways this plain relay has no way to detect or referee otherwise.
    version: String(msg.version || "unknown"),
  };
  const you = { id: connId, name: playerName, userId };
  room.players.set(connId, you);
  rooms.set(id, room);
  conns.get(connId).roomId = id;

  send(ws, joinedPayload(room, you));
}

async function handleJoinRoom(ws, connId, msg) {
  const roomId = String(msg.roomId || "").toUpperCase();
  const room = rooms.get(roomId);
  const playerName = String(msg.playerName || "").trim().slice(0, 24);
  const version = String(msg.version || "unknown");

  if (!playerName) return sendError(ws, "Player name is required.");
  if (!room) return sendError(ws, "That room no longer exists.");
  if (room.players.size >= room.maxPlayers) return sendError(ws, "That room is full.");
  if (!room.isPublic && String(msg.password || "") !== room.password) {
    return sendError(ws, "Incorrect password.");
  }
  if (version !== room.version) {
    return sendError(ws, `Can't join — this room is on v${room.version}, you're on v${version}. Update to the same version and try again.`);
  }

  const userId = await resolveUserId(msg.token);

  // Re-checked after the await above (the only genuinely async step this handler has ever had) —
  // the room could have been deleted or filled up by someone else while this was in flight.
  if (!rooms.has(roomId) || room.players.size >= room.maxPlayers) {
    return sendError(ws, "That room is no longer available.");
  }

  const you = { id: connId, name: playerName, userId };
  room.players.set(connId, you);
  conns.get(connId).roomId = room.id;

  send(ws, joinedPayload(room, you));
  broadcast(room, { type: "player_joined", player: { id: you.id, name: you.name, isHost: false } }, connId);
}

// Game-specific message meaning otherwise lives entirely client-side — the server just wraps and
// forwards. Elimination is no longer decided from anything relayed here (see handleReportHit,
// which is what now calls recordElim directly the instant a server-tracked health value actually
// reaches 0) — a "pos" tick only gets a lightweight movement-speed sanity check.
function handleRelayToRoom(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room) return;
  broadcast(room, { type: "relay", from: connId, payload: msg.payload }, connId);

  if (msg.payload?.t === "pos") checkMovementSpeed(room, connId, msg.payload.x, msg.payload.z);
}

// Stamina has no peer-visible effect besides movement speed, and the server has never tracked
// position at all (pure relay) — this gives it real server-side teeth without turning the server
// into a full position authority. Deliberately log-only: actually rejecting/correcting a
// position would require the server to become the source of truth for position broadcasts too, a
// bigger change than the resource-ledger scope everything else here stays within. A generous
// TOLERANCE absorbs jitter/lag so a laggy-but-legitimate player is never flagged.
const SPEED_TOLERANCE = 1.4;
function checkMovementSpeed(room, connId, x, z) {
  const combat = room.combatState.get(connId);
  if (!combat || typeof x !== "number" || typeof z !== "number") return;
  const now = Date.now();
  const prev = combat.lastPos;
  combat.lastPos = { x, z, t: now };
  if (!prev) return;
  const dt = (now - prev.t) / 1000;
  if (dt <= 0 || dt > 1) return; // a real gap (rejoin, backgrounded tab, first tick) — not a meaningful sample
  const speed = Math.hypot(x - prev.x, z - prev.z) / dt;
  const cls = CLASSES.find((c) => c.id === combat.classId);
  const maxSpeed = WALK_SPEED * SPRINT_MULT * (cls?.speedMult ?? 1) * SPEED_TOLERANCE;
  if (speed > maxSpeed) {
    console.warn(`Room ${room.id}: suspiciously fast movement from ${connId} — ${speed.toFixed(1)} u/s (cap ~${maxSpeed.toFixed(1)})`);
  }
}

// The one place a lethal report_hit leads to (see handleReportHit below) — tallies kill/death,
// computes the respawn/invincibility window, and broadcasts everything both the respawn-timing
// UI and the scoreboard/ragdoll-trigger UI need. Runs entirely off the server's own detection of
// a tracked health value reaching 0 — no client "elim" self-report is trusted or needed at all
// anymore (closing the god-mode/fake-death-report gap this whole plan exists for).
function recordElim(room, { victimId, killerId, blast = null }) {
  if (!room.matchStats.has(victimId)) room.matchStats.set(victimId, { kills: 0, deaths: 0 });
  room.matchStats.get(victimId).deaths++;

  if (killerId && killerId !== victimId) {
    if (!room.matchStats.has(killerId)) room.matchStats.set(killerId, { kills: 0, deaths: 0 });
    room.matchStats.get(killerId).kills++;
  } else {
    // Suicide — either no killerId at all, or a self-targeted report_hit (own grenade/rocket/mine
    // blast, killerId === victimId) — costs the victim a kill rather than denying credit to
    // nobody, same "own goal" convention the client's own scoreboard already uses
    // (matchLifecycle.js's applyElim); kept consistent here since this tally is now what actually
    // decides kill-target completion.
    room.matchStats.get(victimId).kills--;
  }

  const respawnAt = Date.now() + RESPAWN_DELAY * 1000;
  const invincibleUntil = respawnAt + INVINCIBLE_DURATION * 1000;
  // One timestamp doubles as "can't be damaged while dead" (no hittable hitbox anyway) AND the
  // real post-respawn shield window — handleSpawnReady carries it forward rather than clearing
  // it, so it keeps protecting the player straight through their next spawn.
  const victimCombat = room.combatState.get(victimId);
  if (victimCombat) victimCombat.invincibleUntil = invincibleUntil;

  broadcast(room, {
    type: "respawn_scheduled",
    victimId,
    victimName: room.players.get(victimId)?.name || "",
    killerId: killerId || null,
    killerName: killerId ? room.players.get(killerId)?.name || "" : null,
    blast,
    respawnAt,
    invincibleUntil,
  });

  if (room.matchConfig?.mode !== "killTarget") return;
  for (const [playerId, s] of room.matchStats) {
    if (s.kills >= room.matchConfig.target) {
      finalizeMatch(room, playerId);
      return;
    }
  }
}

// The one place a match actually ends, for any reason (kill target reached, time limit elapsed)
// — idempotent (a kill-target completion and a same-instant time-limit firing can't both fire)
// and unconditionally clears the pending time-limit timer so it can never double-fire later.
function finalizeMatch(room, winnerId) {
  if (room.matchEnded) return;
  room.matchEnded = true;
  if (room.matchTimer) {
    clearTimeout(room.matchTimer);
    room.matchTimer = null;
  }

  broadcast(room, { type: "match_ended", winnerId });

  const participants = [...room.players.values()]
    .filter((p) => p.userId)
    .map((p) => {
      const s = room.matchStats.get(p.id) || { kills: 0, deaths: 0 };
      return { userId: p.userId, kills: s.kills, deaths: s.deaths, isWinner: p.id === winnerId };
    });
  recordMatchResult({
    mapId: room.matchConfig?.mapId ?? null,
    mode: room.matchConfig?.mode ?? "unknown",
    startedAt: new Date(room.matchStartedAt),
    participants,
  }).catch((err) => console.error(`Failed to record match result for room ${room.id}`, err));
}

// Shield Wall / Proximity Mine / Invisibility activation — unlike the plain relay above, this one
// is actually validated (live match, not already on cooldown) and the server itself computes the
// authoritative expiry (`until`) rather than trusting whatever a client claims, so a modified
// client can no longer just declare itself permanently invisible or keep a shield up forever (see
// the ability/respawn-timing plan for the full "why"). Overclock/Recon Pulse never reach here at
// all — see KNOWN_SERVER_ABILITIES's own comment.
function handleUseAbility(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room) return;
  if (!room.matchStats || room.matchEnded) return; // no live match — same guard recordElim uses

  const abilityId = String(msg.abilityId || "");
  if (!KNOWN_SERVER_ABILITIES.has(abilityId)) {
    console.warn(`Room ${room.id}: rejected use_ability — unknown abilityId "${abilityId}" from ${connId}`);
    return;
  }

  if (!room.abilityState.has(connId)) room.abilityState.set(connId, { cooldownUntil: {}, activeUntil: {} });
  const state = room.abilityState.get(connId);
  const now = Date.now();
  const cooldownUntil = state.cooldownUntil[abilityId] || 0;
  // A small network-transit grace period so a perfectly legitimate last-instant use (the client
  // already checked its own cooldown before sending this) doesn't get wrongly rejected just
  // because it arrived a few ms "too early" by the server's clock.
  if (now < cooldownUntil - ABILITY_NETWORK_GRACE_MS) {
    console.warn(`Room ${room.id}: rejected use_ability("${abilityId}") from ${connId} — ${cooldownUntil - now}ms still on cooldown`);
    return;
  }

  state.cooldownUntil[abilityId] = now + ABILITY_COOLDOWNS[abilityId] * 1000;
  const until = now + ABILITY_DURATIONS[abilityId] * 1000;
  // Retained (not just broadcast) so handleReportFire can later check "is this connId currently
  // inside an active Overclock window" — every other ability here just fires this once and
  // never needs to look it back up, but storing it uniformly is cheap and one less special case.
  state.activeUntil[abilityId] = until;

  if (abilityId === "mine") {
    // Grants a bounded splash-hit budget the instant a real mine is legitimately placed — spent
    // by handleReportHit below, same shape report_fire/report_grenade_throw use for
    // bazooka/grenade splash credit. Placement itself was already server-validated (cooldown,
    // above); this just closes the follow-on gap of a modified client claiming mine hits with no
    // mine ever placed.
    const combat = room.combatState.get(connId);
    if (combat) combat.mineHitCredit = MAX_SPLASH_TARGETS;
  }

  broadcast(room, {
    type: "ability_used",
    from: connId,
    abilityId,
    id: msg.id ?? null,
    x: typeof msg.x === "number" ? msg.x : null,
    z: typeof msg.z === "number" ? msg.z : null,
    rotY: typeof msg.rotY === "number" ? msg.rotY : null,
    until,
  }); // no exceptId — the actor also needs the authoritative timestamp, same as match_started
}

// Sent once per (re)spawn — including every mid-match class change — from spawnIntoMatch()
// (matchLifecycle.js). (Re)initializes this connId's whole combat ledger for whichever class was
// picked: full health at that class's actual max (healthMult-aware, unlike the RemotePlayer
// health bar's previous hardcoded-100 assumption), a fresh mag for their two allowed weapons, and
// a full grenade count. Broadcasts the new max health so every peer's health bar resets to full
// at the same moment, replacing the old implicit reset via a self-reported `pos.health` field.
function handleSpawnReady(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room || !room.matchStats || room.matchEnded) return;

  const cls = CLASSES.find((c) => c.id === msg.classId) || CLASSES[0];
  const maxHealth = 100 * (cls.healthMult ?? 1);
  const weapons = new Map();
  for (const weaponId of [cls.weaponId, "pistol"]) {
    const def = WEAPON_DEFS.find((w) => w.id === weaponId);
    if (!def) continue;
    weapons.set(weaponId, { ammo: def.magSize, reloadUntil: 0, fireCooldownUntil: 0, pendingHitCredit: false, pendingSplashCredit: 0 });
  }
  // Carries forward a still-active invincibility window (set by recordElim just before this
  // respawn) rather than wiping it — a fresh first-ever spawn has none set yet (undefined -> 0).
  const prevInvincibleUntil = room.combatState.get(connId)?.invincibleUntil || 0;

  room.combatState.set(connId, {
    classId: cls.id,
    health: maxHealth,
    maxHealth,
    weapons,
    grenadeCount: GRENADE_DEF.count,
    grenadeCooldownUntil: 0,
    grenadeHitCredit: 0,
    invincibleUntil: prevInvincibleUntil,
    lastDamageAt: 0, // 0 reads as "long enough ago" below — a fresh spawn has nothing to regen anyway
    lastPos: null,
  });

  broadcast(room, { type: "player_spawned", playerId: connId, maxHealth }); // no exceptId — matches ability_used
}

// Ammo/fire-rate authority (replaces trusting a bare relay_to_room{t:"fire"} for whether a shot
// was even allowed to happen). The shooter's own client still does its own local raycast/hit-test
// — only the ammo/cooldown *ledger* moves here. On success, grants exactly the hit-credit this
// shot claims (see handleReportHit) so a later report_hit can't be fabricated with no real shot
// behind it.
function handleReportFire(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room || !room.matchStats || room.matchEnded) return;
  const combat = room.combatState.get(connId);
  if (!combat) return;

  const weaponId = String(msg.weaponId || "");
  const def = WEAPON_DEFS.find((w) => w.id === weaponId);
  const weapon = combat.weapons.get(weaponId);
  if (!def || !weapon) {
    console.warn(`Room ${room.id}: rejected report_fire — unknown/disallowed weaponId "${weaponId}" from ${connId}`);
    return;
  }

  const now = Date.now();
  // Lazy reload refill — mirrors WeaponSlot.update()'s dt-ticked refill client-side, just
  // computed on read instead of ticked every frame (no server tick loop needed for this).
  if (weapon.reloadUntil && now >= weapon.reloadUntil) {
    weapon.ammo = def.magSize;
    weapon.reloadUntil = 0;
  }
  if (weapon.reloadUntil > now) {
    console.warn(`Room ${room.id}: rejected report_fire("${weaponId}") from ${connId} — still reloading`);
    return;
  }
  if (weapon.ammo <= 0) {
    console.warn(`Room ${room.id}: rejected report_fire("${weaponId}") from ${connId} — out of ammo`);
    return;
  }
  if (now < weapon.fireCooldownUntil - FIRE_RATE_GRACE_MS) {
    console.warn(`Room ${room.id}: rejected report_fire("${weaponId}") from ${connId} — still on cooldown`);
    return;
  }

  const abilityState = room.abilityState.get(connId);
  const overclocked = (abilityState?.activeUntil?.overclock || 0) > now;
  const fireRate = def.fireRate * (overclocked ? OVERCLOCK_FIRE_RATE_MULT : 1);

  weapon.ammo -= 1;
  weapon.fireCooldownUntil = now + fireRate * 1000;
  // Overwrites (never accumulates) any unused credit from an earlier shot — only the most recent
  // shot is ever creditable, so spamming report_fire without ever following up with a real hit
  // gains nothing.
  weapon.pendingHitCredit = def.hitscan && !!msg.hitPlayer;
  weapon.pendingSplashCredit = !def.hitscan ? MAX_SPLASH_TARGETS : 0;

  broadcast(room, {
    type: "fire_confirmed",
    from: connId,
    weaponId,
    hitPoint: msg.hitPoint ?? null,
    hitPlayer: !!msg.hitPlayer,
  }); // no exceptId — replaces the old client-decided "fire" relay entirely
}

// Reload has no peer-visible effect today, so this just updates the server's own ledger —
// nothing is broadcast.
function handleReportReload(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room || !room.matchStats || room.matchEnded) return;
  const combat = room.combatState.get(connId);
  if (!combat) return;

  const weaponId = String(msg.weaponId || "");
  const def = WEAPON_DEFS.find((w) => w.id === weaponId);
  const weapon = combat.weapons.get(weaponId);
  if (!def || !weapon) return;

  const now = Date.now();
  if (weapon.reloadUntil && now >= weapon.reloadUntil) {
    weapon.ammo = def.magSize;
    weapon.reloadUntil = 0;
  }
  if (weapon.reloadUntil > now || weapon.ammo >= def.magSize) return; // already reloading or already full
  weapon.reloadUntil = now + def.reloadDuration * 1000;
}

// Grenade-charge authority — mirrors handleReportFire's shape for a resource that isn't a
// WEAPON_DEFS entry. On success, grants a bounded splash-hit budget the same way a validated
// bazooka shot / mine placement does (see handleReportFire/handleUseAbility).
function handleReportGrenadeThrow(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room || !room.matchStats || room.matchEnded) return;
  const combat = room.combatState.get(connId);
  if (!combat) return;

  const now = Date.now();
  if (combat.grenadeCount <= 0) {
    console.warn(`Room ${room.id}: rejected report_grenade_throw from ${connId} — no grenades left`);
    return;
  }
  if (now < combat.grenadeCooldownUntil - FIRE_RATE_GRACE_MS) {
    console.warn(`Room ${room.id}: rejected report_grenade_throw from ${connId} — still on cooldown`);
    return;
  }

  combat.grenadeCount--;
  combat.grenadeCooldownUntil = now + GRENADE_DEF.cooldown * 1000;
  combat.grenadeHitCredit = MAX_SPLASH_TARGETS;
}

// Mirrors Player.regenHealth()'s per-frame client formula (src/game/player.js), computed lazily
// off elapsed wall-clock time instead of ticked every frame — same idiom the ability-timing
// system already uses. Called right before applying new damage so the server never subtracts
// from a stale, un-regenerated base while the client's own display has already ticked back up.
function regenedHealth(combat, now) {
  if (combat.health >= combat.maxHealth) return combat.maxHealth;
  const sinceDamage = (now - combat.lastDamageAt) / 1000;
  if (sinceDamage < HEALTH_REGEN_DELAY) return combat.health;
  return Math.min(combat.maxHealth, combat.health + (sinceDamage - HEALTH_REGEN_DELAY) * HEALTH_REGEN_RATE);
}

// Health/damage authority — replaces trusting a direct relay_to_player{t:"hit"} the victim's own
// client used to apply to itself. Damage is computed/bounded server-side by weaponId, never
// trusted raw from the client (see the hitscan/splash split below); a lethal hit leads straight
// into recordElim, so a victim's client can no longer simply ignore incoming damage (the old
// god-mode gap this exists to close).
function handleReportHit(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room || !room.matchStats || room.matchEnded) return;

  // targetId === connId is legitimate here (your own grenade/rocket/mine splash catching
  // yourself) — recordElim's suicide branch below treats a self-targeted kill the same "own
  // goal" way a killerless one is treated.
  const targetId = String(msg.targetId || "");
  if (!room.players.has(targetId)) return;
  const targetCombat = room.combatState.get(targetId);
  const shooterCombat = room.combatState.get(connId);
  if (!targetCombat || !shooterCombat) return;

  const now = Date.now();
  if ((targetCombat.invincibleUntil || 0) > now) return; // dead-and-waiting or still shielded post-respawn

  const weaponId = String(msg.weaponId || "");
  const def = WEAPON_DEFS.find((w) => w.id === weaponId);
  let amount;

  if (def?.hitscan) {
    // Exact, not a heuristic — hitscan has no falloff, so def.damage IS the real amount. The
    // client's own `damage` field is ignored entirely. Requires the hit-credit this exact
    // shooter's most recent validated report_fire for this weapon granted (see
    // handleReportFire) — consumed here, so at most one report_hit is ever creditable per real
    // rate/ammo-limited shot that claimed to land.
    const weapon = shooterCombat.weapons.get(weaponId);
    if (!weapon?.pendingHitCredit) {
      console.warn(`Room ${room.id}: rejected report_hit("${weaponId}") from ${connId} — no pending hit credit`);
      return;
    }
    weapon.pendingHitCredit = false;
    amount = def.damage;
  } else {
    // Splash falloff by distance stays client-computed/trusted (validating that exactly would
    // need the server to track full position/obstacle geometry — out of scope for the chosen
    // resource-ledger boundary) but is clamped to the weapon's real maximum, and gated behind the
    // same bounded per-source hit-credit budget bazooka/grenade/mine launches grant above.
    const maxSplash =
      weaponId === "bazooka" ? def?.splashDamage ?? 0 :
      weaponId === "grenade" ? GRENADE_DEF.splashDamage :
      weaponId === "mine" ? MINE_DAMAGE : 0;
    if (maxSplash <= 0) return;

    const bazookaWeapon = weaponId === "bazooka" ? shooterCombat.weapons.get("bazooka") : null;
    const hasCredit =
      weaponId === "bazooka" ? (bazookaWeapon?.pendingSplashCredit || 0) > 0 :
      weaponId === "grenade" ? shooterCombat.grenadeHitCredit > 0 :
      shooterCombat.mineHitCredit > 0;
    if (!hasCredit) {
      console.warn(`Room ${room.id}: rejected report_hit("${weaponId}") from ${connId} — no pending splash credit`);
      return;
    }
    if (weaponId === "bazooka") bazookaWeapon.pendingSplashCredit--;
    else if (weaponId === "grenade") shooterCombat.grenadeHitCredit--;
    else shooterCombat.mineHitCredit--;

    amount = Math.max(0, Math.min(Number(msg.damage) || 0, maxSplash));
  }
  if (amount <= 0) return;

  targetCombat.health = Math.max(0, regenedHealth(targetCombat, now) - amount);
  targetCombat.lastDamageAt = now;
  broadcast(room, {
    type: "damage_applied",
    targetId,
    fromId: connId,
    fromName: room.players.get(connId)?.name || "",
    weaponId,
    amount,
    newHealth: targetCombat.health,
    blast: msg.blast ?? null,
  });

  if (targetCombat.health <= 0) recordElim(room, { victimId: targetId, killerId: connId, blast: msg.blast ?? null });
}

function handleStartMatch(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room) return sendError(ws, "You're not in a room.");
  if (room.hostId !== connId) return sendError(ws, "Only the host can start the match.");

  room.matchConfig = msg.config || null;
  const startedAt = Date.now();

  // Fresh match-scoped state every time — a room can host several matches back-to-back without
  // ever being deleted (it only goes away once every player leaves), so this must reset, not just
  // initialize once. Clear any leftover timer defensively too, even though finalizeMatch always
  // clears its own — cheap insurance against ever double-scheduling one.
  if (room.matchTimer) clearTimeout(room.matchTimer);
  room.matchStats = new Map();
  room.matchStartedAt = startedAt;
  room.matchEnded = false;
  room.abilityState = new Map();
  room.combatState = new Map();
  room.matchTimer =
    room.matchConfig?.mode === "timeLimit"
      ? setTimeout(() => finalizeMatch(room, null), room.matchConfig.timeLimitSec * 1000)
      : null;

  broadcast(room, { type: "match_started", config: room.matchConfig, startedAt }); // no exceptId — host sees it too
}

// Shared by an explicit leave_room message and a dropped connection.
function removeFromRoom(connId) {
  const conn = conns.get(connId);
  if (!conn || !conn.roomId) return;
  const room = rooms.get(conn.roomId);
  conn.roomId = null;
  if (!room) return;

  room.players.delete(connId);

  if (room.players.size === 0) {
    if (room.matchTimer) clearTimeout(room.matchTimer);
    rooms.delete(room.id);
    return;
  }

  if (room.hostId === connId) {
    room.hostId = room.players.keys().next().value;
    broadcast(room, { type: "host_changed", id: room.hostId });
  }
  broadcast(room, { type: "player_left", id: connId });
}

// Same-origin, same-port CORS story for the small stats API below — permissive since this is a
// public game backend with no cookies/credentials involved (auth is a bearer token the client
// sends explicitly, never ambient), not a case where a specific-origin allowlist buys anything.
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// The lobby/relay's HTTP-side counterpart — currently just the one authenticated stats read.
// Shares this process/port with the WebSocket server below (one deployable, matching the
// accounts+stats plan) rather than running as a separate service.
async function handleHttpRequest(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // One top-level catch for the whole handler, not just around the DB call — node:http does not
  // catch a rejected promise from its request listener, so any unhandled error here (DB down, a
  // bug in a future route, ...) would otherwise crash this entire process, taking the live
  // WebSocket relay down with it for every currently-connected player. Confirmed this was a real,
  // not theoretical, risk: an earlier version of this handler had a gap (DATABASE_URL not loaded)
  // that did exactly this before this catch was added.
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/stats/me") {
      const ip = req.socket.remoteAddress || "unknown";
      if (isRateLimited(`stats:${ip}`, { max: 30, windowMs: 60_000 })) {
        return sendJson(res, 429, { error: "Too many requests." });
      }

      const userId = await resolveUserId(bearerTokenFromHeader(req.headers.authorization));
      if (!userId) return sendJson(res, 401, { error: "Not signed in." });

      const stats = await getStatsForUser(userId);
      return sendJson(res, 200, stats);
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (err) {
    console.error(`${req.method} ${req.url} failed`, err);
    sendJson(res, 500, { error: "Internal error." });
  }
}

const httpServer = createServer(handleHttpRequest);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const connId = randomUUID();
  conns.set(connId, { ws, roomId: null });

  // Standard `ws`-library heartbeat pattern: assume alive, flip to false right before each
  // ping, flip back on the browser's automatic pong reply. A connection that misses a full
  // cycle (network actually died, vs. just an idle tunnel) never got its flag reset in time,
  // so the next tick terminates it — same cleanup path as any other closed socket, since
  // terminate() still fires the "close" handler below.
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return sendError(ws, "Malformed message.");
    }

    switch (msg.type) {
      case "list_rooms":
        return handleListRooms(ws);
      case "create_room":
        return handleCreateRoom(ws, connId, msg);
      case "join_room":
        return handleJoinRoom(ws, connId, msg);
      case "leave_room":
        return removeFromRoom(connId);
      case "relay_to_room":
        return handleRelayToRoom(ws, connId, msg);
      case "start_match":
        return handleStartMatch(ws, connId, msg);
      case "use_ability":
        return handleUseAbility(ws, connId, msg);
      case "spawn_ready":
        return handleSpawnReady(ws, connId, msg);
      case "report_fire":
        return handleReportFire(ws, connId, msg);
      case "report_reload":
        return handleReportReload(ws, connId, msg);
      case "report_grenade_throw":
        return handleReportGrenadeThrow(ws, connId, msg);
      case "report_hit":
        return handleReportHit(ws, connId, msg);
      default:
        return sendError(ws, `Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    removeFromRoom(connId);
    conns.delete(connId);
  });
});

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS);
wss.on("close", () => clearInterval(pingInterval));

httpServer.listen(PORT, () => {
  console.log(`Lobby + stats server listening on http://localhost:${PORT} (ws:// for the relay, http:// for /stats/me)`);
});
