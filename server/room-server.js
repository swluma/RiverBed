const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const DOCS_ROOT = path.resolve(__dirname, "..", "docs");
const MAX_PLAYERS = 2;
const GAME_ID = "rogue-boggle";

const CLIENT_ROOM_EVENTS = Object.freeze({
  JOIN_ROOM: "join_room",
  LEAVE_ROOM: "leave_room",
  PLAYER_READY: "player_ready",
  START_GAME: "start_game",
  GAME_ACTION: "game_action",
  SYNC_REQUEST: "sync_request",
  HEARTBEAT: "heartbeat",
});

const SERVER_ROOM_EVENTS = Object.freeze({
  ROOM_JOINED: "room_joined",
  ROOM_STATE: "room_state",
  PLAYER_JOINED: "player_joined",
  PLAYER_LEFT: "player_left",
  PLAYER_READY: "player_ready",
  GAME_STARTED: "game_started",
  GAME_ACTION: "game_action",
  SYNC_STATE: "sync_state",
  ERROR: "error",
  ROOM_CLOSED: "room_closed",
});

const ROOM_PHASES = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  PLAYING: "playing",
  ENDED: "ended",
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

const rooms = new Map();
const sockets = new Map();

function now(){
  return Date.now();
}

function send(ws, type, payload){
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, payload }));
}

function broadcast(room, type, payload, exceptPlayerId = null){
  for (const player of room.players.values()){
    if (exceptPlayerId && player.id === exceptPlayerId) continue;
    send(player.ws, type, payload);
  }
}

function roomSnapshot(room){
  return {
    roomCode: room.roomCode,
    gameId: room.gameId,
    hostId: room.hostId,
    phase: room.phase,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    startedAt: room.startedAt,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      ready: !!player.ready,
      isHost: player.id === room.hostId,
      connected: player.connected !== false,
      lastSeenAt: player.lastSeenAt,
      joinedAt: player.joinedAt,
    })),
  };
}

function syncRoomPhase(room){
  if (room.phase === ROOM_PHASES.PLAYING) return;
  const players = Array.from(room.players.values()).filter((player) => player.connected !== false);
  if (players.length < MAX_PLAYERS){
    room.phase = ROOM_PHASES.WAITING;
  } else if (players.every((player) => player.ready)){
    room.phase = ROOM_PHASES.READY;
  } else {
    room.phase = ROOM_PHASES.WAITING;
  }
  room.updatedAt = now();
}

function emitRoomState(room){
  const snapshot = roomSnapshot(room);
  broadcast(room, SERVER_ROOM_EVENTS.ROOM_STATE, { room: snapshot });
}

function sendError(ws, code, message, recoverable = true){
  send(ws, SERVER_ROOM_EVENTS.ERROR, { code, message, recoverable });
}

function findDisconnectedPlayerByName(room, playerName, { host }){
  const normalizedName = String(playerName || "").trim().toLowerCase();
  if (!normalizedName) return null;
  for (const player of room.players.values()){
    const roleMatches = host ? player.id === room.hostId : player.id !== room.hostId;
    if (!roleMatches || player.connected !== false) continue;
    if (String(player.name || "").trim().toLowerCase() === normalizedName){
      return player;
    }
  }
  return null;
}

function rekeyRoomPlayer(room, player, nextPlayerId){
  if (!player || player.id === nextPlayerId) return player;
  room.players.delete(player.id);
  if (room.hostId === player.id){
    room.hostId = nextPlayerId;
  }
  player.id = nextPlayerId;
  room.players.set(nextPlayerId, player);
  return player;
}

function closeRoom(room, message){
  const players = Array.from(room.players.values());
  rooms.delete(room.roomCode);
  for (const player of players){
    if (player.ws && player.ws !== room.hostSocket){
      send(player.ws, SERVER_ROOM_EVENTS.ROOM_CLOSED, {
        roomCode: room.roomCode,
        message,
      });
    }
  }
}

function attachPlayerSocket(ws, room, player){
  sockets.set(ws, { roomCode: room.roomCode, playerId: player.id });
  player.ws = ws;
  player.connected = true;
  if (player.id === room.hostId){
    room.hostSocket = ws;
  }
}

function detachSocket(ws){
  const session = sockets.get(ws);
  sockets.delete(ws);
  if (!session) return;

  const room = rooms.get(session.roomCode);
  if (!room) return;
  const leavingPlayer = room.players.get(session.playerId);
  if (!leavingPlayer) return;

  leavingPlayer.connected = false;
  leavingPlayer.ws = null;
  leavingPlayer.lastSeenAt = now();
  if (room.hostId !== session.playerId){
    leavingPlayer.ready = false;
  }

  room.updatedAt = now();
  syncRoomPhase(room);
  broadcast(room, SERVER_ROOM_EVENTS.PLAYER_LEFT, {
    roomCode: room.roomCode,
    playerId: session.playerId,
    playerName: leavingPlayer.name,
    isHost: room.hostId === session.playerId,
  });
  emitRoomState(room);
}

