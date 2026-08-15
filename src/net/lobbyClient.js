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
    this.onRelay = null;
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
      case "relay":
        if (this.onRelay) this.onRelay(msg.from, msg.payload);
        break;
    }
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  listRooms() {
    this._send({ type: "list_rooms" });
  }

  createRoom({ name, isPublic, password, playerName }) {
    this._send({ type: "create_room", name, isPublic, password, playerName });
  }

  joinRoom({ roomId, password, playerName }) {
    this._send({ type: "join_room", roomId, password, playerName });
  }

  leaveRoom() {
    this._send({ type: "leave_room" });
  }

  startMatch(config) {
    this._send({ type: "start_match", config });
  }

  // Broadcast to everyone else currently in the room (position ticks, kill-feed events).
  relayToRoom(payload) {
    this._send({ type: "relay_to_room", payload });
  }

  // Sent to exactly one other player in the room (hit/damage messages).
  relayToPlayer(targetId, payload) {
    this._send({ type: "relay_to_player", targetId, payload });
  }

  disconnect() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}
