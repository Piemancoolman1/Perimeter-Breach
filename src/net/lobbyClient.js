import { APP_VERSION } from "../game/version.js";

const DEFAULT_URL = "ws://localhost:8787";

// Thin wrapper around the browser's native WebSocket — plain callback fields the caller
// assigns (onRoomList, onJoined, ...), matching the lightweight style already used by
// SoundBank in game/audio.js rather than pulling in an event-emitter library for this.
export class LobbyClient {
  constructor(url = import.meta.env.VITE_WS_URL || DEFAULT_URL) {
    this.url = url;
    this.ws = null;
    this.onRoomList = null;
    this.onJoined = null;
    this.onPlayerJoined = null;
    this.onPlayerLeft = null;
    this.onHostChanged = null;
    this.onError = null;
    this.onDisconnected = null;
    this.onMatchStarted = null;
    this.onMatchEnded = null;
    this.onRelay = null;
    this.onAbilityUsed = null;
    this.onRespawnScheduled = null;
    this.onPlayerSpawned = null;
    this.onFireConfirmed = null;
    this.onDamageApplied = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;

      ws.addEventListener("open", () => {
        settled = true;
        resolve();
      });
      ws.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Could not connect to the multiplayer server."));
        }
      });
      ws.addEventListener("close", () => {
        this.ws = null;
        if (this.onDisconnected) this.onDisconnected();
      });
      ws.addEventListener("message", (event) => this._handleMessage(event));
    });
  }

  _handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "room_list":
        if (this.onRoomList) this.onRoomList(msg.rooms);
        break;
      case "room_joined":
        if (this.onJoined) this.onJoined(msg);
        break;
      case "player_joined":
        if (this.onPlayerJoined) this.onPlayerJoined(msg.player);
        break;
      case "player_left":
        if (this.onPlayerLeft) this.onPlayerLeft(msg.id);
        break;
      case "host_changed":
        if (this.onHostChanged) this.onHostChanged(msg.id);
        break;
      case "error":
        if (this.onError) this.onError(msg.message);
        break;
      case "match_started":
        if (this.onMatchStarted) this.onMatchStarted(msg.config, msg.startedAt);
        break;
      case "match_ended":
        if (this.onMatchEnded) this.onMatchEnded(msg.winnerId);
        break;
      case "relay":
        if (this.onRelay) this.onRelay(msg.from, msg.payload);
        break;
      case "ability_used":
        if (this.onAbilityUsed) this.onAbilityUsed(msg.from, msg.abilityId, msg);
        break;
      case "respawn_scheduled":
        if (this.onRespawnScheduled) this.onRespawnScheduled(msg);
        break;
      case "player_spawned":
        if (this.onPlayerSpawned) this.onPlayerSpawned(msg.playerId, msg.maxHealth);
        break;
      case "fire_confirmed":
        if (this.onFireConfirmed) this.onFireConfirmed(msg.from, msg);
        break;
      case "damage_applied":
        if (this.onDamageApplied) this.onDamageApplied(msg);
        break;
    }
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  listRooms() {
    this._send({ type: "list_rooms" });
  }

  // `token` (an AccountClient session token, or undefined for a guest) lets the server resolve a
  // real account id for this player — see server/auth.js's resolveUserId(). Optional and
  // harmless to omit; a guest plays exactly as before, just untagged for stats.
  createRoom({ name, isPublic, password, playerName, token }) {
    // Whoever creates a room sets that room's version — every later join_room is checked
    // against it (see server/index.js), so two peers on different builds can't end up in the
    // same match with mismatched game logic/network payload shapes.
    this._send({ type: "create_room", name, isPublic, password, playerName, version: APP_VERSION, token });
  }

  joinRoom({ roomId, password, playerName, token }) {
    this._send({ type: "join_room", roomId, password, playerName, version: APP_VERSION, token });
  }

  leaveRoom() {
    this._send({ type: "leave_room" });
  }

  startMatch(config) {
    this._send({ type: "start_match", config });
  }

  // Broadcast to everyone else currently in the room (position ticks, left_match, mine_explode).
  relayToRoom(payload) {
    this._send({ type: "relay_to_room", payload });
  }

  // Shield Wall / Proximity Mine / Invisibility (and now Overclock, for its server-side fire-rate
  // window — see abilities.js) — unlike relayToRoom, this is validated and timed server-side (see
  // server/index.js's handleUseAbility); every recipient (including this client, via the
  // ability_used echo) treats the server's response as the authoritative activation.
  useAbility({ abilityId, id, x, z, rotY }) {
    this._send({ type: "use_ability", abilityId, id, x, z, rotY });
  }

  // (Re)registers this player's server-side combat ledger for a fresh spawn/respawn/class change
  // — see server/index.js's handleSpawnReady. Sent from matchLifecycle.js's spawnIntoMatch().
  spawnReady(classId) {
    this._send({ type: "spawn_ready", classId });
  }

  // Ammo/fire-rate authority — replaces the old bare relayToRoom({t:"fire"}) for a real weapon
  // shot (see server/index.js's handleReportFire). `hitPoint`/`hitPlayer` are still the shooter's
  // own local raycast result (hit *detection* stays client-side); the server only gates whether
  // this shot was allowed to happen at all.
  reportFire({ weaponId, hitPoint, hitPlayer }) {
    this._send({ type: "report_fire", weaponId, hitPoint, hitPlayer });
  }

  reportReload(weaponId) {
    this._send({ type: "report_reload", weaponId });
  }

  reportGrenadeThrow() {
    this._send({ type: "report_grenade_throw" });
  }

  // Health/damage authority — replaces the old relayToPlayer({t:"hit"}) the victim used to
  // trust and apply to itself (see server/index.js's handleReportHit). `damage` only matters for
  // a splash weapon (server clamps it to that weapon's real max); a hitscan weapon's exact damage
  // is computed server-side from `weaponId` alone and this field is ignored.
  reportHit({ targetId, weaponId, damage, blast }) {
    this._send({ type: "report_hit", targetId, weaponId, damage, blast });
  }

  disconnect() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}