function handleJoinRoom(ws, payload){
  const roomCode = String(payload?.roomCode || "").trim().toUpperCase();
  const mode = String(payload?.mode || "");
  const playerId = String(payload?.player?.id || "").trim();
  const playerName = String(payload?.player?.name || "").trim();
  const gameId = String(payload?.gameId || "");

  if (!roomCode){
    sendError(ws, "ROOM_REQUIRED", "Room code is required.");
    return;
  }
  if (!playerId || !playerName){
    sendError(ws, "PLAYER_REQUIRED", "Player id and player name are required.");
    return;
  }
  if (gameId !== GAME_ID){
    sendError(ws, "WRONG_GAME", "This room server only accepts Rogue Boggle clients.", false);
    return;
  }

  let room = rooms.get(roomCode);
  if (mode === "host"){
    if (room && room.hostId !== playerId){
      const returningHost = findDisconnectedPlayerByName(room, playerName, { host: true });
      if (!returningHost){
        sendError(ws, "ROOM_EXISTS", "This room code is already in use.");
        return;
      }
      rekeyRoomPlayer(room, returningHost, playerId);
    }
    if (!room){
      room = {
        roomCode,
        gameId,
        hostId: playerId,
        hostSocket: ws,
        phase: ROOM_PHASES.WAITING,
        createdAt: now(),
        updatedAt: now(),
        startedAt: null,
        players: new Map(),
        lastAction: null,
        lastSnapshotAction: null,
      };
      rooms.set(roomCode, room);
    }
  } else {
    if (!room){
      sendError(ws, "ROOM_NOT_FOUND", "The requested room does not exist.");
      return;
    }
    if (room.gameId !== gameId){
      sendError(ws, "WRONG_GAME", "This room is registered for a different game.", false);
      return;
    }
    const returningGuest = room.players.has(playerId)
      ? null
      : findDisconnectedPlayerByName(room, playerName, { host: false });
    if (returningGuest){
      rekeyRoomPlayer(room, returningGuest, playerId);
    }
    const connectedCount = Array.from(room.players.values()).filter((player) => player.connected !== false).length;
    if (!room.players.has(playerId) && connectedCount >= MAX_PLAYERS){
      sendError(ws, "ROOM_FULL", "This room is already full.");
      return;
    }
  }

  const existing = room.players.get(playerId);
  const player = existing || {
    id: playerId,
    name: playerName,
    ready: mode === "host",
    joinedAt: now(),
    lastSeenAt: now(),
    connected: true,
    ws,
  };
  player.name = playerName;
  player.lastSeenAt = now();
  if (!existing){
    player.ready = mode === "host";
  } else if (mode !== "host"){
    player.ready = false;
  }
  player.connected = true;
  room.players.set(playerId, player);
  attachPlayerSocket(ws, room, player);
  syncRoomPhase(room);

  send(ws, SERVER_ROOM_EVENTS.ROOM_JOINED, {
    roomCode,
    playerId,
    room: roomSnapshot(room),
  });

  broadcast(room, SERVER_ROOM_EVENTS.PLAYER_JOINED, {
    roomCode,
    player: {
      id: player.id,
      name: player.name,
      ready: player.ready,
      isHost: player.id === room.hostId,
    },
  }, playerId);

  emitRoomState(room);
}

function handleLeaveRoom(ws, payload){
  const roomCode = String(payload?.roomCode || "");
  const playerId = String(payload?.playerId || "");
  const room = rooms.get(roomCode);
  if (!room) return;
  if (!room.players.has(playerId)) return;

  const leavingPlayer = room.players.get(playerId);
  leavingPlayer.connected = false;
  leavingPlayer.ws = null;
  leavingPlayer.lastSeenAt = now();
  if (room.hostId !== playerId){
    leavingPlayer.ready = false;
  }
  sockets.delete(ws);

  syncRoomPhase(room);
  broadcast(room, SERVER_ROOM_EVENTS.PLAYER_LEFT, {
    roomCode,
    playerId,
    playerName: leavingPlayer.name,
    isHost: room.hostId === playerId,
  });
  emitRoomState(room);
}

function handlePlayerReady(ws, payload){
  const roomCode = String(payload?.roomCode || "");
  const playerId = String(payload?.playerId || "");
  const room = rooms.get(roomCode);
  const player = room?.players?.get(playerId);
  if (!room || !player){
    sendError(ws, "ROOM_NOT_FOUND", "Room or player not found.");
    return;
  }

  player.ready = !!payload?.ready;
  player.lastSeenAt = now();
  syncRoomPhase(room);

  broadcast(room, SERVER_ROOM_EVENTS.PLAYER_READY, {
    roomCode,
    playerId,
    ready: player.ready,
    playerName: player.name,
  });
  emitRoomState(room);
}

