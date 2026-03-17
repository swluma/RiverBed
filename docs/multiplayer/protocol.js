export const CLIENT_ROOM_EVENTS = Object.freeze({
  JOIN_ROOM: "join_room",
  LEAVE_ROOM: "leave_room",
  PLAYER_READY: "player_ready",
  START_GAME: "start_game",
  GAME_ACTION: "game_action",
  SYNC_REQUEST: "sync_request",
  HEARTBEAT: "heartbeat",
});

export const SERVER_ROOM_EVENTS = Object.freeze({
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

export const ROOM_PHASES = Object.freeze({
  IDLE: "idle",
  WAITING: "waiting",
  READY: "ready",
  PLAYING: "playing",
  ENDED: "ended",
});

export const CONNECTION_STATUS = Object.freeze({
  OFFLINE: "offline",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  WAITING: "waiting",
  IN_ROOM: "in room",
  ERROR: "error",
});

export const GAME_ACTION_TYPES = Object.freeze({
  GAME_START: "game_start",
  SELECT_TILE: "select_tile",
  CONFIRM_WORD: "confirm_word",
  USE_SKILL: "use_skill",
  END_TURN: "end_turn",
  UPDATE_SCORE: "update_score",
  SYNC_SNAPSHOT: "sync_snapshot",
});

export function createGameAction(type, payload = {}, meta = {}){
  return {
    id: meta.id || `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    createdAt: meta.createdAt || Date.now(),
    actorId: meta.actorId || null,
    turnNo: Number.isFinite(meta.turnNo) ? meta.turnNo : null,
    payload,
  };
}

export function isKnownGameActionType(type){
  return Object.values(GAME_ACTION_TYPES).includes(type);
}

export function isValidGameAction(action){
  if (!action || typeof action !== "object") return false;
  if (!isKnownGameActionType(action.type)) return false;
  if (typeof action.id !== "string" || !action.id) return false;
  if (!Number.isFinite(action.createdAt)) return false;
  if (!("payload" in action)) return false;
  return true;
}

/*
Payload notes for future backend integration:

Client -> server
- join_room: { roomCode, gameId, player: { id, name }, mode }
- leave_room: { roomCode, playerId }
- player_ready: { roomCode, playerId, ready }
- start_game: { roomCode, playerId, gameId, seed? }
- game_action: { roomCode, action }
- sync_request: { roomCode, playerId, lastKnownActionId? }
- heartbeat: { roomCode, playerId, at }

Server -> client
- room_joined: { roomCode, playerId, room }
- room_state: { room }
- player_joined: { roomCode, player }
- player_left: { roomCode, playerId }
- player_ready: { roomCode, playerId, ready }
- game_started: { roomCode, startedAt, startedBy, phase, seed?, mock }
- game_action: { roomCode, action, fromPlayerId }
- sync_state: { roomCode, room, lastAction? }
- error: { code, message, recoverable }
- room_closed: { roomCode, message }
*/
