import { COMMON_WORDS_URL, DICT_URL, WIN_SCORE, MIN_WORD_LEN } from "./config.js";
import {
  createNewGame,
  hydrateGameState,
  beginSwipe, extendSwipe, releaseSwipe, confirmSwipe,
  getSkillOffers, upgradeSkill,
  applyHint, canUseHint, totalSkillLevels,
  setSelectionPath,
  serializeGameState,
  setWinScore,
  timeoutTurn,
  shuffleBoard,
  SKILLS,
  findComputerWord
} from "./game.js";
import {
  bindUI, setDictStatus, renderAll,
  setConfirmState,
  setFeedback, animateAttemptsFail, shakeFeedback,
  showSkillModal, onChooseSkill,
  showHintModal, onApplyHint, onCancelHint,
  showEndModal, onApplyWinScore, onApplyTimeLimit,
  onApplyVsComputer,
  onApplySpectatorMode,
  onSpectatorPause,
  onSpectatorResume,
  onSpectatorInterrupt,
  onSpectatorRematch,
  showShuffleModal, showNoWordsModal, onConfirmShuffle, onCancelShuffle,
  renderRoomStatus, renderRoomWaiting,
  showTestSkillsModal, onApplyTestSkills, onCancelTestSkills
} from "./ui.js";
import { resolveSessionFromLocation } from "./multiplayer/session.js";
import {
  CLIENT_ROOM_EVENTS,
  CONNECTION_STATUS,
  GAME_ACTION_TYPES,
  SERVER_ROOM_EVENTS,
  createGameAction,
} from "./multiplayer/protocol.js";
import { createInitialRoomState, getRoomViewModel, reduceRoomEvent } from "./multiplayer/roomState.js";
import { createWebSocketRoomTransport, resolveRoomServerUrl } from "./multiplayer/wsTransport.js";
import { createRoomClient } from "./multiplayer/roomClient.js";

let dictSet = null;
let dictWords = null;
let embedWords = null;

let g = null;
let ui = null;

let locked = true;
let pointerActiveId = null;
let targetWinScore = WIN_SCORE;
let timeLimitSettings = [0, 0];
let timeLimitIntervalId = null;
let timeLimitDeadlineMs = null;
let timeLimitRemainingSec = null;
let timeLimitCoverActive = false;
let roomTurnCoverActive = false;
let lastTurnKey = null;
let initialSkills = createInitialSkillState();
let dictionaryReady = false;
let localFallbackConfirmed = false;
let roomHeartbeatId = null;
let roomClient = null;
let roomSession = resolveSessionFromLocation(window.location);
let roomState = createInitialRoomState(roomSession);
let lastRoomPromptKey = null;
let wasLocalTurnPlayable = false;

const COMPUTER_OPTIONS = {
  normal: {
    label: "Normal",
    sampleSize: 220,
    stopScore: 280,
    tilePreference: { gold: 0, white: 0, fountain: 0 },
    opponentFountainPenalty: 0,
    lengthPreference: { min: 3, max: 4, bonus: 4, penaltyPerStep: 6 },
    lengthRegulation: {
      mode: "soft",
      primaryMin: 3,
      primaryMax: 4,
      primaryProbability: 0.85,
    },
  },
  strong: {
    label: "Strong",
    sampleSize: 420,
    stopScore: 360,
    tilePreference: { gold: 2, white: 2, fountain: 3 },
    opponentFountainPenalty: 15,
    lengthPreference: { min: 4, max: 5, bonus: 8, penaltyPerStep: 4 },
    lengthRegulation: {
      mode: "hard",
      primaryMin: 4,
      primaryMax: 5,
      fallbackToShorter: true,
    },
  },
  "very-strong": {
    label: "Very Strong",
    sampleSize: 900,
    stopScore: 520,
    tilePreference: { gold: 3, white: 3, fountain: 5 },
    opponentFountainPenalty: 26,
    lengthPreference: { min: 4, max: 6, bonus: 12, penaltyPerStep: 1 },
    lengthRegulation: {
      mode: "hard",
      primaryMin: 5,
      primaryMax: 6,
      fallbackToShorter: true,
    },
  },
};
const COMPUTER_SKILL_PRIORITY = {
  POINT_FOUNTAIN: 5,
  FAIL_OPP: 5,
  EXTRA_SWIPE: 4,
  VALUE_DECAY: 6,
  WIN_FOOTSTEPS: 5,
  COLOR_CANCEL: 4,
  EXTRA_CHANCE: 3,
  SPELL_FINDER: 4,
  SAFETY_NET: 3,
};
const COMPUTER_SKILL_PREF_CATEGORIES = {
  point: { cat: "POINT", label: "Point skills", bonus: 3 },
  counter: { cat: "COUNTER", label: "Counter skills", bonus: 3 },
  technical: { cat: "TECH", label: "Technical skills", bonus: 3 },
};
function normalizeSkillPreference(input){
  if (!input) return null;
  if (typeof input === "string"){
    if (input === "balanced") return null;
    if (Object.prototype.hasOwnProperty.call(COMPUTER_SKILL_PREF_CATEGORIES, input)){
      return { category: input, intensity: 1 };
    }
    return null;
  }
  const category = input?.category;
  const meta = COMPUTER_SKILL_PREF_CATEGORIES[category];
  if (!meta) return null;
  const raw = Number(input.intensity);
  if (!Number.isFinite(raw)) return null;
  const intensity = Math.max(0, Math.min(1, raw));
  if (intensity <= 0) return null;
  return { category, intensity };
}
function describeSkillPreferenceLabel(pref){
  if (!pref) return "Balanced";
  const meta = COMPUTER_SKILL_PREF_CATEGORIES[pref.category];
  if (!meta) return "Balanced";
  if (pref.intensity >= 1) return `${meta.label} specialist`;
  if (pref.intensity >= 0.66) return `${meta.label} (strong focus)`;
  if (pref.intensity >= 0.33) return `${meta.label} (preference)`;
  return `${meta.label} (lean bias)`;
}

function buildAutoPlayerConfig(strength, skillPreference){
  const option = COMPUTER_OPTIONS[strength];
  if (!option) return null;
  const normalizedPref = normalizeSkillPreference(skillPreference);
  return {
    key: strength,
    label: option.label || "Computer",
    skillPreference: normalizedPref,
    skillPreferenceLabel: describeSkillPreferenceLabel(normalizedPref),
  };
}

