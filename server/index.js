import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT || 8787;
const MAX_PLAYERS = 8;
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

function handleCreateRoom(ws, connId, msg) {
  const name = String(msg.name || "").trim().slice(0, 40);
  const playerName = String(msg.playerName || "").trim().slice(0, 24);
  const isPublic = !!msg.isPublic;
  const password = isPublic ? null : String(msg.password || "");

  if (!name) return sendError(ws, "Room name is required.");
  if (!playerName) return sendError(ws, "Player name is required.");
  if (!isPublic && !password) return sendError(ws, "Private rooms need a password.");

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
  };
  const you = { id: connId, name: playerName };
  room.players.set(connId, you);
  rooms.set(id, room);
  conns.get(connId).roomId = id;

  send(ws, joinedPayload(room, you));
}

function handleJoinRoom(ws, connId, msg) {
  const room = rooms.get(String(msg.roomId || "").toUpperCase());
  const playerName = String(msg.playerName || "").trim().slice(0, 24);

  if (!playerName) return sendError(ws, "Player name is required.");
  if (!room) return sendError(ws, "That room no longer exists.");
  if (room.players.size >= room.maxPlayers) return sendError(ws, "That room is full.");
  if (!room.isPublic && String(msg.password || "") !== room.password) {
    return sendError(ws, "Incorrect password.");
  }

  const you = { id: connId, name: playerName };
  room.players.set(connId, you);
  conns.get(connId).roomId = room.id;

  send(ws, joinedPayload(room, you));
  broadcast(room, { type: "player_joined", player: { id: you.id, name: you.name, isHost: false } }, connId);
}

// Game-specific message meaning lives entirely client-side — the server never inspects
// `payload`, it just wraps and forwards. That's what keeps this a plain relay instead of
// needing to understand match state (no AI, no shared physics to referee in PvP).
function handleRelayToRoom(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room) return;
  broadcast(room, { type: "relay", from: connId, payload: msg.payload }, connId);
}

function handleRelayToPlayer(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room) return;
  const targetId = String(msg.targetId || "");
  if (!room.players.has(targetId)) return; // silently drop — target isn't in this room
  const target = conns.get(targetId);
  if (target) send(target.ws, { type: "relay", from: connId, payload: msg.payload });
}

function handleStartMatch(ws, connId, msg) {
  const conn = conns.get(connId);
  const room = conn && conn.roomId ? rooms.get(conn.roomId) : null;
  if (!room) return sendError(ws, "You're not in a room.");
  if (room.hostId !== connId) return sendError(ws, "Only the host can start the match.");

  room.matchConfig = msg.config || null;
  const startedAt = Date.now();
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
    rooms.delete(room.id);
    return;
  }

  if (room.hostId === connId) {
    room.hostId = room.players.keys().next().value;
    broadcast(room, { type: "host_changed", id: room.hostId });
  }
  broadcast(room, { type: "player_left", id: connId });
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  const connId = randomUUID();
  conns.set(connId, { ws, roomId: null });

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
      case "relay_to_player":
        return handleRelayToPlayer(ws, connId, msg);
      case "start_match":
        return handleStartMatch(ws, connId, msg);
      default:
        return sendError(ws, `Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    removeFromRoom(connId);
    conns.delete(connId);
  });
});

console.log(`Lobby server listening on ws://localhost:${PORT}`);
