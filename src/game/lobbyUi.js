import { el } from "./dom.js";
import { LobbyClient } from "../net/lobbyClient.js";

const PLAYER_NAME_KEY = "perimeterBreach.playerName";

export function loadPlayerName() {
  try {
    return localStorage.getItem(PLAYER_NAME_KEY) || "";
  } catch {
    return "";
  }
}
export function savePlayerName(name) {
  try {
    localStorage.setItem(PLAYER_NAME_KEY, name);
  } catch {
    /* localStorage unavailable — name just won't persist across reloads */
  }
}

function setMpError(errorEl, message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}
function clearMpError(errorEl) {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

// Room creation/browsing/joining over a plain WebSocket to a small local lobby server (see
// server/index.js), plus the actual match-lifecycle hookup (a joined match hands off to
// `ctx.matchLifecycle` via the lobby client's own callbacks). `ctx.lobby`/`ctx.currentRoom`/
// `ctx.currentPlayers`/`ctx.myPlayerId`/`ctx.rooms`/`ctx.selectedRoomId` are reassigned here and
// read by other modules (matchLifecycle, combat, hud) — always through `ctx`, never a local
// binding, so every module sees the same up-to-date values.
export function createLobbyUi(ctx) {
  const mpScreens = [el.landing, el.multiplayerScreen, el.createRoomScreen, el.browseRoomsScreen, el.roomScreen];
  let activeErrorEl = el.mpConnectError;
  let creatingPublic = true;

  function showMpScreen(target) {
    for (const s of mpScreens) s.classList.toggle("hidden", s !== target);
  }

  function getPlayerNameOrError(errorEl) {
    const name = el.playerNameInput.value.trim();
    if (!name) {
      setMpError(errorEl, "Enter a name first.");
      return null;
    }
    savePlayerName(name);
    return name;
  }

  function amIHost() {
    return ctx.currentPlayers.find((p) => p.id === ctx.myPlayerId)?.isHost ?? false;
  }

  function disconnectLobby() {
    if (ctx.lobby) ctx.lobby.disconnect();
    ctx.lobby = null;
  }

  function renderRoomList() {
    el.roomList.innerHTML = "";
    if (ctx.rooms.length === 0) {
      const p = document.createElement("p");
      p.className = "room-list-empty";
      p.textContent = "No rooms yet — create one!";
      el.roomList.appendChild(p);
      return;
    }
    for (const room of ctx.rooms) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "room-row" + (room.id === ctx.selectedRoomId ? " selected" : "");

      const nameSpan = document.createElement("span");
      nameSpan.className = "room-row-name";
      nameSpan.appendChild(document.createTextNode(room.name));
      if (!room.isPublic) {
        const badge = document.createElement("span");
        badge.className = "room-lock-badge";
        badge.textContent = "PRIVATE";
        nameSpan.appendChild(badge);
      }

      const countSpan = document.createElement("span");
      countSpan.className = "room-row-count";
      countSpan.textContent = `${room.playerCount}/${room.maxPlayers}`;

      row.append(nameSpan, countSpan);
      row.addEventListener("click", () => selectRoom(room));
      el.roomList.appendChild(row);
    }
  }

  function attemptJoinRoom(roomId, password) {
    activeErrorEl = el.browseError;
    clearMpError(el.browseError);
    ctx.lobby.joinRoom({ roomId, password, playerName: loadPlayerName() });
  }

  function selectRoom(room) {
    clearMpError(el.browseError);
    if (room.isPublic) {
      ctx.selectedRoomId = null;
      el.roomPasswordRow.classList.add("hidden");
      el.roomPasswordJoinBtn.classList.add("hidden");
      attemptJoinRoom(room.id, "");
    } else {
      ctx.selectedRoomId = room.id;
      el.roomPasswordRoomName.textContent = room.name;
      el.roomPasswordInput.value = "";
      el.roomPasswordRow.classList.remove("hidden");
      el.roomPasswordJoinBtn.classList.remove("hidden");
      renderRoomList(); // refresh the "selected" highlight
    }
  }

  function renderRoomScreen() {
    el.roomScreenName.textContent = ctx.currentRoom ? ctx.currentRoom.name : "Room";
    el.roomPlayerList.innerHTML = "";
    for (const p of ctx.currentPlayers) {
      const li = document.createElement("li");
      li.className = "player-row";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name + (p.id === ctx.myPlayerId ? " (you)" : "");
      li.appendChild(nameSpan);
      if (p.isHost) {
        const badge = document.createElement("span");
        badge.className = "host-badge";
        badge.textContent = "HOST";
        li.appendChild(badge);
      }
      el.roomPlayerList.appendChild(li);
    }

    const iAmHost = amIHost();
    el.matchConfig.classList.toggle("hidden", !iAmHost);
    el.startMatchBtn.disabled = !iAmHost;
    el.startMatchBtn.textContent = iAmHost ? "Start Match" : "Waiting for host to start...";
  }

  function setupLobbyCallbacks(client) {
    client.onRoomList = (list) => {
      ctx.rooms = list;
      renderRoomList();
    };
    client.onJoined = (msg) => {
      ctx.currentRoom = msg.room;
      ctx.currentPlayers = msg.players;
      ctx.myPlayerId = msg.you.id;
      renderRoomScreen();
      showMpScreen(el.roomScreen);
    };
    client.onPlayerJoined = (player) => {
      ctx.currentPlayers.push(player);
      renderRoomScreen();
    };
    client.onPlayerLeft = (id) => {
      ctx.currentPlayers = ctx.currentPlayers.filter((p) => p.id !== id);
      renderRoomScreen();
      // If they'd disconnected from the room entirely mid-match (not just left the match
      // via the pause menu, which sends its own "left_match" relay), drop their avatar too.
      const rp = ctx.remotePlayers.get(id);
      if (rp) {
        rp.destroy(ctx.scene);
        ctx.remotePlayers.delete(id);
      }
    };
    client.onHostChanged = (id) => {
      ctx.currentPlayers = ctx.currentPlayers.map((p) => ({ ...p, isHost: p.id === id }));
      renderRoomScreen();
    };
    client.onError = (message) => setMpError(activeErrorEl, message);
    client.onDisconnected = () => {
      const wasMidFlow = [el.createRoomScreen, el.browseRoomsScreen, el.roomScreen].some(
        (s) => !s.classList.contains("hidden")
      );
      ctx.lobby = null;
      if (wasMidFlow || ctx.inMatch) {
        ctx.currentRoom = null;
        ctx.currentPlayers = [];
        if (ctx.inMatch) ctx.matchLifecycle.endMatchAbruptly();
        showMpScreen(el.multiplayerScreen);
        setMpError(el.mpConnectError, "Disconnected from the multiplayer server.");
      }
    };
    client.onMatchStarted = (config, startedAt) => ctx.matchLifecycle.beginMatch(config, startedAt);
    client.onRelay = (from, payload) => ctx.matchLifecycle.handleRelay(from, payload);
  }

  async function ensureLobbyConnected() {
    if (ctx.lobby && ctx.lobby.ws) return true;
    const client = new LobbyClient();
    setupLobbyCallbacks(client);
    try {
      await client.connect();
      ctx.lobby = client;
      return true;
    } catch {
      return false;
    }
  }

  el.multiplayerBtn.addEventListener("click", () => {
    el.playerNameInput.value = loadPlayerName();
    clearMpError(el.mpConnectError);
    showMpScreen(el.multiplayerScreen);
  });

  el.mpBackBtn.addEventListener("click", () => {
    disconnectLobby();
    showMpScreen(el.landing);
  });

  el.createRoomBtn.addEventListener("click", () => {
    activeErrorEl = el.mpConnectError;
    const name = getPlayerNameOrError(el.mpConnectError);
    if (!name) return;
    el.roomNameInput.value = "";
    creatingPublic = true;
    el.visibilityPublicBtn.classList.add("selected");
    el.visibilityPrivateBtn.classList.remove("selected");
    el.roomPasswordCreateRow.classList.add("hidden");
    el.roomPasswordCreateInput.value = "";
    clearMpError(el.createRoomError);
    showMpScreen(el.createRoomScreen);
  });

  el.visibilityPublicBtn.addEventListener("click", () => {
    creatingPublic = true;
    el.visibilityPublicBtn.classList.add("selected");
    el.visibilityPrivateBtn.classList.remove("selected");
    el.roomPasswordCreateRow.classList.add("hidden");
  });
  el.visibilityPrivateBtn.addEventListener("click", () => {
    creatingPublic = false;
    el.visibilityPrivateBtn.classList.add("selected");
    el.visibilityPublicBtn.classList.remove("selected");
    el.roomPasswordCreateRow.classList.remove("hidden");
  });

  el.createRoomBackBtn.addEventListener("click", () => showMpScreen(el.multiplayerScreen));

  el.createRoomSubmitBtn.addEventListener("click", async () => {
    const roomName = el.roomNameInput.value.trim();
    if (!roomName) return setMpError(el.createRoomError, "Room name is required.");
    if (!creatingPublic && !el.roomPasswordCreateInput.value) {
      return setMpError(el.createRoomError, "Private rooms need a password.");
    }
    clearMpError(el.createRoomError);
    activeErrorEl = el.createRoomError;

    const connected = await ensureLobbyConnected();
    if (!connected) return setMpError(el.createRoomError, "Could not connect to the multiplayer server.");

    ctx.lobby.createRoom({
      name: roomName,
      isPublic: creatingPublic,
      password: el.roomPasswordCreateInput.value,
      playerName: loadPlayerName(),
    });
  });

  el.browseRoomsBtn.addEventListener("click", async () => {
    activeErrorEl = el.mpConnectError;
    const name = getPlayerNameOrError(el.mpConnectError);
    if (!name) return;
    clearMpError(el.browseError);
    ctx.selectedRoomId = null;
    el.roomPasswordRow.classList.add("hidden");
    el.roomPasswordJoinBtn.classList.add("hidden");
    ctx.rooms = [];
    renderRoomList();
    showMpScreen(el.browseRoomsScreen);

    activeErrorEl = el.browseError;
    const connected = await ensureLobbyConnected();
    if (!connected) return setMpError(el.browseError, "Could not connect to the multiplayer server.");
    ctx.lobby.listRooms();
  });

  el.roomPasswordJoinBtn.addEventListener("click", () => {
    if (!ctx.selectedRoomId || !ctx.lobby) return;
    attemptJoinRoom(ctx.selectedRoomId, el.roomPasswordInput.value);
  });

  el.roomsRefreshBtn.addEventListener("click", () => {
    clearMpError(el.browseError);
    if (ctx.lobby && ctx.lobby.ws) ctx.lobby.listRooms();
  });

  el.browseBackBtn.addEventListener("click", () => showMpScreen(el.multiplayerScreen));

  el.leaveRoomBtn.addEventListener("click", () => {
    if (ctx.lobby) ctx.lobby.leaveRoom();
    disconnectLobby();
    ctx.currentRoom = null;
    ctx.currentPlayers = [];
    ctx.myPlayerId = null;
    showMpScreen(el.multiplayerScreen);
  });

  return { showMpScreen, renderRoomScreen, renderRoomList, amIHost, disconnectLobby, ensureLobbyConnected, setupLobbyCallbacks };
}