function getAutoPlayerConfig(playerIndex = (g && g.active)){
  return autoPlayers[playerIndex] || null;
}
let nextAutoMode = null;
let autoMode = null;
let autoPlayers = { 0: null, 1: null };
let spectatorPaused = false;
let spectatorInterrupted = false;
let computerTimer = null;
let computerRunning = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createInitialSkillState(){
  const base = {};
  for (const id of Object.keys(SKILLS)){
    base[id] = 0;
  }
  return {
    p1: { ...base },
    p2: { ...base },
  };
}

function normalizeInitialSkills(input){
  const normalized = createInitialSkillState();
  for (const id of Object.keys(SKILLS)){
    const max = SKILLS[id]?.max ?? 5;
    const p1Raw = Number.parseInt(input?.p1?.[id], 10);
    const p2Raw = Number.parseInt(input?.p2?.[id], 10);
    normalized.p1[id] = Number.isFinite(p1Raw) ? Math.max(0, Math.min(max, p1Raw)) : 0;
    normalized.p2[id] = Number.isFinite(p2Raw) ? Math.max(0, Math.min(max, p2Raw)) : 0;
  }
  return normalized;
}

function getLocalRoomPlayerIndex(){
  if (roomSession.isHost) return 0;
  if (roomSession.isGuest) return 1;
  return null;
}

function isRoomAuthoritativeClient(){
  return roomSession.isRoomPlay && roomSession.isHost;
}

function isLocalPlayersTurn(){
  if (!roomSession.isRoomPlay) return true;
  if (!g || roomState.phase !== "playing") return false;
  const localIndex = getLocalRoomPlayerIndex();
  return localIndex != null && g.active === localIndex;
}

function isRoomGameplayActive(){
  return roomSession.isRoomPlay && roomState.phase === "playing";
}

function updateRoomState(event){
  roomState = reduceRoomEvent(roomState, event, roomSession);
  renderRoomUi();
}

function buildSnapshotAction(reason){
  return {
    reason,
    snapshot: serializeGameState(g),
    activePlayer: g?.active ?? null,
    turnNo: g?.turnNo ?? null,
    feedback: {
      title: ui?.fbTitle?.textContent || "",
      sub: ui?.fbSub?.textContent || "",
    },
  };
}

function broadcastGameSnapshot(reason){
  if (!isRoomAuthoritativeClient() || !roomClient || !g) return;
  emitRoomGameAction(GAME_ACTION_TYPES.SYNC_SNAPSHOT, buildSnapshotAction(reason));
}

function applyIncomingSnapshot(snapshot, reason = "sync", feedback = null){
  if (!snapshot || !dictSet || !dictWords) return;
  g = hydrateGameState(snapshot, dictSet, dictWords, embedWords);
  pointerActiveId = null;
  lastTurnKey = null;
  stopTimeLimitCountdown();
  timeLimitRemainingSec = null;
  locked = roomSession.isRoomPlay && !isLocalPlayersTurn();
  renderNow();
  maybeOpenRoomSkillPrompt();
  if (feedback?.title){
    setFeedback(ui, feedback.title, feedback.sub || "");
  }
  syncReadyFeedbackOnTurnChange();
}

function maybeOpenRoomSkillPrompt(){
  if (!roomSession.isRoomPlay || !g || !g.skillSelect?.pending) return;
  const localIndex = getLocalRoomPlayerIndex();
  if (localIndex == null || g.skillSelect.chooser !== localIndex) return;
  const offerIds = Array.isArray(g.skillSelect.offers) ? g.skillSelect.offers.map((offer) => offer.id).join(",") : "";
  const promptKey = `${g.turnNo}:${g.skillSelect.chooser}:${offerIds}`;
  if (lastRoomPromptKey === promptKey) return;
  lastRoomPromptKey = promptKey;
  if (!Array.isArray(g.skillSelect.offers) || g.skillSelect.offers.length === 0) return;
  locked = true;
  showSkillModal(ui, g, g.skillSelect.offers);
}

function syncReadyFeedbackOnTurnChange(){
  if (!roomSession.isRoomPlay || !g || g.gameOver){
    wasLocalTurnPlayable = false;
    return;
  }

  const localTurnPlayable = isLocalPlayersTurn() && !g.skillSelect?.pending;
  if (localTurnPlayable && !wasLocalTurnPlayable){
    setFeedback(ui, "Ready", "Swipe to form a word. Release to lock it in, then confirm.");
  }
  wasLocalTurnPlayable = localTurnPlayable;
}

async function applyRemoteIntentAction(action){
  if (!isRoomAuthoritativeClient() || !g) return;
  const payload = action?.payload || {};

  if (action.type === GAME_ACTION_TYPES.CONFIRM_WORD){
    if (!setSelectionPath(g, payload.path || [])) return;
    const result = confirmSwipe(g);
    renderNow();
    await handleEvaluationResult(result, {
      skipBroadcast: true,
      suppressRemoteFeedback: true,
      suppressPrompts: true,
    });
    broadcastGameSnapshot("confirm_word");
    return;
  }

  if (action.type === GAME_ACTION_TYPES.USE_SKILL){
    if (payload.kind === "upgrade_skill"){
      upgradeSkill(g, payload.skillId);
      locked = false;
      renderNow();
      broadcastGameSnapshot("upgrade_skill");
      return;
    }
    if (payload.kind === "hint"){
      applyHint(g, payload.allocations || {});
      locked = false;
      renderNow();
      broadcastGameSnapshot("hint");
      return;
    }
    if (payload.kind === "shuffle_board"){
      shuffleBoard(g);
      locked = false;
      renderNow();
      broadcastGameSnapshot("shuffle_board");
    }
    return;
  }

  if (action.type === GAME_ACTION_TYPES.END_TURN && payload.reason === "timeout"){
    const result = timeoutTurn(g);
    renderNow();
    if (result.ended && g.skillSelect?.autoAdvance && Array.isArray(g.skillSelect.offers) && g.skillSelect.offers.length === 0){
      getSkillOffers(g);
    }
    broadcastGameSnapshot("timeout");
  }
}

function getRoomPlayersForUi(){
  return (roomState.players || []).map((player) => ({
    name: player.name,
    ready: !!player.ready,
    role: player.id === roomState.hostId ? "Host" : "Guest",
  }));
}