function handleStartGame(ws, payload){
  const roomCode = String(payload?.roomCode || "");
  const playerId = String(payload?.playerId || "");
  const room = rooms.get(roomCode);
  if (!room){
    sendError(ws, "ROOM_NOT_FOUND", "Cannot start a room that does not exist.");
    return;
  }
  if (room.hostId !== playerId){
    sendError(ws, "NOT_HOST", "Only the host can start the match.");
    return;
  }
  const connectedPlayers = Array.from(room.players.values()).filter((player) => player.connected !== false);
  if (connectedPlayers.length !== MAX_PLAYERS){
    sendError(ws, "PLAYER_COUNT", "Two players are required before starting.");
    return;
  }
  if (!connectedPlayers.every((player) => player.ready)){
    sendError(ws, "NOT_READY", "All players must be ready before starting.");
    return;
  }

  room.phase = ROOM_PHASES.PLAYING;
  room.startedAt = now();
  room.updatedAt = room.startedAt;
  const startedPayload = {
    roomCode,
    startedAt: room.startedAt,
    startedBy: playerId,
    phase: room.phase,
    mock: false,
  };
  broadcast(room, SERVER_ROOM_EVENTS.GAME_STARTED, startedPayload);
  emitRoomState(room);
}

function handleSyncRequest(ws, payload){
  const roomCode = String(payload?.roomCode || "");
  const room = rooms.get(roomCode);
  if (!room){
    sendError(ws, "ROOM_NOT_FOUND", "Cannot sync a room that does not exist.");
    return;
  }
  send(ws, SERVER_ROOM_EVENTS.SYNC_STATE, {
    roomCode,
    room: roomSnapshot(room),
    lastAction: room.lastSnapshotAction || room.lastAction,
  });
}

function handleHeartbeat(ws, payload){
  const roomCode = String(payload?.roomCode || "");
  const playerId = String(payload?.playerId || "");
  const room = rooms.get(roomCode);
  const player = room?.players?.get(playerId);
  if (!room || !player) return;
  player.lastSeenAt = now();
  room.updatedAt = now();
}

function handleGameAction(ws, payload){
  const roomCode = String(payload?.roomCode || "");
  const room = rooms.get(roomCode);
  if (!room){
    sendError(ws, "ROOM_NOT_FOUND", "Cannot send actions to a room that does not exist.");
    return;
  }

  room.lastAction = payload?.action || null;
  if (room.lastAction?.type === "sync_snapshot"){
    room.lastSnapshotAction = room.lastAction;
  }
  room.updatedAt = now();
  broadcast(room, SERVER_ROOM_EVENTS.GAME_ACTION, {
    roomCode,
    action: payload?.action || null,
    fromPlayerId: payload?.fromPlayerId || null,
  }, payload?.fromPlayerId || null);
}

function handleClientMessage(ws, message){
  if (!message || typeof message.type !== "string"){
    sendError(ws, "BAD_MESSAGE", "Invalid message.");
    return;
  }

  const payload = message.payload || {};
  if (message.type === CLIENT_ROOM_EVENTS.JOIN_ROOM) return handleJoinRoom(ws, payload);
  if (message.type === CLIENT_ROOM_EVENTS.LEAVE_ROOM) return handleLeaveRoom(ws, payload);
  if (message.type === CLIENT_ROOM_EVENTS.PLAYER_READY) return handlePlayerReady(ws, payload);
  if (message.type === CLIENT_ROOM_EVENTS.START_GAME) return handleStartGame(ws, payload);
  if (message.type === CLIENT_ROOM_EVENTS.SYNC_REQUEST) return handleSyncRequest(ws, payload);
  if (message.type === CLIENT_ROOM_EVENTS.HEARTBEAT) return handleHeartbeat(ws, payload);
  if (message.type === CLIENT_ROOM_EVENTS.GAME_ACTION) return handleGameAction(ws, payload);
  sendError(ws, "UNSUPPORTED_EVENT", `Unsupported event: ${message.type}`);
}

function serveFile(req, res){
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requestPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const safePath = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(DOCS_ROOT, safePath);
  if (!filePath.startsWith(DOCS_ROOT)){
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error){
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  serveFile(req, res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let message = null;
    try{
      message = JSON.parse(String(raw));
    } catch {
      sendError(ws, "BAD_JSON", "Message must be valid JSON.");
      return;
    }
    handleClientMessage(ws, message);
  });

  ws.on("close", () => {
    detachSocket(ws);
  });

  ws.on("error", () => {
    detachSocket(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[rogue-boggle] room server listening on http://${HOST}:${PORT}`);
  console.log(`[rogue-boggle] websocket endpoint ws://${HOST}:${PORT}/ws`);
});
