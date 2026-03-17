# Rogue Boggle Room Server

## Run

Install dependencies:

```powershell
npm install
```

Start the combined static server + WebSocket room server:

```powershell
npm start
```

Then open:

```text
http://localhost:8080/
```

The WebSocket endpoint is:

```text
ws://localhost:8080/ws
```

## Hub examples

```text
http://localhost:8080/?hub=1&mode=local&name=Yuki
http://localhost:8080/?hub=1&mode=host&name=Yuki&room=ABCD12
http://localhost:8080/?hub=1&mode=join&name=Mika&room=ABCD12
```

If you need to point the frontend at another room server, add `ws` in the URL:

```text
http://localhost:8080/?hub=1&mode=host&name=Yuki&room=ABCD12&ws=ws://localhost:9000/ws
```

## Scope

Implemented:

- static file serving from `docs/`
- WebSocket room transport
- room join / leave
- ready state
- host start
- room state sync
- heartbeat updates
- game action relay
- room close on host disconnect

Not finished yet:

- authoritative multiplayer gameplay state
- deterministic remote action application inside the game engine
- reconnect resume beyond basic room context + sync request