function renderRoomUi(){
  const viewModel = getRoomViewModel(roomSession, roomState);
  const roomControlsLocked = roomSession.isRoomPlay;
  if (ui?.vsComputerBtn) ui.vsComputerBtn.disabled = roomControlsLocked;
  if (ui?.spectatorBtn) ui.spectatorBtn.disabled = roomControlsLocked;
  if (ui?.testSkillsBtn) ui.testSkillsBtn.disabled = roomControlsLocked;
  if (ui?.newMatchBtn){
    const waitingForFallback = roomSession.canFallbackToLocal && !localFallbackConfirmed;
    const waitingForRoomStart = roomSession.isRoomPlay && roomState.phase !== "playing";
    ui.newMatchBtn.disabled = !dictionaryReady || waitingForFallback || waitingForRoomStart;
  }
  const note = roomSession.isRoomPlay
    ? (roomState.phase === "playing"
      ? "Room play active. WebSocket room transport is connected, but deterministic gameplay sync is still a TODO."
      : `Room bootstrap active. Waiting flow is using ${resolveRoomServerUrl()}.`)
    : (roomSession.canFallbackToLocal
      ? "Hub parameters were invalid. Review the error and continue locally if needed."
      : "Local single-device play.");

  renderRoomStatus(ui, roomSession, roomState, viewModel, {
    forceVisible: roomSession.hasHubParams,
    note,
  });

  const waitingModel = {
    visible: false,
    title: "Room Session",
    body: "",
    roomCode: roomSession.roomCode,
    players: getRoomPlayersForUi(),
    errors: [],
    showCopy: !!roomSession.roomCode,
    showRetry: false,
    showBackHub: !!roomSession.hubUrl,
    showReload: true,
    showContinueLocal: false,
    showReady: false,
    readyDisabled: false,
    showStart: false,
    startDisabled: true,
  };

  if (roomSession.canFallbackToLocal && !localFallbackConfirmed){
    waitingModel.visible = true;
    waitingModel.title = "Invalid room launch";
    waitingModel.body = "The hub parameters could not start a room session safely.";
    waitingModel.errors = roomSession.validationErrors.slice();
    waitingModel.showContinueLocal = true;
    waitingModel.showRetry = false;
  } else if (roomSession.isRoomPlay && roomState.phase !== "playing"){
    waitingModel.visible = true;
    waitingModel.errors = roomState.lastError?.message ? [roomState.lastError.message] : [];
    waitingModel.showRetry = roomState.connectionStatus === CONNECTION_STATUS.ERROR;
    waitingModel.showContinueLocal = roomState.connectionStatus === CONNECTION_STATUS.ERROR;
    waitingModel.showReady = roomSession.isGuest && roomState.joined;
    waitingModel.readyDisabled = !!viewModel.self?.ready;
    waitingModel.showStart = roomSession.isHost && roomState.joined;
    waitingModel.startDisabled = !viewModel.canStart;

    if (roomSession.isHost){
      waitingModel.title = "Host room";
      waitingModel.body = roomState.playerCount > 1
        ? "Another player is connected. Start the match when both players are ready."
        : "Waiting for another player...";
    } else {
      waitingModel.title = roomState.joined ? "Joined room" : "Joining room...";
      waitingModel.body = roomState.joined
        ? "Waiting for the host to start the match."
        : "Connecting to the room and requesting the current state.";
    }
  }

  renderRoomWaiting(ui, waitingModel);
}

function startRoomHeartbeat(){
  stopRoomHeartbeat();
  if (!roomClient || !roomSession.isRoomPlay) return;
  roomHeartbeatId = setInterval(() => {
    roomClient.send(CLIENT_ROOM_EVENTS.HEARTBEAT, {
      roomCode: roomSession.roomCode,
      playerId: roomSession.playerId,
      at: Date.now(),
    });
  }, 5000);
}

function stopRoomHeartbeat(){
  if (roomHeartbeatId){
    clearInterval(roomHeartbeatId);
    roomHeartbeatId = null;
  }
}

function connectRoomSession(){
  if (!roomSession.isRoomPlay || !roomSession.isValid || roomClient) return;
  const transport = createWebSocketRoomTransport({
    url: resolveRoomServerUrl(),
  });
  roomClient = createRoomClient({ session: roomSession, transport });
  const roomEvents = [
    "transport_connecting",
    "transport_connected",
    "transport_disconnected",
    SERVER_ROOM_EVENTS.ROOM_JOINED,
    SERVER_ROOM_EVENTS.ROOM_STATE,
    SERVER_ROOM_EVENTS.PLAYER_JOINED,
    SERVER_ROOM_EVENTS.PLAYER_LEFT,
    SERVER_ROOM_EVENTS.PLAYER_READY,
    SERVER_ROOM_EVENTS.GAME_STARTED,
    SERVER_ROOM_EVENTS.GAME_ACTION,
    SERVER_ROOM_EVENTS.SYNC_STATE,
    SERVER_ROOM_EVENTS.ERROR,
    SERVER_ROOM_EVENTS.ROOM_CLOSED,
  ];

  for (const eventName of roomEvents){
    roomClient.on(eventName, (payload) => {
      updateRoomState({ type: eventName, payload });
      if (eventName === SERVER_ROOM_EVENTS.ROOM_JOINED){
        roomClient.send(CLIENT_ROOM_EVENTS.SYNC_REQUEST, {
          roomCode: roomSession.roomCode,
          playerId: roomSession.playerId,
        });
        if (roomSession.isHost){
          roomClient.send(CLIENT_ROOM_EVENTS.PLAYER_READY, {
            roomCode: roomSession.roomCode,
            playerId: roomSession.playerId,
            ready: true,
          });
        }
        startRoomHeartbeat();
      }
      if (eventName === SERVER_ROOM_EVENTS.GAME_STARTED){
        startRoomMatch(payload);
      }
      if (eventName === SERVER_ROOM_EVENTS.GAME_ACTION){
        const action = payload?.action || null;
        if (!action) return;
        if (action.type === GAME_ACTION_TYPES.SYNC_SNAPSHOT && action.payload?.snapshot){
          applyIncomingSnapshot(action.payload.snapshot, "remote_turn", action.payload.feedback || null);
          return;
        }
        if (isRoomAuthoritativeClient()){
          void applyRemoteIntentAction(action);
        }
      }
      if (eventName === SERVER_ROOM_EVENTS.SYNC_STATE && payload?.lastAction?.type === GAME_ACTION_TYPES.SYNC_SNAPSHOT && payload.lastAction?.payload?.snapshot){
        applyIncomingSnapshot(
          payload.lastAction.payload.snapshot,
          "remote_turn",
          payload.lastAction.payload.feedback || null
        );
      }
    });
  }

  roomClient.connect();
  roomClient.joinRoom(roomSession);
}

function resetToLocalFallback(){
  roomSession = {
    ...roomSession,
    mode: "local",
    isRoomPlay: false,
    isLocalPlay: true,
    isHost: false,
    isGuest: false,
  };
  roomState = createInitialRoomState(roomSession);
  renderRoomUi();
}

