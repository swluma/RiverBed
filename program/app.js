import { COMMON_WORDS_URL, DICT_URL, WIN_SCORE } from "./config.js";
import {
  createNewGame,
  beginSwipe, extendSwipe, releaseSwipe, confirmSwipe,
  getSkillOffers, upgradeSkill,
  applyHint, canUseHint, totalSkillLevels,
  setWinScore
} from "./game.js";
import {
  bindUI, setDictStatus, renderAll,
  setConfirmState,
  setFeedback, animateAttemptsFail, shakeFeedback,
  showSkillModal, onChooseSkill,
  showHintModal, onApplyHint, onCancelHint,
  showEndModal, onApplyWinScore
} from "./ui.js";

let dictSet = null;
let dictWords = null;
let embedWords = null;

let g = null;
let ui = null;

let locked = true;
let pointerActiveId = null;
let targetWinScore = WIN_SCORE;

function isLocked(){ return locked || !g || g.gameOver; }

ui = bindUI({
  onNewMatch,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onHint,
  onConfirm,
});

if (ui.winScoreValue){
  ui.winScoreValue.textContent = String(targetWinScore);
}

onChooseSkill(ui, (skillId) => {
  if (!g || g.gameOver) return;
  upgradeSkill(g, skillId);
  locked = false;
  renderNow();
  setFeedback(ui, "Ready", "Swipe to form a word. Release to lock it in, then confirm.");
  if (g.gameOver) showEndModal(ui, g);
});

onApplyHint(ui, (allocations) => {
  if (!g || g.gameOver) return;
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
    renderNow();
    return;
  }

  renderNow();
  setFeedback(ui, "Hint revealed", "Highlighted tiles form a valid word.");
});

onCancelHint(ui, () => {
  if (!g || g.gameOver) return;
  locked = false;
  renderNow();
  setFeedback(ui, "Ready", "Swipe to form a word. Release to lock it in, then confirm.");
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

    setDictStatus(ui, "ok", `Dictionary OK (${set.size.toLocaleString()} words)`);
    ui.newMatchBtn.disabled = false;
    locked = false;

    onNewMatch();
  } catch(err){
    console.error(err);
    setDictStatus(ui, "no", "Dictionary load failed (check network/URL).");
    locked = true;
  }
}

function onNewMatch(){
  if (!dictSet || !dictWords) return;
  try{
    g = createNewGame(dictSet, dictWords, embedWords, targetWinScore);
  } catch(e){
    console.error(e);
    setFeedback(ui, "ERROR", "Field generation failed. Try again (New Match).");
    return;
  }
  locked = false;
  pointerActiveId = null;
  renderNow();
  setFeedback(ui, "Ready", "Swipe to form a word. Release to lock it in, then confirm.");
}

function normalizeWinScore(value){
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
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

async function openSkillSelectIfNeeded(){
  if (!g || g.gameOver) return;

  const offers = getSkillOffers(g);
  if (offers.length === 0){
    locked = false;
    renderNow();
    setFeedback(ui, "Ready", "All skills maxed. No selection this turn.");
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

async function onConfirm(){
  if (isLocked()) return;
  if (!g || g.gameOver) return;

  const result = confirmSwipe(g);
  renderNow();

  if (result.type === "NO_CONSUME_SHORT"){
    setFeedback(ui, "No attempt consumed", "Trace at least 3 tiles to submit.");
    shakeFeedback(ui);
    return;
  }

  await handleEvaluationResult(result);
}

async function handleEvaluationResult(result){
  if (result.type === "FAIL_INVALID" || result.type === "FAIL_DUPLICATE"){
    const reasonText =
      result.reason === "DUPLICATE" ? "Duplicate (match-wide)" :
      "Not in dictionary";
    setFeedback(ui, "FAIL", `${reasonText}. Combo reset.`);
    shakeFeedback(ui);
    await animateAttemptsFail(ui, g);
    renderNow();
    if (result.ended){
      await openSkillSelectIfNeeded();
    }
    return;
  }

  if (result.type === "SUCCESS"){
    setFeedback(ui, "SUCCESS", `+${result.finalWordPoints} pts (word itself). Turn ends.`);
    renderNow();
    if (g.gameOver){
      showEndModal(ui, g);
      locked = true;
      return;
    }
    await openSkillSelectIfNeeded();
  }
}

function renderNow(){
  if (!g) return;
  renderAll(ui, g);
  setConfirmState(ui, g.pendingConfirm, isLocked());
}

loadDictionary();
