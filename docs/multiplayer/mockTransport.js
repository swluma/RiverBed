import { CLIENT_ROOM_EVENTS, ROOM_PHASES, SERVER_ROOM_EVENTS } from "./protocol.js";

const CHANNEL_NAME = "rogue-boggle-room-mock";
const STORAGE_KEY = "rogue-boggle:mock-rooms:v1";

function now(){
  return Date.now();
}

function clone(value){
  return JSON.parse(JSON.stringify(value));
}

function readRooms(){
  try{
    const raw = globalThis.localStorage?.getItem?.(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRooms(rooms){
  try{
    globalThis.localStorage?.setItem?.(STORAGE_KEY, JSON.stringify(rooms));
  } catch {}
}

function upsertPlayer(room, player){
  const players = Array.isArray(room.players) ? room.players.slice() : [];
  const index = players.findIndex((entry) => entry.id === player.id);
  if (index >= 0){
    players[index] = { ...players[index], ...player, lastSeenAt: now() };
  } else {
    players.push({ ...player, lastSeenAt: now(), joinedAt: now() });
  }
  room.players = players;
}

function createEmitter(){
  const listeners = new Map();
  return {
    emit(type, payload){
      const handlers = listeners.get(type);
      if (!handlers) return;
      for (const handler of handlers){
        handler(payload);
      }
    },
    on(type, handler){
      const handlers = listeners.get(type) || new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    off(type, handler){
      const handlers = listeners.get(type);
      if (!handlers) return;
      handlers.delete(handler);
      if (handlers.size === 0){
        listeners.delete(type);
      }
    },
  };
}

export function createMockRoomTransport({ clientId, gameId, maxPlayers }){
  const emitter = createEmitter();
  let channel = null;
  let connected = false;

  function emitToClient(type, payload){
    emitter.emit("message", { type, payload });
  }

  function broadcastEnvelope(envelope){
    if (channel){
      channel.postMessage(envelope);
    }
    if (!envelope.targetClientId || envelope.targetClientId === clientId){
      emitToClient(envelope.type, envelope.payload);
    }
  }

  function broadcastRoomState(room){
    for (const player of room.players || []){
      broadcastEnvelope({
        type: SERVER_ROOM_EVENTS.ROOM_STATE,
        targetClientId: player.id,
        payload: { room: clone(room) },
      });
    }
  }

  function emitError(code, message, recoverable = true){
    emitToClient(SERVER_ROOM_EVENTS.ERROR, { code, message, recoverable });
  }

  function handleJoinRoom(payload){
    const roomCode = String(payload?.roomCode || "");
    const rooms = readRooms();
    let room = rooms[roomCode];
    const joiningPlayer = {
      id: payload?.player?.id,
      name: payload?.player?.name || "Player",
      ready: false,
      isHost: payload?.mode === "host",
    };

    if (payload?.gameId !== gameId){
      emitError("WRONG_GAME", "This room was created for a different game.", false);
      return;
    }

    if (payload?.mode === "host"){
      if (room && room.hostId !== joiningPlayer.id){
        emitError("ROOM_EXISTS", "This room code is already in use.", true);
        return;
      }
      if (!room){
        room = {
          roomCode,
          gameId,
          hostId: joiningPlayer.id,
          phase: ROOM_PHASES.WAITING,
          createdAt: now(),
          updatedAt: now(),
          startedAt: null,
          players: [],
        };
      }
      upsertPlayer(room, joiningPlayer);
    } else {
      if (!room){
        emitError("ROOM_NOT_FOUND", "The requested room does not exist.", true);
        return;
      }
      if (room.gameId !== gameId){
        emitError("WRONG_GAME", "This room is for another game type.", false);
        return;
      }
      const existing = room.players.find((player) => player.id === joiningPlayer.id);
      if (!existing && room.players.length >= maxPlayers){
        emitError("ROOM_FULL", "This room is already full.", true);
        return;
      }
      upsertPlayer(room, joiningPlayer);
    }

    room.updatedAt = now();
    room.phase = room.players.length >= maxPlayers ? ROOM_PHASES.READY : ROOM_PHASES.WAITING;
    rooms[roomCode] = room;
    writeRooms(rooms);

    broadcastEnvelope({
      type: SERVER_ROOM_EVENTS.ROOM_JOINED,
      targetClientId: joiningPlayer.id,
      payload: { room: clone(room), playerId: joiningPlayer.id, roomCode },
    });

    for (const player of room.players){
      if (player.id === joiningPlayer.id) continue;
      broadcastEnvelope({
        type: SERVER_ROOM_EVENTS.PLAYER_JOINED,
        targetClientId: player.id,
        payload: { roomCode, player: clone(joiningPlayer) },
      });
    }

    broadcastRoomState(room);
  }

  function handleLeaveRoom(payload){
    const roomCode = String(payload?.roomCode || "");
    const rooms = readRooms();
    const room = rooms[roomCode];
    if (!room) return;
    room.players = (room.players || []).filter((player) => player.id !== payload?.playerId);
    if (room.hostId === payload?.playerId){
      delete rooms[roomCode];
      writeRooms(rooms);
      for (const player of room.players){
        broadcastEnvelope({
          type: SERVER_ROOM_EVENTS.ROOM_CLOSED,
          targetClientId: player.id,
          payload: { roomCode, message: "The host left and the room was closed." },
        });
      }
      return;
    }
    room.updatedAt = now();
    room.phase = room.players.length >= maxPlayers ? ROOM_PHASES.READY : ROOM_PHASES.WAITING;
    rooms[roomCode] = room;
    writeRooms(rooms);
    for (const player of room.players){
      broadcastEnvelope({
        type: SERVER_ROOM_EVENTS.PLAYER_LEFT,
        targetClientId: player.id,
        payload: { roomCode, playerId: payload?.playerId },
      });
    }
    broadcastRoomState(room);
  }

  function handlePlayerReady(payload){
    const roomCode = String(payload?.roomCode || "");
    const rooms = readRooms();
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find((entry) => entry.id === payload?.playerId);
    if (!player) return;
    player.ready = !!payload?.ready;
    player.lastSeenAt = now();
    room.updatedAt = now();
    room.phase = room.players.length >= maxPlayers
      ? (room.players.every((entry) => !!entry.ready) ? ROOM_PHASES.READY : ROOM_PHASES.WAITING)
      : ROOM_PHASES.WAITING;
    rooms[roomCode] = room;
    writeRooms(rooms);
    for (const entry of room.players){
      broadcastEnvelope({
        type: SERVER_ROOM_EVENTS.PLAYER_READY,
        targetClientId: entry.id,
        payload: { roomCode, playerId: player.id, ready: player.ready, playerName: player.name },
      });
    }
    broadcastRoomState(room);
  }

  function handleStartGame(payload){
    const roomCode = String(payload?.roomCode || "");
    const rooms = readRooms();
    const room = rooms[roomCode];
    if (!room){
      emitError("ROOM_NOT_FOUND", "Cannot start a room that does not exist.", true);
      return;
    }
    if (room.hostId !== payload?.playerId){
      emitError("NOT_HOST", "Only the host can start the match.", true);
      return;
    }
    if ((room.players || []).length !== maxPlayers){
      emitError("PLAYER_COUNT", "Need two players before starting.", true);
      return;
    }
    if (!room.players.every((player) => !!player.ready)){
      emitError("NOT_READY", "All players must be ready before starting.", true);
      return;
    }
    room.phase = ROOM_PHASES.PLAYING;
    room.startedAt = now();
    room.updatedAt = room.startedAt;
    rooms[roomCode] = room;
    writeRooms(rooms);
    for (const player of room.players){
      broadcastEnvelope({
        type: SERVER_ROOM_EVENTS.GAME_STARTED,
        targetClientId: player.id,
        payload: {
          roomCode,
          startedAt: room.startedAt,
          startedBy: payload?.playerId,
          phase: room.phase,
          mock: true,
        },
      });
    }
    broadcastRoomState(room);
  }

  function handleSyncRequest(payload){
    const roomCode = String(payload?.roomCode || "");
    const room = readRooms()[roomCode];
    if (!room) return;
    broadcastEnvelope({
      type: SERVER_ROOM_EVENTS.SYNC_STATE,
      targetClientId: payload?.playerId,
      payload: { room: clone(room), roomCode, lastAction: null },
    });
  }

  function handleHeartbeat(payload){
    const roomCode = String(payload?.roomCode || "");
    const rooms = readRooms();
    const room = rooms[roomCode];
    const player = room?.players?.find?.((entry) => entry.id === payload?.playerId);
    if (!room || !player) return;
    player.lastSeenAt = now();
    room.updatedAt = now();
    rooms[roomCode] = room;
    writeRooms(rooms);
  }

  function handleGameAction(payload){
    const roomCode = String(payload?.roomCode || "");
    const room = readRooms()[roomCode];
    if (!room) return;
    for (const player of room.players){
      if (player.id === payload?.fromPlayerId) continue;
      broadcastEnvelope({
        type: SERVER_ROOM_EVENTS.GAME_ACTION,
        targetClientId: player.id,
        payload: { roomCode, action: clone(payload.action), fromPlayerId: payload?.fromPlayerId },
      });
    }
  }

  function routeClientEvent(type, payload){
    if (type === CLIENT_ROOM_EVENTS.JOIN_ROOM) return handleJoinRoom(payload);
    if (type === CLIENT_ROOM_EVENTS.LEAVE_ROOM) return handleLeaveRoom(payload);
    if (type === CLIENT_ROOM_EVENTS.PLAYER_READY) return handlePlayerReady(payload);
    if (type === CLIENT_ROOM_EVENTS.START_GAME) return handleStartGame(payload);
    if (type === CLIENT_ROOM_EVENTS.SYNC_REQUEST) return handleSyncRequest(payload);
    if (type === CLIENT_ROOM_EVENTS.HEARTBEAT) return handleHeartbeat(payload);
    if (type === CLIENT_ROOM_EVENTS.GAME_ACTION) return handleGameAction(payload);
  }

  return {
    name: "mock-broadcast",
    connect(){
      if (connected) return;
      connected = true;
      if ("BroadcastChannel" in globalThis){
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.addEventListener("message", (event) => {
          const envelope = event.data;
          if (!envelope || (envelope.targetClientId && envelope.targetClientId !== clientId)) return;
          emitToClient(envelope.type, envelope.payload);
        });
      }
      emitter.emit("open");
    },
    disconnect(){
      if (!connected) return;
      connected = false;
      if (channel){
        channel.close();
        channel = null;
      }
      emitter.emit("close");
    },
    send(type, payload){
      routeClientEvent(type, payload);
    },
    on(type, handler){
      emitter.on(type, handler);
    },
    off(type, handler){
      emitter.off(type, handler);
    },
  };
}
