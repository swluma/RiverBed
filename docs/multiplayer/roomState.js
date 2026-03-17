import { CONNECTION_STATUS, ROOM_PHASES, SERVER_ROOM_EVENTS } from "./protocol.js";

export function createInitialRoomState(session){
  return {
    connectionStatus: session.isRoomPlay ? CONNECTION_STATUS.OFFLINE : CONNECTION_STATUS.OFFLINE,
    roomCode: session.roomCode,
    phase: session.isRoomPlay ? ROOM_PHASES.WAITING : ROOM_PHASES.IDLE,
    hostId: null,
    players: [],
    playerCount: 0,
    transportName: "mock-broadcast",
    joined: false,
    startedAt: null,
    lastError: null,
    lastEvent: null,
    lastAction: null,
    roomClosed: false,
    messages: [],
  };
}

function withRoomSnapshot(state, room){
  const players = Array.isArray(room?.players) ? room.players.slice() : [];
  const phase = room?.phase || state.phase;
  return {
    ...state,
    roomCode: room?.roomCode || state.roomCode,
    phase,
    hostId: room?.hostId || null,
    players,
    playerCount: players.length,
    startedAt: room?.startedAt || state.startedAt,
    joined: true,
    roomClosed: false,
  };
}

export function reduceRoomEvent(state, event, session){
  if (!event) return state;

  if (event.type === "transport_connecting"){
    return { ...state, connectionStatus: CONNECTION_STATUS.CONNECTING, lastError: null };
  }
  if (event.type === "transport_connected"){
    return { ...state, connectionStatus: CONNECTION_STATUS.CONNECTED, lastError: null };
  }
  if (event.type === "transport_disconnected"){
    return { ...state, connectionStatus: CONNECTION_STATUS.OFFLINE };
  }
  if (event.type === "transport_error"){
    return {
      ...state,
      connectionStatus: CONNECTION_STATUS.ERROR,
      lastError: event.payload || { message: "Connection failed." },
    };
  }

  const payload = event.payload || {};
  const nextBase = { ...state, lastEvent: event.type };

  switch (event.type){
    case SERVER_ROOM_EVENTS.ROOM_JOINED:
      return {
        ...withRoomSnapshot(nextBase, payload.room),
        connectionStatus: CONNECTION_STATUS.IN_ROOM,
        lastError: null,
      };
    case SERVER_ROOM_EVENTS.ROOM_STATE: {
      const next = withRoomSnapshot(nextBase, payload.room);
      const phase = next.phase === ROOM_PHASES.PLAYING ? ROOM_PHASES.PLAYING : next.phase;
      const connectionStatus = phase === ROOM_PHASES.PLAYING
        ? CONNECTION_STATUS.IN_ROOM
        : CONNECTION_STATUS.WAITING;
      return { ...next, phase, connectionStatus };
    }
    case SERVER_ROOM_EVENTS.PLAYER_JOINED:
      return {
        ...nextBase,
        messages: state.messages.concat(`${payload.player?.name || "Player"} joined the room.`).slice(-6),
      };
    case SERVER_ROOM_EVENTS.PLAYER_LEFT:
      return {
        ...nextBase,
        messages: state.messages.concat("A player left the room.").slice(-6),
      };
    case SERVER_ROOM_EVENTS.PLAYER_READY:
      return {
        ...nextBase,
        messages: state.messages.concat(`${payload.playerName || "Player"} is ready.`).slice(-6),
      };
    case SERVER_ROOM_EVENTS.GAME_STARTED:
      return {
        ...nextBase,
        phase: ROOM_PHASES.PLAYING,
        connectionStatus: CONNECTION_STATUS.IN_ROOM,
        startedAt: payload.startedAt || Date.now(),
        messages: state.messages.concat("Match start signal received.").slice(-6),
      };
    case SERVER_ROOM_EVENTS.GAME_ACTION:
      return {
        ...nextBase,
        lastAction: payload.action || null,
        messages: state.messages.concat(`Remote action: ${payload.action?.type || "unknown"}`).slice(-6),
      };
    case SERVER_ROOM_EVENTS.SYNC_STATE:
      return {
        ...withRoomSnapshot(nextBase, payload.room),
        lastAction: payload.lastAction || state.lastAction,
        connectionStatus: CONNECTION_STATUS.IN_ROOM,
      };
    case SERVER_ROOM_EVENTS.ERROR:
      return {
        ...nextBase,
        connectionStatus: CONNECTION_STATUS.ERROR,
        lastError: payload,
        messages: state.messages.concat(payload.message || "Room error.").slice(-6),
      };
    case SERVER_ROOM_EVENTS.ROOM_CLOSED:
      return {
        ...nextBase,
        connectionStatus: CONNECTION_STATUS.ERROR,
        roomClosed: true,
        phase: ROOM_PHASES.ENDED,
        lastError: payload,
        messages: state.messages.concat(payload.message || "Room closed.").slice(-6),
      };
    default:
      return nextBase;
  }
}

export function getRoomViewModel(session, roomState){
  const players = Array.isArray(roomState.players) ? roomState.players : [];
  const self = players.find((player) => player.id === session.playerId) || null;
  const everyoneReady = players.length > 0 && players.every((player) => !!player.ready);
  const canStart = session.isHost && players.length === session.maxPlayers && everyoneReady;
  return {
    self,
    everyoneReady,
    canStart,
    playerCountLabel: `${players.length}/${session.maxPlayers}`,
    opponentConnected: players.length > 1,
    statusLabel: roomState.connectionStatus,
  };
}