function startResolvedBootstrap(){
  renderRoomUi();
  if (!dictionaryReady) return;
  if (roomSession.canFallbackToLocal && !localFallbackConfirmed) return;
  if (roomSession.isRoomPlay){
    connectRoomSession();
    return;
  }
  if (!g){
    onNewMatch();
  }
}

function startRoomMatch(payload = {}){
  if (!dictionaryReady) return;
  roomState = {
    ...roomState,
    phase: "playing",
    startedAt: payload.startedAt || Date.now(),
    connectionStatus: CONNECTION_STATUS.IN_ROOM,
  };
  if (isRoomAuthoritativeClient()){
    onNewMatch({ source: "room-start" });
    broadcastGameSnapshot("game_started");
  } else {
    locked = true;
    renderRoomUi();
    setFeedback(ui, "Room match starting", "Waiting for the host snapshot.");
  }
  renderRoomUi();
}

function emitRoomGameAction(type, payload = {}){
  if (!roomClient || !isRoomGameplayActive()) return;
  const action = createGameAction(type, payload, {
    actorId: roomSession.playerId,
    turnNo: g?.turnNo ?? null,
  });
  roomClient.send(CLIENT_ROOM_EVENTS.GAME_ACTION, {
    roomCode: roomSession.roomCode,
    fromPlayerId: roomSession.playerId,
    action,
  });
}

function isLocked(){ return locked || timeLimitCoverActive || roomTurnCoverActive || !g || g.gameOver; }

ui = bindUI({
  onNewMatch,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onHint,
  onConfirm,
  onStartTurn,
  onShuffle,
  onOpenTestSkills,
  onRetryRoom,
  onBackToHub,
  onReloadPage,
  onContinueLocal,
  onCopyRoomCode,
  onRoomReady,
  onRoomStart,
});

if (ui.winScoreValue){
  ui.winScoreValue.textContent = String(targetWinScore);
}

renderRoomUi();

onChooseSkill(ui, (skillId) => {
  if (!g || g.gameOver) return;
  if (roomSession.isRoomPlay && !isRoomAuthoritativeClient()){
    locked = true;
    emitRoomGameAction(GAME_ACTION_TYPES.USE_SKILL, { kind: "upgrade_skill", skillId });
    setFeedback(ui, "Waiting", "Submitting skill choice to the host...");
    return;
  }
  upgradeSkill(g, skillId);
  locked = false;
  renderNow();
  setFeedback(ui, "Ready", "Swipe to form a word. Release to lock it in, then confirm.");
  broadcastGameSnapshot("upgrade_skill");
  if (g.gameOver) showEndModal(ui, g);
});

onApplyHint(ui, (allocations) => {
  if (!g || g.gameOver) return;
  if (roomSession.isRoomPlay && !isRoomAuthoritativeClient()){
    locked = true;
    emitRoomGameAction(GAME_ACTION_TYPES.USE_SKILL, { kind: "hint", allocations });
    setFeedback(ui, "Waiting", "Submitting hint request to the host...");
    return;
  }
  const result = applyHint(g, allocations);
  locked = false;

  if (!result.ok){
    const ap = g.players[g.active];
    const total = totalSkillLevels(ap);
    const reasonText =
      result.reason === "INSUFFICIENT_SKILLS" ? `Need 3 total skill levels (have ${total}).` :
      result.reason === "NO_HINT_AVAILABLE" ? "No available word on this board right now." :
      result.reason === "USED_THIS_TURN" ? "Hint already used this turn." :
      result.reason === "TOTAL_NOT_THREE" ? "Select exactly 3 skill levels to sacrifice." :
      "Hint unavailable.";
    setFeedback(ui, "Hint failed", reasonText);
    if (result.reason === "NO_HINT_AVAILABLE"){
      showNoWordsModal(ui);
    }
    renderNow();
    return;
  }

  renderNow();
  setFeedback(ui, "Hint revealed", "Highlighted tiles form a valid word.");
  broadcastGameSnapshot("hint");
});

onCancelHint(ui, () => {
  if (!g || g.gameOver) return;
  locked = false;
  renderNow();
  setFeedback(ui, "Ready", "Swipe to form a word. Release to lock it in, then confirm.");
});

onApplyTestSkills(ui, (payload) => {
  initialSkills = normalizeInitialSkills(payload);
  locked = false;
  onNewMatch();
});

onCancelTestSkills(ui, () => {
  locked = false;
});

onApplyWinScore(ui, ({ mode, value }) => {
  const next = normalizeWinScore(value);
  if (!next){
    setFeedback(ui, "Invalid target", "Enter a whole number greater than 0.");
    return;
  }

  targetWinScore = next;
  if (ui.winScoreValue) ui.winScoreValue.textContent = String(targetWinScore);

  if (mode === "new"){
    onNewMatch();
    return;
  }

  if (!g) return;
  const ended = setWinScore(g, targetWinScore);
  renderNow();
  if (ended && g.gameOver){
    showEndModal(ui, g);
    locked = true;
  } else {
    if (ui.endModal) ui.endModal.classList.add("hidden");
    locked = false;
    setFeedback(ui, "Target updated", `First to ${targetWinScore} points wins. Resume play.`);
  }
});

onApplyTimeLimit(ui, ({ mode, p1, p2 }) => {
  const parsed = normalizeTimeLimits(p1, p2);
  if (!parsed){
    setFeedback(ui, "Invalid time limit", "Enter minutes >= 0 (decimals allowed).");
    return;
  }
  const [p1Sec, p2Sec] = parsed;

  timeLimitSettings = [p1Sec, p2Sec];
  if (g) g.timeLimits = [p1Sec, p2Sec];
  syncTimeLimitModalDefaults();

  if (mode === "new"){
    onNewMatch();
    return;
  }

  if (!g) return;
  lastTurnKey = null;
  renderNow();
  setFeedback(ui, "Time limit updated", "Settings applied. Resume play.");
});

onApplyVsComputer(ui, ({ strength, skillPreference } = {}) => {
  const config = buildAutoPlayerConfig(strength, skillPreference);
  if (!config) return;
  nextAutoMode = {
    mode: "vsComputer",
    players: { 0: null, 1: config },
  };
  spectatorPaused = false;
  spectatorInterrupted = false;
  onNewMatch();
});

onApplySpectatorMode(ui, ({ players } = {}) => {
  if (!players) return;
  const p1Config = buildAutoPlayerConfig(players[0]?.strength, players[0]?.skillPreference);
  const p2Config = buildAutoPlayerConfig(players[1]?.strength, players[1]?.skillPreference);
  if (!p1Config || !p2Config) return;
  nextAutoMode = {
    mode: "spectator",
    players: { 0: p1Config, 1: p2Config },
  };
  spectatorPaused = false;
  spectatorInterrupted = false;
  onNewMatch();
});

