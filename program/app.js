import { DICT_URL, WIN_SCORE } from "./config.js";
import {
  createNewGame,
  beginSwipe, extendSwipe, releaseSwipe,
  getSkillOffers, upgradeSkill,
  setWinScore
} from "./game.js";
import {
  bindUI, setDictStatus, renderAll,
  setFeedback, animateAttemptsFail, shakeFeedback,
  showSkillModal, onChooseSkill,
  showEndModal, onApplyWinScore
} from "./ui.js";

let dictSet = null;
let dictWords = null;

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
});

if (ui.winScoreValue){
  ui.winScoreValue.textContent = String(targetWinScore);
}

onChooseSkill(ui, (skillId) => {
  if (!g || g.gameOver) return;
  upgradeSkill(g, skillId);
  locked = false;
  renderAll(ui, g);
  setFeedback(ui, "Ready", "Swipe to form a word. Release to submit.");
  if (g.gameOver) showEndModal(ui, g);
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
  renderAll(ui, g);
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
    const res = await fetch(DICT_URL, { cache:"force-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();

    const set = new Set();
    const words = [];

    for (const row of json){
      const w = String(row[0]).toLowerCase().replace(/[^a-z]/g, "");
      if (w.length < 3) continue;
      set.add(w);
      words.push(w);
    }

    dictSet = set;
    dictWords = words;

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
    g = createNewGame(dictSet, dictWords, targetWinScore);
  } catch(e){
    console.error(e);
    setFeedback(ui, "ERROR", "Field generation failed. Try again (New Match).");
    return;
  }
  locked = false;
  pointerActiveId = null;
  renderAll(ui, g);
  setFeedback(ui, "Ready", "Swipe to form a word. Release to submit.");
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
  renderAll(ui, g);
}

function onPointerMove(e){
  if (isLocked()) return;
  if (pointerActiveId == null || e.pointerId !== pointerActiveId) return;

  const elAt = document.elementFromPoint(e.clientX, e.clientY);
  const idx = tileIndexFromEventTarget(elAt);
  if (!(idx >= 0)) return;

  extendSwipe(g, idx);
  renderAll(ui, g);
}

async function onPointerUp(e){
  if (isLocked()) return;
  if (pointerActiveId == null || e.pointerId !== pointerActiveId) return;

  try{ ui.grid.releasePointerCapture(pointerActiveId); } catch {}
  pointerActiveId = null;

  const result = releaseSwipe(g);

  renderAll(ui, g);

  if (result.type === "NO_CONSUME_SHORT"){
    setFeedback(ui, "No attempt consumed", "Trace at least 3 tiles to submit.");
    shakeFeedback(ui);
    return;
  }

  if (result.type === "FAIL_INVALID" || result.type === "FAIL_DUPLICATE"){
    const reasonText =
      result.reason === "DUPLICATE" ? "Duplicate (match-wide)" :
      "Not in dictionary";
    setFeedback(ui, "FAIL", `${reasonText}. Combo reset.`);
    shakeFeedback(ui);
    await animateAttemptsFail(ui, g);
    renderAll(ui, g);
    if (result.ended){
      await openSkillSelectIfNeeded();
    }
    return;
  }

  if (result.type === "SUCCESS"){
    setFeedback(ui, "SUCCESS", `+${result.finalWordPoints} pts (word itself). Turn ends.`);
    renderAll(ui, g);
    if (g.gameOver){
      showEndModal(ui, g);
      locked = true;
      return;
    }
    await openSkillSelectIfNeeded();
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
  renderAll(ui, g);
  setFeedback(ui, "Ready", "Swipe to form a word. Release to submit.");
}

async function openSkillSelectIfNeeded(){
  if (!g || g.gameOver) return;

  const offers = getSkillOffers(g);
  if (offers.length === 0){
    locked = false;
    renderAll(ui, g);
    setFeedback(ui, "Ready", "All skills maxed. No selection this turn.");
    return;
  }

  locked = true;
  showSkillModal(ui, g, offers);
}

loadDictionary();
