import { CLIENT_ROOM_EVENTS } from "./protocol.js";

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

export function createRoomClient({ session, transport }){
  const emitter = createEmitter();
  let connected = false;

  const handleOpen = () => {
    connected = true;
    emitter.emit("transport_connected");
  };
  const handleClose = () => {
    connected = false;
    emitter.emit("transport_disconnected");
  };
  const handleMessage = (event) => {
    emitter.emit(event.type, event.payload);
  };

  transport.on("open", handleOpen);
  transport.on("close", handleClose);
  transport.on("message", handleMessage);

  return {
    connect(){
      emitter.emit("transport_connecting");
      transport.connect();
    },
    disconnect(){
      transport.disconnect();
    },
    joinRoom(currentSession = session){
      transport.send(CLIENT_ROOM_EVENTS.JOIN_ROOM, {
        roomCode: currentSession.roomCode,
        gameId: currentSession.gameId,
        maxPlayers: currentSession.maxPlayers,
        mode: currentSession.mode,
        player: {
          id: currentSession.playerId,
          name: currentSession.playerName,
        },
      });
    },
    leaveRoom(currentSession = session){
      transport.send(CLIENT_ROOM_EVENTS.LEAVE_ROOM, {
        roomCode: currentSession.roomCode,
        playerId: currentSession.playerId,
      });
    },
    send(eventName, payload){
      transport.send(eventName, payload);
    },
    on(eventName, handler){
      emitter.on(eventName, handler);
    },
    off(eventName, handler){
      emitter.off(eventName, handler);
    },
    isConnected(){
      return connected;
    },
  };
}
