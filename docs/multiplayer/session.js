export const GAME_ID = "rogue-boggle";
export const MAX_PLAYERS = 2;
export const ROOM_CODE_MIN_LEN = 4;
export const ROOM_CODE_MAX_LEN = 12;
export const PLAYER_NAME_MAX_LEN = 24;

const VALID_MODES = new Set(["local", "host", "join"]);

function safeStorageGet(storage, key){
  try{
    return storage?.getItem?.(key) || null;
  } catch {
    return null;
  }
}

function safeStorageSet(storage, key, value){
  try{
    storage?.setItem?.(key, value);
  } catch {}
}

export function sanitizeRoomCode(raw){
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_MAX_LEN);
}

export function sanitizePlayerName(raw){
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, PLAYER_NAME_MAX_LEN);
}

export function createStablePlayerId(gameId = GAME_ID){
  const storageKey = `${gameId}:player-id`;
  const existing = safeStorageGet(globalThis.sessionStorage, storageKey);
  if (existing) return existing;
  const generated = `${gameId}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  safeStorageSet(globalThis.sessionStorage, storageKey, generated);
  return generated;
}

export function resolveSessionFromLocation(locationLike = globalThis.location){
  const search = locationLike?.search || "";
  const href = locationLike?.href || "";
  const params = new URLSearchParams(search);
  const hasHubFlag = params.get("hub") === "1";
  const requestedModeRaw = String(params.get("mode") || "").trim().toLowerCase();
  const requestedMode = requestedModeRaw || "local";
  const requestedName = params.get("name");
  const requestedRoom = params.get("room");
  const validationErrors = [];

  const source = hasHubFlag ? "hub" : "direct";
  const playerName = sanitizePlayerName(requestedName);
  const roomCode = sanitizeRoomCode(requestedRoom);
  const playerId = createStablePlayerId(GAME_ID);

  if (!VALID_MODES.has(requestedMode)){
    if (requestedModeRaw){
      validationErrors.push(`Unsupported mode "${requestedModeRaw}".`);
    }
  }

  if ((requestedMode === "host" || requestedMode === "join") && !playerName){
    validationErrors.push("Player name is required for room play.");
  }

  if (requestedMode === "host" || requestedMode === "join"){
    if (!roomCode){
      validationErrors.push("Room code is required for host/join mode.");
    } else if (roomCode.length < ROOM_CODE_MIN_LEN){
      validationErrors.push(`Room code must be at least ${ROOM_CODE_MIN_LEN} characters.`);
    }
  }

  const hasRoomRequest = requestedMode === "host" || requestedMode === "join";
  const isValid = validationErrors.length === 0;
  const resolvedMode = isValid && VALID_MODES.has(requestedMode) ? requestedMode : "local";
  const isRoomPlay = resolvedMode === "host" || resolvedMode === "join";
  const isLocalPlay = resolvedMode === "local";

  return {
    source,
    mode: resolvedMode,
    requestedMode,
    playerId,
    playerName,
    roomCode: hasRoomRequest ? (roomCode || null) : null,
    isRoomPlay,
    isLocalPlay,
    maxPlayers: MAX_PLAYERS,
    gameId: GAME_ID,
    isHost: resolvedMode === "host",
    isGuest: resolvedMode === "join",
    isValid,
    validationErrors,
    canFallbackToLocal: !isValid,
    hasHubParams: hasHubFlag || params.has("mode") || params.has("name") || params.has("room"),
    hubUrl: hasHubFlag ? (document.referrer || null) : null,
    launchUrl: href,
  };
}