onSpectatorPause(ui, () => {
  if (!g || g.gameOver || autoMode !== "spectator") return;
  spectatorPaused = true;
  spectatorInterrupted = false;
  cancelScheduledComputerTurn();
  locked = false;
  setFeedback(ui, "Spectator paused", "Computers stopped. Press Resume to continue.");
  renderNow();
});

onSpectatorResume(ui, () => {
  if (!g || g.gameOver || autoMode !== "spectator") return;
  spectatorPaused = false;
  spectatorInterrupted = false;
  locked = true;
  setFeedback(ui, "Spectator resuming", "Computers are back in play.");
  renderNow();
});

onSpectatorInterrupt(ui, () => {
  if (!g || g.gameOver || autoMode !== "spectator") return;
  spectatorPaused = true;
  spectatorInterrupted = true;
  cancelScheduledComputerTurn();
  locked = false;
  setFeedback(ui, "Spectator interrupted", "Computers stopped. Press Resume to continue.");
  renderNow();
});

onSpectatorRematch(ui, () => {
  if (!g || autoMode !== "spectator") return;
  const cloneConfig = (config) => config
    ? {
      ...config,
      skillPreference: config.skillPreference ? { ...config.skillPreference } : null,
    }
    : null;
  const p1Config = cloneConfig(autoPlayers[0]);
  const p2Config = cloneConfig(autoPlayers[1]);
  if (!p1Config || !p2Config) return;
  nextAutoMode = {
    mode: "spectator",
    players: { 0: p1Config, 1: p2Config },
  };
  spectatorPaused = false;
  spectatorInterrupted = false;
  onNewMatch();
});

onConfirmShuffle(ui, () => {
  if (!g || g.gameOver) return;
  if (roomSession.isRoomPlay && !isRoomAuthoritativeClient()){
    locked = true;
    emitRoomGameAction(GAME_ACTION_TYPES.USE_SKILL, { kind: "shuffle_board" });
    setFeedback(ui, "Waiting", "Submitting board shuffle to the host...");
    return;
  }
  const ok = shuffleBoard(g);
  locked = false;
  renderNow();
  if (ok){
    setFeedback(ui, "Board shuffled", "Tiles randomized. Embedded words removed.");
    broadcastGameSnapshot("shuffle_board");
  }
});

onCancelShuffle(ui, () => {
  locked = false;
});

async function loadDictionary(){
  setDictStatus(ui, "wait", "Loading dictionary…");
  try{
    const dictRes = await fetch(DICT_URL, { cache:"force-cache" });
    if (!dictRes.ok) throw new Error("HTTP " + dictRes.status);
    const dictText = await dictRes.text();

    let commonJson = [];
    try{
      const commonRes = await fetch(COMMON_WORDS_URL, { cache:"force-cache" });
      if (commonRes.ok){
        commonJson = await commonRes.json();
      }
    } catch {}

    const set = new Set();
    const words = [];
    const commonSet = new Set();

    const normalizeWord = (raw) =>
      String(raw || "").toLowerCase().replace(/[^a-z]/g, "");

    for (const row of commonJson){
      const w = normalizeWord(row && row[0]);
      if (w.length < 3) continue;
      commonSet.add(w);
    }

    for (const line of dictText.split(/\r?\n/)){
      const w = normalizeWord(line.trim());
      if (w.length < 3) continue;
      if (set.has(w)) continue;
      set.add(w);
      words.push(w);
    }

    dictSet = set;
    dictWords = words;
    embedWords = words.filter((w) => commonSet.has(w));
    if (embedWords.length === 0) embedWords = words;
    dictionaryReady = true;

    setDictStatus(ui, "ok", `Dictionary OK (${set.size.toLocaleString()} words)`);
    ui.newMatchBtn.disabled = false;
    locked = false;
    startResolvedBootstrap();
  } catch(err){
    console.error(err);
    setDictStatus(ui, "no", "Dictionary load failed (check network/URL).");
    locked = true;
  }
}

function onNewMatch(options = {}){
  if (roomSession.canFallbackToLocal && !localFallbackConfirmed){
    setFeedback(ui, "Launch blocked", "Confirm the local fallback before starting a match.");
    renderRoomUi();
    return;
  }
  if (roomSession.isRoomPlay && !isRoomGameplayActive()){
    setFeedback(ui, "Room waiting", "The match will start once the room is ready.");
    renderRoomUi();
    return;
  }
  cancelScheduledComputerTurn();
  autoPlayers = { 0: null, 1: null };
  autoMode = null;
  spectatorPaused = false;
  spectatorInterrupted = false;
  if (nextAutoMode){
    autoMode = nextAutoMode.mode;
    autoPlayers = {
      0: nextAutoMode.players[0] || null,
      1: nextAutoMode.players[1] || null,
    };
    nextAutoMode = null;
  }
  if (!dictSet || !dictWords) return;
  const matchSkills = buildMatchInitialSkills();
  try{
    g = createNewGame(dictSet, dictWords, embedWords, targetWinScore, matchSkills);
  } catch(e){
    console.error(e);
    setFeedback(ui, "ERROR", "Field generation failed. Try again (New Match).");
    return;
  }
  if (g){
    g.timeLimits = [timeLimitSettings[0] || 0, timeLimitSettings[1] || 0];
    syncAutoState();
  }
  syncTimeLimitModalDefaults();
  locked = false;
  pointerActiveId = null;
  lastTurnKey = null;
  stopTimeLimitCountdown();
  timeLimitRemainingSec = null;
  setGridCoverVisible(false);
  renderNow();
  setFeedback(ui, "Ready", "Swipe to form a word. Release to lock it in, then confirm.");
  if (isRoomAuthoritativeClient() && options.source !== "snapshot"){
    broadcastGameSnapshot("new_match");
  }
}

function buildMatchInitialSkills(){
  const payload = {
    p1: { ...initialSkills.p1 },
    p2: { ...initialSkills.p2 },
  };
  return payload;
}

