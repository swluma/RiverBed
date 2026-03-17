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

function safeJsonParse(raw){
  try{
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function resolveRoomServerUrl(locationLike = globalThis.location){
  const params = new URLSearchParams(locationLike?.search || "");
  const explicit = String(params.get("ws") || globalThis.localStorage?.getItem?.("rogue-boggle:ws-url") || "").trim();
  if (explicit){
    return explicit;
  }

  const protocol = locationLike?.protocol === "https:" ? "wss:" : "ws:";
  const hostname = locationLike?.hostname || "localhost";
  const port = locationLike?.port || "8080";
  return `${protocol}//${hostname}:${port}/ws`;
}

export function createWebSocketRoomTransport({ url } = {}){
  const emitter = createEmitter();
  const socketUrl = url || resolveRoomServerUrl();
  let socket = null;
  let sendQueue = [];

  function flushQueue(){
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (sendQueue.length > 0){
      const message = sendQueue.shift();
      socket.send(JSON.stringify(message));
    }
  }

  function connect(){
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)){
      return;
    }
    socket = new WebSocket(socketUrl);

    socket.addEventListener("open", () => {
      emitter.emit("open");
      flushQueue();
    });

    socket.addEventListener("close", () => {
      emitter.emit("close");
    });

    socket.addEventListener("error", () => {
      emitter.emit("message", {
        type: "transport_error",
        payload: {
          code: "SOCKET_ERROR",
          message: `WebSocket connection failed: ${socketUrl}`,
          recoverable: true,
        },
      });
    });

    socket.addEventListener("message", (event) => {
      const message = safeJsonParse(event.data);
      if (!message || typeof message.type !== "string"){
        emitter.emit("message", {
          type: "transport_error",
          payload: {
            code: "BAD_MESSAGE",
            message: "Received an invalid message from the room server.",
            recoverable: true,
          },
        });
        return;
      }
      emitter.emit("message", message);
    });
  }

  function disconnect(){
    if (!socket) return;
    socket.close();
    socket = null;
    sendQueue = [];
  }

  function send(type, payload){
    const message = { type, payload };
    if (!socket){
      emitter.emit("message", {
        type: "transport_error",
        payload: {
          code: "SOCKET_NOT_READY",
          message: "Room server is not connected.",
          recoverable: true,
        },
      });
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING){
      sendQueue.push(message);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN){
      emitter.emit("message", {
        type: "transport_error",
        payload: {
          code: "SOCKET_NOT_READY",
          message: "Room server is not connected.",
          recoverable: true,
        },
      });
      return;
    }
    socket.send(JSON.stringify(message));
  }

  return {
    name: "websocket",
    connect,
    disconnect,
    send,
    on(type, handler){
      emitter.on(type, handler);
    },
    off(type, handler){
      emitter.off(type, handler);
    },
  };
}