function normalizeWinScore(value){
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeTimeLimits(p1Raw, p2Raw){
  const p1 = Number.parseFloat(p1Raw);
  const p2 = Number.parseFloat(p2Raw);
  if (!Number.isFinite(p1) || !Number.isFinite(p2)) return null;
  if (p1 < 0 || p2 < 0) return null;
  const p1Sec = Math.round(p1 * 60);
  const p2Sec = Math.round(p2 * 60);
  return [p1Sec, p2Sec];
}

function syncTimeLimitModalDefaults(){
  if (!ui) return;
  if (ui.timeLimitP1Input){
    ui.timeLimitP1Input.dataset.value = String((timeLimitSettings[0] || 0) / 60);
  }
  if (ui.timeLimitP2Input){
    ui.timeLimitP2Input.dataset.value = String((timeLimitSettings[1] || 0) / 60);
  }
}

function getTimeLimitForActive(){
  if (!g) return 0;
  const raw = Array.isArray(g.timeLimits) ? g.timeLimits[g.active] : 0;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return limit;
}

function updateTimeLimitDisplay(){
  if (!ui || !ui.timeLimitDisplay) return;
  const limit = getTimeLimitForActive();
  if (!limit){
    ui.timeLimitDisplay.classList.add("hidden");
    ui.timeLimitDisplay.textContent = "";
    return;
  }
  ui.timeLimitDisplay.classList.remove("hidden");
  const remaining = (timeLimitRemainingSec != null) ? timeLimitRemainingSec : limit;
  ui.timeLimitDisplay.textContent = `${remaining}s`;
  ui.timeLimitDisplay.classList.toggle("red", g && g.active === 0);
  ui.timeLimitDisplay.classList.toggle("blue", g && g.active === 1);
}

function renderGridCover(visible, { title = "Ready", playerIndex = (g && g.active), showButton = true } = {}){
  if (!ui || !ui.gridCover) return;
  ui.gridCover.classList.toggle("hidden", !visible);
  if (!visible) return;
  ui.gridCover.classList.toggle("red", playerIndex === 0);
  ui.gridCover.classList.toggle("blue", playerIndex === 1);
  if (ui.gridCoverTitle){
    ui.gridCoverTitle.textContent = title;
  }
  if (ui.startTurnBtn){
    ui.startTurnBtn.classList.toggle("hidden", !showButton);
  }
}

function syncGridCover(){
  const localIndex = getLocalRoomPlayerIndex();
  const showOpponentCover = roomSession.isRoomPlay
    && roomState.phase === "playing"
    && g
    && localIndex != null
    && g.active !== localIndex;

  roomTurnCoverActive = showOpponentCover;
  if (showOpponentCover){
    renderGridCover(true, {
      title: "Opponent Turn",
      playerIndex: g.active,
      showButton: false,
    });
    return;
  }

  renderGridCover(timeLimitCoverActive, {
    title: (g && g.active === 0) ? "Player 1 Ready" : "Player 2 Ready",
    playerIndex: g && g.active,
    showButton: timeLimitCoverActive,
  });
}

function setGridCoverVisible(visible){
  timeLimitCoverActive = !!visible;
  syncGridCover();
}

function stopTimeLimitCountdown(){
  if (timeLimitIntervalId){
    clearInterval(timeLimitIntervalId);
    timeLimitIntervalId = null;
  }
  timeLimitDeadlineMs = null;
}

function initializeTimeLimitForTurn(){
  stopTimeLimitCountdown();
  const limit = getTimeLimitForActive();
  timeLimitRemainingSec = limit || null;
  if (!limit){
    setGridCoverVisible(false);
    updateTimeLimitDisplay();
    return;
  }
  updateTimeLimitDisplay();
  setGridCoverVisible(true);
}

function startTimeLimitCountdown(){
  const limit = getTimeLimitForActive();
  if (!limit) return;
  stopTimeLimitCountdown();
  timeLimitRemainingSec = limit;
  timeLimitDeadlineMs = Date.now() + limit * 1000;
  setGridCoverVisible(false);
  updateTimeLimitDisplay();

  timeLimitIntervalId = setInterval(() => {
    if (!g || g.gameOver || (g.skillSelect && g.skillSelect.pending)){
      stopTimeLimitCountdown();
      return;
    }
    const remaining = Math.max(0, Math.ceil((timeLimitDeadlineMs - Date.now()) / 1000));
    if (remaining !== timeLimitRemainingSec){
      timeLimitRemainingSec = remaining;
      updateTimeLimitDisplay();
    }
    if (remaining <= 0){
      stopTimeLimitCountdown();
      void handleTimeLimitExpired();
    }
  }, 200);
}

async function handleTimeLimitExpired(){
  if (!g || g.gameOver || (g.skillSelect && g.skillSelect.pending)) return;
  if (roomSession.isRoomPlay && !isRoomAuthoritativeClient()){
    locked = true;
    emitRoomGameAction(GAME_ACTION_TYPES.END_TURN, { reason: "timeout" });
    setFeedback(ui, "Waiting", "Reporting timeout to the host...");
    return;
  }
  const result = timeoutTurn(g);
  renderNow();
  setFeedback(ui, "TIME UP", "Time expired. Attempt skipped and counted as a failure.");
  if (result.ended){
    await openSkillSelectIfNeeded();
  }
  broadcastGameSnapshot("timeout");
}

function syncTimeLimitState(){
  if (!g || g.gameOver){
    stopTimeLimitCountdown();
    setGridCoverVisible(false);
    updateTimeLimitDisplay();
    return;
  }
  if (g.skillSelect && g.skillSelect.pending){
    stopTimeLimitCountdown();
    setGridCoverVisible(false);
    updateTimeLimitDisplay();
    return;
  }

  const turnKey = `${g.turnNo}:${g.active}`;
  if (turnKey !== lastTurnKey){
    lastTurnKey = turnKey;
    initializeTimeLimitForTurn();
    return;
  }

  updateTimeLimitDisplay();
}

function tileIndexFromEventTarget(target){
  const tile = target?.closest?.(".tile");
  if (!tile) return -1;
  return Number(tile.dataset.idx);
}

function onPointerDown(e){
  if (isLocked()) return;
  const idx = tileIndexFromEventTarget(e.target);
  if (!(idx >= 0)) return;

  pointerActiveId = e.pointerId;
  ui.grid.setPointerCapture(pointerActiveId);

  beginSwipe(g, idx);
  renderNow();
}

function onPointerMove(e){
  if (isLocked()) return;
  if (pointerActiveId == null || e.pointerId !== pointerActiveId) return;

  const elAt = document.elementFromPoint(e.clientX, e.clientY);
  const idx = tileIndexFromEventTarget(elAt);
  if (!(idx >= 0)) return;

  extendSwipe(g, idx);
  renderNow();
}

async function onPointerUp(e){
  if (isLocked()) return;
  if (pointerActiveId == null || e.pointerId !== pointerActiveId) return;

  try{ ui.grid.releasePointerCapture(pointerActiveId); } catch {}
  pointerActiveId = null;

  const result = releaseSwipe(g);

  renderNow();

  if (result.type === "NO_CONSUME_SHORT"){
    setFeedback(ui, "No attempt consumed", "Trace at least 3 tiles to submit.");
    shakeFeedback(ui);
    return;
  }

  if (result.type === "PENDING"){
    setFeedback(ui, "Ready to confirm", "Trace locked. Tap Confirm to submit.");
    return;
  }
}

function onPointerCancel(e){
  if (isLocked()) return;
  if (pointerActiveId == null || e.pointerId !== pointerActiveId) return;
  try{ ui.grid.releasePointerCapture(pointerActiveId); } catch {}
  pointerActiveId = null;

  g.selection = [];
  g.selectionSet = new Set();
  g.selectionWord = "";
  g.pendingConfirm = false;
  renderNow();
  setFeedback(ui, "Ready", "Swipe to form a word. Release to lock it in, then confirm.");
}

async function openSkillSelectIfNeeded(options = {}){
  if (!g || g.gameOver) return;

  const offers = getSkillOffers(g);
  if (offers.length === 0){
    locked = false;
    renderNow();
    setFeedback(ui, "Ready", "All skills maxed. No selection this turn.");
    return;
  }

  if (options.silent){
    locked = false;
    renderNow();
    return;
  }

  if (isAutoPlayerActive()){
    const autoConfig = getAutoPlayerConfig();
    locked = true;
    const skillId = chooseComputerSkill(offers, autoConfig?.skillPreference);
    locked = false;
    if (skillId){
      upgradeSkill(g, skillId);
      renderNow();
      const skillName = SKILLS[skillId]?.name || skillId;
      setFeedback(ui, "Computer upgraded", `Computer increased ${skillName}. Your turn.`);
    } else {
      renderNow();
      setFeedback(ui, "Computer skipped", "No skill upgrade chosen.");
    }
    return;
  }

  locked = true;
  showSkillModal(ui, g, offers);
}

function onHint(){
  if (isLocked()) return;
  if (!g || g.gameOver) return;

  if (!canUseHint(g)){
    const ap = g.players[g.active];
    const total = totalSkillLevels(ap);
    const msg = (g.hint && g.hint.usedThisTurn)
      ? "Hint already used this turn."
      : `Need 3 total skill levels (have ${total}).`;
    setFeedback(ui, "Hint unavailable", msg);
    return;
  }

  locked = true;
  showHintModal(ui, g);
}

function onStartTurn(){
  if (!g || g.gameOver) return;
  if (g.skillSelect && g.skillSelect.pending) return;
  if (!getTimeLimitForActive()) return;
  startTimeLimitCountdown();
}

function onShuffle(){
  if (isLocked()) return;
  if (!g || g.gameOver) return;
  if (g.skillSelect && g.skillSelect.pending){
    setFeedback(ui, "Shuffle blocked", "Choose a skill first, then try again.");
    return;
  }
  locked = true;
  showShuffleModal(ui);
}

function onOpenTestSkills(){
  if (!ui) return;
  locked = true;
  showTestSkillsModal(ui, initialSkills);
}

function onRetryRoom(){
  if (roomClient){
    stopRoomHeartbeat();
    roomClient.disconnect();
    roomClient = null;
  }
  roomState = createInitialRoomState(roomSession);
  renderRoomUi();
  connectRoomSession();
}

function onBackToHub(){
  if (roomSession.hubUrl){
    window.location.href = roomSession.hubUrl;
    return;
  }
  window.history.back();
}

function onReloadPage(){
  window.location.reload();
}

function onContinueLocal(){
  localFallbackConfirmed = true;
  if (roomClient){
    stopRoomHeartbeat();
    roomClient.leaveRoom(roomSession);
    roomClient.disconnect();
    roomClient = null;
  }
  resetToLocalFallback();
  if (dictionaryReady && !g){
    onNewMatch();
  }
}

async function onCopyRoomCode(){
  if (!roomSession.roomCode) return;
  try{
    await navigator.clipboard.writeText(roomSession.roomCode);
    renderRoomUi();
    setFeedback(ui, "Room code copied", `Share ${roomSession.roomCode} with the other player.`);
  } catch {
    setFeedback(ui, "Copy failed", `Room code: ${roomSession.roomCode}`);
  }
}

function onRoomReady(){
  if (!roomClient || !roomSession.isRoomPlay) return;
  roomClient.send(CLIENT_ROOM_EVENTS.PLAYER_READY, {
    roomCode: roomSession.roomCode,
    playerId: roomSession.playerId,
    ready: true,
  });
}

function onRoomStart(){
  if (!roomClient || !roomSession.isHost) return;
  roomClient.send(CLIENT_ROOM_EVENTS.START_GAME, {
    roomCode: roomSession.roomCode,
    playerId: roomSession.playerId,
    gameId: roomSession.gameId,
  });
}

async function onConfirm(){
  if (isLocked()) return;
  if (!g || g.gameOver) return;
  if (roomSession.isRoomPlay && !isRoomAuthoritativeClient()){
    if (!g.pendingConfirm){
      setFeedback(ui, "No word locked", "Release a valid path before confirming.");
      return;
    }
    locked = true;
    emitRoomGameAction(GAME_ACTION_TYPES.CONFIRM_WORD, {
      path: Array.isArray(g.selection) ? g.selection.slice() : [],
    });
    setFeedback(ui, "Waiting", "Submitting your word to the host...");
    return;
  }

  const result = confirmSwipe(g);
  renderNow();

  if (result.type === "NO_CONSUME_SHORT"){
    setFeedback(ui, "No attempt consumed", "Trace at least 3 tiles to submit.");
    shakeFeedback(ui);
    return;
  }

  await handleEvaluationResult(result);
}

async function handleEvaluationResult(result, options = {}){
  if (result.type === "FAIL_INVALID" || result.type === "FAIL_DUPLICATE"){
    if (!options.suppressRemoteFeedback){
      emitRoomGameAction(GAME_ACTION_TYPES.CONFIRM_WORD, {
        outcome: "fail",
        reason: result.reason || "INVALID",
        word: g?.selectionWord || null,
      });
    }
    const reasonText =
      result.reason === "DUPLICATE" ? "Duplicate (match-wide)" :
      "Not in dictionary";
    setFeedback(ui, "FAIL", `${reasonText}. Combo reset.`);
    shakeFeedback(ui);
    await animateAttemptsFail(ui, g);
    renderNow();
    if (g.gameOver){
      showEndModal(ui, g);
      locked = true;
      return;
    }
    if (result.ended){
      await openSkillSelectIfNeeded({ silent: !!options.suppressPrompts });
    }
    if (!options.skipBroadcast){
      broadcastGameSnapshot("confirm_fail");
    }
    return;
  }

  if (result.type === "SUCCESS"){
    if (!options.suppressRemoteFeedback){
      emitRoomGameAction(GAME_ACTION_TYPES.CONFIRM_WORD, {
        outcome: "success",
        word: result.word || g?.selectionWord || null,
        points: result.finalWordPoints ?? null,
        extraSwipe: !!result.extraSwipe,
      });
    }
    if (result.extraSwipe){
      const remaining = Number.isFinite(result.extraSwipeLeft) ? result.extraSwipeLeft : 0;
      const suffix = (remaining > 1) ? ` Extra swipes left: ${remaining}.` : "";
      setFeedback(ui, "SUCCESS", `+${result.finalWordPoints} pts (word itself). Extra swipe!${suffix}`);
    } else {
      setFeedback(ui, "SUCCESS", `+${result.finalWordPoints} pts (word itself). Turn ends.`);
    }
    renderNow();
    if (g.gameOver){
      showEndModal(ui, g);
      locked = true;
      return;
    }
    if (result.ended){
      await openSkillSelectIfNeeded({ silent: !!options.suppressPrompts });
    }
    if (!options.skipBroadcast){
      broadcastGameSnapshot("confirm_success");
    }
  }
}

function syncAutoState(){
  if (!g) return;
  g.autoMode = autoMode;
  g.autoPlayers = {
    0: autoPlayers[0],
    1: autoPlayers[1],
  };
  g.spectatorState = {
    active: autoMode === "spectator",
    paused: spectatorPaused,
    interrupted: spectatorInterrupted,
  };
}

function renderNow(){
  if (!g) return;
  if (!g.skillSelect?.pending){
    lastRoomPromptKey = null;
  }
  syncAutoState();
  renderAll(ui, g);
  syncTimeLimitState();
  syncTimeLimitModalDefaults();
  syncGridCover();
  setConfirmState(ui, g.pendingConfirm, isLocked());
  renderRoomUi();
  syncReadyFeedbackOnTurnChange();
  maybeScheduleComputerTurn();
}

function isAutoPlayerActive(playerIndex = (g && g.active)){
  return !!getAutoPlayerConfig(playerIndex);
}

function chooseComputerSkill(offers, skillPreference = null){
  if (!offers || offers.length === 0) return null;
  const normalizedPref = normalizeSkillPreference(skillPreference);
  const prefMeta = normalizedPref ? COMPUTER_SKILL_PREF_CATEGORIES[normalizedPref.category] : null;
  const intensity = normalizedPref?.intensity ?? 0;
  const getScore = (offer) => {
    const base = COMPUTER_SKILL_PRIORITY[offer.id] ?? 0;
    const meta = SKILLS[offer.id];
    const cat = meta?.cat;
    let bonus = 0;
    if (prefMeta && cat === prefMeta.cat){
      bonus = prefMeta.bonus * intensity;
    }
    return base + bonus;
  };

  if (prefMeta && intensity >= 1){
    let bestPref = null;
    let bestPrefScore = -Infinity;
    for (const offer of offers){
      const meta = SKILLS[offer.id];
      if (meta?.cat !== prefMeta.cat) continue;
      const score = getScore(offer);
      if (!bestPref || score > bestPrefScore){
        bestPref = offer;
        bestPrefScore = score;
      }
    }
    if (bestPref) return bestPref.id;
  }

  let best = null;
  let bestScore = -Infinity;
  for (const offer of offers){
    const score = getScore(offer);
    if (!best || score > bestScore){
      best = offer;
      bestScore = score;
    }
  }
  return best ? best.id : null;
}

function setSelectionFromPath(path){
  g.selection = path.slice();
  g.selectionSet = new Set(path);
  g.selectionWord = path.map(idx => g.board[idx]).join("");
  g.pendingConfirm = true;
}

async function animateComputerSwipe(path){
  g.selection = [];
  g.selectionSet = new Set();
  g.selectionWord = "";
  g.pendingConfirm = false;
  for (let i=0; i<path.length; i++){
    const idx = path[i];
    g.selection.push(idx);
    g.selectionSet.add(idx);
    g.selectionWord += g.board[idx];
    g.pendingConfirm = i === path.length - 1;
    renderNow();
    await sleep(220);
  }
  g.pendingConfirm = true;
  renderNow();
}

function cancelScheduledComputerTurn(){
  if (computerTimer){
    clearTimeout(computerTimer);
    computerTimer = null;
  }
}

function shouldAutoPlayComputer(){
  if (!g || g.gameOver) return false;
  if (g.skillSelect && g.skillSelect.pending) return false;
  const config = getAutoPlayerConfig();
  if (!config) return false;
  if (autoMode === "spectator" && spectatorPaused) return false;
  return true;
}

function maybeScheduleComputerTurn(){
  if (!shouldAutoPlayComputer()){
    cancelScheduledComputerTurn();
    return;
  }
  if (computerTimer || computerRunning) return;
  computerTimer = setTimeout(() => {
    computerTimer = null;
    void runComputerTurn();
  }, 420);
}

async function runComputerTurn(){
  if (!shouldAutoPlayComputer()) return;
  computerRunning = true;
  try{
    locked = true;
    setFeedback(ui, "Computer thinking", "Looking for a word...");
    const playerIndex = g.active;
    const config = getAutoPlayerConfig(playerIndex);
    const options = config ? COMPUTER_OPTIONS[config.key] : null;
    const candidate = findComputerWord(g, playerIndex, {
      sampleSize: options?.sampleSize,
      stopScore: options?.stopScore,
      tilePreference: options?.tilePreference,
      opponentFountainPenalty: options?.opponentFountainPenalty,
      lengthPreference: options?.lengthPreference,
      lengthRegulation: options?.lengthRegulation,
    });
    if (candidate && Array.isArray(candidate.path) && candidate.path.length >= MIN_WORD_LEN){
      await animateComputerSwipe(candidate.path);
      setFeedback(ui, "Computer found", `Word: ${candidate.word}`);
      await sleep(3000);
      const result = confirmSwipe(g);
      await handleEvaluationResult(result);
      return;
    }
    const result = timeoutTurn(g);
    renderNow();
    setFeedback(ui, "Computer passed", "No valid word was found.");
    if (result.ended){
      await openSkillSelectIfNeeded();
    } else {
      locked = false;
    }
  } finally {
    computerRunning = false;
    maybeScheduleComputerTurn();
  }
}

window.addEventListener("beforeunload", () => {
  if (roomClient && roomSession.isRoomPlay){
    roomClient.leaveRoom(roomSession);
    roomClient.disconnect();
  }
  stopRoomHeartbeat();
});

loadDictionary();
