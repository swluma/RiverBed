import { SIZE, FAIL_COUNTDOWN_MS } from "./config.js";
import {
  SKILLS, describeSkill, describeSkillCompact, describeOffer,
  pointTier, counterTier, techTier,
  canUseHint, totalSkillLevels, comboMultiplier
} from "./game.js";

export function bindUI(handlers){
  const el = {
    grid: document.getElementById("grid"),
    currentWord: document.getElementById("currentWord"),

    turnNo: document.getElementById("turnNo"),
    activePlayer: document.getElementById("activePlayer"),
    attemptsLeft: document.getElementById("attemptsLeft"),
    winScoreValue: document.getElementById("winScoreValue"),

    dictDot: document.getElementById("dictDot"),
    dictText: document.getElementById("dictText"),
    newMatchBtn: document.getElementById("newMatchBtn"),
    legendBtn: document.getElementById("legendBtn"),
    tutorialBtn: document.getElementById("tutorialBtn"),
    skillRefBtn: document.getElementById("skillRefBtn"),
    scoreInfoBtn: document.getElementById("scoreInfoBtn"),
    winScoreBtn: document.getElementById("winScoreBtn"),

    fbTitle: document.getElementById("fbTitle"),
    fbSub: document.getElementById("fbSub"),
    feedback: document.getElementById("feedback"),

    p1Score: document.getElementById("p1Score"),
    p2Score: document.getElementById("p2Score"),
    p1Combo: document.getElementById("p1Combo"),
    p2Combo: document.getElementById("p2Combo"),
    p1ComboMult: document.getElementById("p1ComboMult"),
    p2ComboMult: document.getElementById("p2ComboMult"),
    p1DecayStep: document.getElementById("p1DecayStep"),
    p2DecayStep: document.getElementById("p2DecayStep"),
    p1Bonus: document.getElementById("p1Bonus"),
    p2Bonus: document.getElementById("p2Bonus"),
    p1Skills: document.getElementById("p1Skills"),
    p2Skills: document.getElementById("p2Skills"),
    // Dynamic skill reference (created if missing)
    skillReferenceRoot: document.getElementById("skillReferenceRoot"),

    log: document.getElementById("wordLog"),

    legendModal: document.getElementById("legendModal"),
    closeLegendBtn: document.getElementById("closeLegendBtn"),
    tutorialModal: document.getElementById("tutorialModal"),
    closeTutorialBtn: document.getElementById("closeTutorialBtn"),
    scoreInfoModal: document.getElementById("scoreInfoModal"),
    closeScoreInfoBtn: document.getElementById("closeScoreInfoBtn"),
    skillRefModal: document.getElementById("skillRefModal"),
    closeSkillRefBtn: document.getElementById("closeSkillRefBtn"),

    skillModal: document.getElementById("skillModal"),
    skillOffers: document.getElementById("skillOffers"),
    skillModalTitle: document.getElementById("skillModalTitle"),
    skillModalHint: document.getElementById("skillModalHint"),

    endModal: document.getElementById("endModal"),
    endTitle: document.getElementById("endTitle"),
    endP1: document.getElementById("endP1"),
    endP2: document.getElementById("endP2"),
    closeEndBtn: document.getElementById("closeEndBtn"),
    restartBtn: document.getElementById("restartBtn"),

    winScoreModal: document.getElementById("winScoreModal"),
    winScoreInput: document.getElementById("winScoreInput"),
    winScoreApplyBtn: document.getElementById("winScoreApplyBtn"),
    winScoreApplyNewBtn: document.getElementById("winScoreApplyNewBtn"),
    winScoreCancelBtn: document.getElementById("winScoreCancelBtn"),

    hintBtn: document.getElementById("hintBtn"),
    hintModal: document.getElementById("hintModal"),
    hintSkillList: document.getElementById("hintSkillList"),
    hintRemaining: document.getElementById("hintRemaining"),
    hintApplyBtn: document.getElementById("hintApplyBtn"),
    hintCancelBtn: document.getElementById("hintCancelBtn"),
  };

  // Skill reference content (now shown via modal button)
  if (!el.skillReferenceRoot){
    el.skillReferenceRoot = document.createElement("section");
    el.skillReferenceRoot.id = "skillReferenceRoot";
    el.skillReferenceRoot.className = "skillReferenceRoot";

    if (!el.skillRefModal){
      el.skillRefModal = document.createElement("div");
      el.skillRefModal.id = "skillRefModal";
      el.skillRefModal.className = "modalOverlay hidden";
      el.skillRefModal.innerHTML = `
        <div class="modal card wide">
          <div class="modalHead">
            <div class="modalTitle">Skill Reference</div>
            <button class="ghost" id="closeSkillRefBtn">Close</button>
          </div>
          <div class="modalBody skillRefModalBody"></div>
        </div>
      `;
      document.body.appendChild(el.skillRefModal);
      el.closeSkillRefBtn = el.skillRefModal.querySelector("#closeSkillRefBtn");
    }

    const body = el.skillRefModal.querySelector(".skillRefModalBody");
    if (body) body.appendChild(el.skillReferenceRoot);
  }

  el.skillReferenceRoot.innerHTML = buildSkillReferenceHtml();

  if (!document.getElementById("skillReferenceStyle")){
    // Inject minimal styles (so we don't have to touch styles.css)
    const style = document.createElement("style");
    style.id = "skillReferenceStyle";
    style.textContent = `
      .skillReferenceRoot{ margin: 12px 0 18px; padding: 12px; border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; background: rgba(255,255,255,0.03); }
      .skillRefHeader{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px; flex-wrap:wrap; }
      .skillRefHeader .title{ font-weight:800; letter-spacing:0.2px; }
      .skillRefHeader .hint{ opacity:0.75; font-size: 0.92rem; }
      .skillRefCats{ display:grid; grid-template-columns: 1fr; gap: 10px; }
      .skillRefCat{ border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 10px; background: rgba(0,0,0,0.10); }
      .skillRefCat .catTitle{ font-weight:800; margin-bottom: 8px; }
      .skillRefItem{ margin: 0 0 12px; }
      .skillRefItem:last-child{ margin-bottom:0; }
      .skillRefItem .name{ font-weight:700; margin-bottom: 6px; }
      .skillRefItem .rule{ opacity:0.85; font-size: 0.92rem; margin-bottom: 6px; line-height: 1.35; }
      .skillRefTable{ width:100%; border-collapse: collapse; overflow:hidden; border-radius: 10px; }
      .skillRefTable th, .skillRefTable td{ border: 1px solid rgba(255,255,255,0.10); padding: 6px 8px; vertical-align: top; }
      .skillRefTable th{ font-weight:700; text-align:left; background: rgba(255,255,255,0.05); }
      .skillRefTable td{ background: rgba(0,0,0,0.08); }
      .skillRefSmall{ font-size: 0.90rem; opacity:0.85; line-height: 1.35; }
      @media (max-width: 820px){
        .skillRefHeader .hint{ width:100%; }
      }
    `;
    document.head.appendChild(style);
  }



  // Legend
  el.legendBtn.addEventListener("click", () => show(el.legendModal));
  el.closeLegendBtn.addEventListener("click", () => hide(el.legendModal));
  el.legendModal.addEventListener("click", (e) => {
    if (e.target === el.legendModal) hide(el.legendModal);
  });

  // Scoring modal
  if (el.scoreInfoBtn && el.scoreInfoModal){
    el.scoreInfoBtn.addEventListener("click", () => show(el.scoreInfoModal));
  }
  if (el.closeScoreInfoBtn && el.scoreInfoModal){
    el.closeScoreInfoBtn.addEventListener("click", () => hide(el.scoreInfoModal));
  }
  if (el.scoreInfoModal){
    el.scoreInfoModal.addEventListener("click", (e) => {
      if (e.target === el.scoreInfoModal) hide(el.scoreInfoModal);
    });
  }

  // Skill reference modal
  if (el.skillRefBtn && el.skillRefModal){
    el.skillRefBtn.addEventListener("click", () => show(el.skillRefModal));
  }
  if (el.closeSkillRefBtn && el.skillRefModal){
    el.closeSkillRefBtn.addEventListener("click", () => hide(el.skillRefModal));
  }
  if (el.skillRefModal){
    el.skillRefModal.addEventListener("click", (e) => {
      if (e.target === el.skillRefModal) hide(el.skillRefModal);
    });
  }

  // Tutorial modal
  if (el.tutorialBtn && el.tutorialModal){
    el.tutorialBtn.addEventListener("click", () => show(el.tutorialModal));
  }
  if (el.closeTutorialBtn && el.tutorialModal){
    el.closeTutorialBtn.addEventListener("click", () => hide(el.tutorialModal));
  }
  if (el.tutorialModal){
    el.tutorialModal.addEventListener("click", (e) => {
      if (e.target === el.tutorialModal) hide(el.tutorialModal);
    });
  }

  // Hint modal
  if (el.hintBtn && handlers.onHint){
    el.hintBtn.addEventListener("click", handlers.onHint);
  }
  if (el.hintCancelBtn && el.hintModal){
    el.hintCancelBtn.addEventListener("click", () => {
      hide(el.hintModal);
      el.hintModal.dispatchEvent(new CustomEvent("cancel-hint"));
    });
  }
  if (el.hintModal){
    el.hintModal.addEventListener("click", (e) => {
      if (e.target === el.hintModal){
        hide(el.hintModal);
        el.hintModal.dispatchEvent(new CustomEvent("cancel-hint"));
      }
    });
  }

  // Win score modal
  if (el.winScoreBtn && el.winScoreModal){
    el.winScoreBtn.addEventListener("click", () => {
      if (el.winScoreInput && el.winScoreValue){
        el.winScoreInput.value = el.winScoreValue.textContent || "";
        el.winScoreInput.focus();
        el.winScoreInput.select();
      }
      show(el.winScoreModal);
    });
    if (el.winScoreCancelBtn){
      el.winScoreCancelBtn.addEventListener("click", () => hide(el.winScoreModal));
    }
    el.winScoreModal.addEventListener("click", (e) => {
      if (e.target === el.winScoreModal) hide(el.winScoreModal);
    });

    const emitWinScore = (mode) => {
      const value = el.winScoreInput ? el.winScoreInput.value : "";
      hide(el.winScoreModal);
      el.winScoreModal.dispatchEvent(new CustomEvent("apply-win-score", { detail: { mode, value } }));
    };

    if (el.winScoreApplyBtn){
      el.winScoreApplyBtn.addEventListener("click", () => emitWinScore("resume"));
    }
    if (el.winScoreApplyNewBtn){
      el.winScoreApplyNewBtn.addEventListener("click", () => emitWinScore("new"));
    }
  }

  // New match / restart
  el.newMatchBtn.addEventListener("click", handlers.onNewMatch);
  el.restartBtn.addEventListener("click", () => {
    hide(el.endModal);
    handlers.onNewMatch();
  });
  el.closeEndBtn.addEventListener("click", () => hide(el.endModal));
  el.endModal.addEventListener("click", (e) => {
    if (e.target === el.endModal) hide(el.endModal);
  });

  // Grid pointer controls
  el.grid.addEventListener("contextmenu", (e) => e.preventDefault());

  el.grid.addEventListener("pointerdown", (e) => handlers.onPointerDown(e));
  el.grid.addEventListener("pointermove", (e) => handlers.onPointerMove(e));
  el.grid.addEventListener("pointerup", (e) => handlers.onPointerUp(e));
  el.grid.addEventListener("pointercancel", (e) => handlers.onPointerCancel(e));

  return el;
}

export function setDictStatus(el, state, text){
  el.dictDot.className = "dot " + state; // wait|ok|no
  el.dictText.textContent = text;
  el.newMatchBtn.disabled = (state !== "ok");
}

export function renderAll(el, g){
  // Header
  el.turnNo.textContent = String(g.turnNo);
  el.activePlayer.textContent = (g.active === 0) ? "Player 1 (Red)" : "Player 2 (Blue)";
  const activePill = el.activePlayer.closest(".pill");
  if (activePill){
    activePill.classList.remove("active-red","active-blue");
    activePill.classList.add((g.active === 0) ? "active-red" : "active-blue");
  }
  el.attemptsLeft.textContent = String(getAttemptsLeftDisplay(g));
  if (el.winScoreValue) el.winScoreValue.textContent = String(g.winScore);

  // Current word
  el.currentWord.textContent = g.selectionWord ? g.selectionWord : "—";

  // Scores & combo
  el.p1Score.textContent = String(g.players[0].score);
  el.p2Score.textContent = String(g.players[1].score);
  el.p1Combo.textContent = String(g.players[0].combo);
  el.p2Combo.textContent = String(g.players[1].combo);
  if (el.p1ComboMult) el.p1ComboMult.textContent = formatComboMultiplier(g.players[0].combo);
  if (el.p2ComboMult) el.p2ComboMult.textContent = formatComboMultiplier(g.players[1].combo);
  if (el.p1DecayStep) el.p1DecayStep.textContent = `${g.players[0].decayStepPct ?? 0}%`;
  if (el.p2DecayStep) el.p2DecayStep.textContent = `${g.players[1].decayStepPct ?? 0}%`;

  // Skills panels (compact: only level + current effect)
  el.p1Bonus.innerHTML = renderCategoryBonuses(g.players[0]);
  el.p2Bonus.innerHTML = renderCategoryBonuses(g.players[1]);
  el.p1Skills.innerHTML = renderSkills(g.players[0]);
  el.p2Skills.innerHTML = renderSkills(g.players[1]);

  // Log (success-only)
  el.log.innerHTML = renderLog(g);

  // Field
  renderGrid(el.grid, g);

  // Hint button
  if (el.hintBtn){
    const ap = g.players[g.active];
    const total = totalSkillLevels(ap);
    const usable = canUseHint(g);
    el.hintBtn.disabled = !usable;
    el.hintBtn.textContent = g.hint && g.hint.usedThisTurn ? "Hint used" : "Hint (-3 Lv)";
    el.hintBtn.title = (total < 3)
      ? `Need 3 total skill levels (have ${total}).`
      : "";
  }
}

function renderSkills(p){
  // Compact list for the player panels: level + CURRENT effect only.
  const order = [
    "POINT_INCREASE","POINT_ABSORB","POINT_FOUNTAIN",
    "VALUE_DECAY","WIN_FOOTSTEPS","COLOR_CANCEL",
    "EXTRA_CHANCE","FAIL_OPP","SELF_INVEST"
  ];

  const owned = order.filter(id => (p.skills[id] ?? 0) >= 1);

  if (owned.length === 0){
    return `<div class="muted">No skills yet.</div>`;
  }

  return owned.map(id => {
    const meta = SKILLS[id];
    const lv = p.skills[id];
    const effect = escapeHtml(describeSkillCompact(p, id));
    const catClass =
      meta.cat === "POINT" ? "skillCatPoint" :
      meta.cat === "COUNTER" ? "skillCatCounter" :
      "skillCatTech";
    return `
      <div class="skill compact ${catClass}">
        <div class="name"><span class="skillCatDot"></span>${meta.name} <span class="muted">Lv${lv}/5</span></div>
        <div class="desc">${effect}</div>
      </div>
    `;
  }).join("");
}

export function renderCategoryBonuses(p){
  const pTier = pointTier(p);
  const cTier = counterTier(p);
  const tTier = techTier(p);
  const items = [];

  if (pTier > 0){
    const bonus = (pTier === 1) ? "+8 end of turn" : "+15 end of turn";
    items.push(`
      <div class="bonusItem point">
        <div class="tag"><span class="dot"></span>Point Tier ${pTier}</div>
        <div class="detail">${bonus}</div>
      </div>
    `);
  }

  if (cTier > 0){
    const tiles = (cTier === 1) ? "1 gray tile" : "2 gray tiles";
    items.push(`
      <div class="bonusItem counter">
        <div class="tag"><span class="dot"></span>Counter Tier ${cTier}</div>
        <div class="detail">Opponent turn spawns ${tiles}</div>
      </div>
    `);
  }

  if (tTier > 0){
    const chance = (tTier === 1) ? "50% chance" : "100% chance";
    items.push(`
      <div class="bonusItem tech">
        <div class="tag"><span class="dot"></span>Tech Tier ${tTier}</div>
        <div class="detail">${chance} to destroy one opponent skill (Lv2+)</div>
      </div>
    `);
  }

  if (items.length === 0){
    return `<div class="empty">No category bonuses active.</div>`;
  }

  return items.join("");
}

function renderLog(g){
  const items = g.log.slice().reverse();
  return items.map(it => {
    const cls = (it.player === 0) ? "logItem redOutline" : "logItem blueOutline";
    if (it.type === "SKILL_DESTROY"){
      const meta = SKILLS[it.skillId];
      const name = meta ? meta.name : it.skillId;
      const targetLabel = (it.target === 0) ? "Player 1" : "Player 2";
      return `
        <div class="${cls}">
          <div class="left">
            <div class="word">Skill Destruction</div>
            <div class="muted">${targetLabel} ${escapeHtml(name)} Lv${it.from}->Lv${it.to}</div>
          </div>
          <div class="pts">-1 Lv</div>
        </div>
      `;
    }
    const shared = (it.shared && it.shared > 0)
      ? `<div class="pts shared">-${it.shared} pts</div>`
      : "";
    return `
      <div class="${cls}">
        <div class="left">
          <div class="word">${escapeHtml(it.word)}</div>
        </div>
        <div class="pts">+${it.pts} pts</div>
        ${shared}
      </div>
    `;
  }).join("");
}

function renderGrid(gridEl, g){
  gridEl.style.gridTemplateColumns = `repeat(${SIZE}, 1fr)`;
  if (!gridEl.dataset.built){
    gridEl.innerHTML = "";
    for (let i=0; i<SIZE*SIZE; i++){
      const d = document.createElement("div");
      d.className = "tile";
      d.dataset.idx = String(i);
      const s = document.createElement("span");
      s.className = "letter";
      d.appendChild(s);
      gridEl.appendChild(d);
    }
    gridEl.dataset.built = "1";
  }

  const children = gridEl.children;
  for (let i=0; i<children.length; i++){
    const t = children[i];
    const idx = i;

    // letter
    t.querySelector(".letter").textContent = g.board[idx];

    // selection highlight
    t.classList.toggle("sel", g.selectionSet.has(idx));

    // gray usability
    t.classList.toggle("gray", g.gray.has(idx));

    // hint highlight
    t.classList.toggle("hint", g.hint && g.hint.tiles && g.hint.tiles.has(idx));

    // segments: fountain (red/blue), gold, silver
    const segColors = [];

    // Fountain: each player max 1
    const p1F = g.players[0].fountainIdx;
    const p2F = g.players[1].fountainIdx;
    if (p1F === idx) segColors.push("rgba(255,75,75,0.65)");
    if (p2F === idx) segColors.push("rgba(75,134,255,0.65)");

    if (g.gold.has(idx)) segColors.push("rgba(240,197,74,0.55)");
    if (g.silver.has(idx)) segColors.push("rgba(185,198,255,0.55)");

    if (segColors.length > 0){
      const seg = conicSegments(segColors);
      t.classList.add("hasSeg");
      t.style.setProperty("--seg", seg);
    } else {
      t.classList.remove("hasSeg");
      t.style.removeProperty("--seg");
    }
  }
}

function conicSegments(colors){
  // Split evenly among provided colors
  const n = colors.length;
  const step = 100 / n;
  let start = 0;
  const parts = [];
  for (let i=0; i<n; i++){
    const end = start + step;
    parts.push(`${colors[i]} ${start}% ${end}%`);
    start = end;
  }
  return `conic-gradient(from 90deg, ${parts.join(",")})`;
}

export function setFeedback(el, title, sub){
  el.fbTitle.textContent = title;
  el.fbSub.textContent = sub;
  if (!el.feedback) return;
  el.feedback.classList.remove("success");
  void el.feedback.offsetWidth;
  if (title === "SUCCESS"){
    el.feedback.classList.add("success");
  }
}

export function shakeFeedback(el){
  if (!el.feedback) return;
  el.feedback.classList.remove("shake");
  void el.feedback.offsetWidth;
  el.feedback.classList.add("shake");
  el.feedback.addEventListener("animationend", () => {
    el.feedback.classList.remove("shake");
  }, { once:true });
}

export async function animateAttemptsFail(el, g){
  const nextAttemptsLeft = getAttemptsLeftDisplay(g);
  setFeedback(el, "FAIL", `Attempts left: ${nextAttemptsLeft}`);
  await sleep(FAIL_COUNTDOWN_MS);
}

export function showSkillModal(el, g, offers){
  el.skillOffers.innerHTML = "";
  el.skillModalTitle.textContent =
    (g.active === 0) ? "Player 1: Choose a skill to upgrade" : "Player 2: Choose a skill to upgrade";
  el.skillModalHint.textContent = "One option per category (if available). Choose exactly one.";

  for (const offer of offers){
    const p = g.players[g.active];
    const { catLabel, effect } = describeOffer(p, offer);
    const lv = p.skills[offer.id];

    const card = document.createElement("div");
    card.className = "offer";
    card.innerHTML = `
      <div class="cat">${catLabel}</div>
      <div class="name">${offer.name}</div>
      <div class="lvl">Current: Lv${lv}/5</div>
      <div class="desc">${escapeHtml(effect)}</div>
      <button class="primary">Upgrade</button>
    `;
    card.querySelector("button").addEventListener("click", () => {
      hide(el.skillModal);
      el.skillOffers.innerHTML = "";
      el.skillModal.dispatchEvent(new CustomEvent("choose-skill", { detail: { skillId: offer.id } }));
    });
    el.skillOffers.appendChild(card);
  }

  show(el.skillModal);
}

export function showHintModal(el, g){
  if (!el.hintModal || !el.hintSkillList) return;

  const p = g.players[g.active];
  const skills = Object.keys(p.skills)
    .filter(id => p.skills[id] > 0)
    .map(id => ({ id, lv: p.skills[id], meta: SKILLS[id] }));

  const allocations = {};
  let spent = 0;
  const rowUpdaters = [];

  const updateUi = () => {
    const remaining = Math.max(0, 3 - spent);
    if (el.hintRemaining) el.hintRemaining.textContent = String(remaining);
    if (el.hintApplyBtn) el.hintApplyBtn.disabled = (spent !== 3);
    for (const fn of rowUpdaters) fn();
  };

  el.hintSkillList.innerHTML = "";

  if (skills.length === 0){
    el.hintSkillList.innerHTML = `<div class="muted">No skill levels to sacrifice.</div>`;
    updateUi();
    show(el.hintModal);
    return;
  }

  for (const s of skills){
    const row = document.createElement("div");
    row.className = "hintRow";
    row.innerHTML = `
      <div class="hintInfo">
        <div class="name">${s.meta.name}</div>
        <div class="muted">Lv${s.lv}</div>
      </div>
      <div class="hintControls">
        <button class="ghost small" type="button" data-dir="-">-</button>
        <div class="hintCount">0</div>
        <button class="ghost small" type="button" data-dir="+">+</button>
      </div>
    `;

    const countEl = row.querySelector(".hintCount");
    const decBtn = row.querySelector('button[data-dir="-"]');
    const incBtn = row.querySelector('button[data-dir="+"]');

    const updateRow = () => {
      const current = allocations[s.id] || 0;
      countEl.textContent = String(current);
      decBtn.disabled = current <= 0;
      incBtn.disabled = current >= s.lv || spent >= 3;
    };

    decBtn.addEventListener("click", () => {
      const current = allocations[s.id] || 0;
      if (current <= 0) return;
      allocations[s.id] = current - 1;
      spent -= 1;
      updateRow();
      updateUi();
    });

    incBtn.addEventListener("click", () => {
      const current = allocations[s.id] || 0;
      if (current >= s.lv) return;
      if (spent >= 3) return;
      allocations[s.id] = current + 1;
      spent += 1;
      updateRow();
      updateUi();
    });

    rowUpdaters.push(updateRow);
    el.hintSkillList.appendChild(row);
  }

  updateUi();

  if (el.hintApplyBtn){
    el.hintApplyBtn.onclick = () => {
      hide(el.hintModal);
      el.hintModal.dispatchEvent(new CustomEvent("apply-hint", { detail: { allocations } }));
    };
  }

  show(el.hintModal);
}

export function onChooseSkill(el, handler){
  el.skillModal.addEventListener("choose-skill", (e) => handler(e.detail.skillId));
}

export function onApplyHint(el, handler){
  if (!el.hintModal) return;
  el.hintModal.addEventListener("apply-hint", (e) => handler(e.detail.allocations));
}

export function onCancelHint(el, handler){
  if (!el.hintModal) return;
  el.hintModal.addEventListener("cancel-hint", () => handler());
}

export function onApplyWinScore(el, handler){
  el.winScoreModal.addEventListener("apply-win-score", (e) => handler(e.detail));
}

export function showEndModal(el, g){
  const p1 = g.players[0].score;
  const p2 = g.players[1].score;

  let winner = "Player 1";
  if (p2 > p1) winner = "Player 2";
  if (p1 === p2) winner = "Tie";

  el.endTitle.textContent = (winner === "Tie") ? "Game Over: Tie" : `Game Over: ${winner} wins!`;
  el.endP1.textContent = `Player 1: ${p1}`;
  el.endP2.textContent = `Player 2: ${p2}`;

  show(el.endModal);
}

function show(node){ node.classList.remove("hidden"); }
function hide(node){ node.classList.add("hidden"); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }


function buildSkillReferenceHtml(){
  // Static, rules-accurate reference: ALL skills, ALL levels.
  // (Shown below Player 2 status, not tied to ownership.)
  return `
    <div class="skillRefHeader">
      <div class="title">Skill Reference (All Skills / All Levels)</div>
      <div class="hint">This section lists every skill’s exact per-level effect. (Owned skills are shown compactly in each player panel.)</div>
    </div>

    <div class="skillRefCats">
      <div class="skillRefCat skillCatPoint">
        <div class="catTitle">Point Skills</div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Point Increase (multiplicative)</div>
          <div class="rule">Applied after combo (and after Value Decay if it applies). Multiplies your current score value.</div>
          <table class="skillRefTable">
            <tr><th>Level</th><th>Effect</th></tr>
            <tr><td>Lv1</td><td>×1.10 (+10%)</td></tr>
            <tr><td>Lv2</td><td>×1.18 (+18%)</td></tr>
            <tr><td>Lv3</td><td>×1.27 (+27%)</td></tr>
            <tr><td>Lv4</td><td>×1.38 (+38%)</td></tr>
            <tr><td>Lv5</td><td>×1.50 (+50%)</td></tr>
          </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Point Absorption (steal fixed points)</div>
          <div class="rule">After your <span class="skillRefSmall">finalWordPoints</span> is known: steal points from opponent (opponent score cannot go below 0), then add stolen points to you. (This is separate from your word’s own “+n pts”.)</div>
          <table class="skillRefTable">
            <tr><th>Level</th><th>Stolen on every successful word</th></tr>
            <tr><td>Lv1</td><td>2</td></tr>
            <tr><td>Lv2</td><td>4</td></tr>
            <tr><td>Lv3</td><td>6</td></tr>
            <tr><td>Lv4</td><td>8</td></tr>
            <tr><td>Lv5</td><td>10</td></tr>
          </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Point Fountain</div>
          <div class="rule">
            When you find a word, the <b>final tile</b> becomes your fountain tile (max 1; new replaces old).
            <br/>• If <b>YOU</b> use your own fountain tile in a word: add a flat bonus.
            <br/>• If your <b>OPPONENT</b> uses your fountain tile: you gain <b>50%</b> of that word’s <b>FINAL</b> points (rounded), opponent still gains full word points.
          </div>
          <table class="skillRefTable">
            <tr><th>Level</th><th>Self-use flat bonus</th></tr>
            <tr><td>Lv1</td><td>+5</td></tr>
            <tr><td>Lv2</td><td>+8</td></tr>
            <tr><td>Lv3</td><td>+12</td></tr>
            <tr><td>Lv4</td><td>+18</td></tr>
            <tr><td>Lv5</td><td>+25</td></tr>
          </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Point Skills Category Bonus</div>
          <div class="rule">Based on total Point-skill levels you own. Added at the end of each of your turns (after turn-end effects like Self Investment penalty).</div>
          <table class="skillRefTable">
            <tr><th>Tier</th><th>Requirement</th><th>Effect</th></tr>
            <tr><td>Tier 1</td><td>3 total Point-skill levels</td><td>+8 points at end of each turn</td></tr>
            <tr><td>Tier 2</td><td>6 total Point-skill levels</td><td>+15 points at end of each turn</td></tr>
          </table>
        </div>
      </div>

      <div class="skillRefCat skillCatCounter">
        <div class="catTitle">Counter Skills</div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Value Decay</div>
          <div class="rule">
            Affects the opponent ONLY. Track their “same-length success streak”:
            increments only on successful words; resets to 1 when the next successful word has a different length.
            If streak ≥ 2: <b>score ×= max(0.40, 1.00 − step × (streak−1))</b>.
          </div>
            <table class="skillRefTable">
              <tr><th>Level</th><th>Decay step</th></tr>
              <tr><td>Lv1</td><td>6%</td></tr>
              <tr><td>Lv2</td><td>8%</td></tr>
              <tr><td>Lv3</td><td>10%</td></tr>
              <tr><td>Lv4</td><td>12%</td></tr>
              <tr><td>Lv5</td><td>15%</td></tr>
            </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Winner’s Footsteps (Gold tiles)</div>
          <div class="rule">
            Trigger: if the opponent finds a word, then on your <b>NEXT</b> turn gold tiles appear.
            Gold tiles are visible to both players and revert at the end of your turn.
            Gold placement: choose the required number of distinct tiles uniformly at random from all 36.
            If your found word uses ≥1 gold tile: add a flat bonus.
          </div>
          <table class="skillRefTable">
            <tr><th>Level</th><th>Max gold tiles</th><th>Gold bonus (flat)</th></tr>
            <tr><td>Lv1</td><td>1</td><td>+6</td></tr>
            <tr><td>Lv2</td><td>1</td><td>+10</td></tr>
            <tr><td>Lv3</td><td>2</td><td>+10</td></tr>
            <tr><td>Lv4</td><td>2</td><td>+15</td></tr>
            <tr><td>Lv5</td><td>3</td><td>+15</td></tr>
          </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Color Cancellation</div>
          <div class="rule">
            When you find a word, the opponent’s NEXT turn spawns fewer <b>special tiles</b>:
            GOLD (Winner’s Footsteps) and SILVER (Failure into Opportunity).
            Gray tiles are excluded from this reduction, and fountain tiles are never removed.
          </div>
          <table class="skillRefTable">
            <tr><th>Level</th><th>Reduction</th></tr>
            <tr><td>Lv1</td><td>−1 special tile</td></tr>
            <tr><td>Lv2</td><td>−1 (50% chance of −2)</td></tr>
            <tr><td>Lv3</td><td>−2</td></tr>
            <tr><td>Lv4</td><td>−2 (50% chance of −3)</td></tr>
            <tr><td>Lv5</td><td>−3</td></tr>
          </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Counter Skills Category Bonus (Gray tiles)</div>
          <div class="rule">
            On the opponent’s turn, visible gray tiles spawn (visible to both players).
            Gray tiles cannot be used in words (unusable). Gray is not reduced by Color Cancellation.
          </div>
          <table class="skillRefTable">
            <tr><th>Tier</th><th>Effect</th></tr>
            <tr><td>Tier 1</td><td>Opponent’s turn spawns 1 gray tile</td></tr>
            <tr><td>Tier 2</td><td>Opponent’s turn spawns 2 gray tiles</td></tr>
          </table>
        </div>
      </div>

      <div class="skillRefCat skillCatTech">
        <div class="catTitle">Technical Skills</div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Extra Chance</div>
          <div class="rule">
            After a failed attempt, you gain extra attempts (same turn).
            Failure still resets combo immediately. Extra attempts do NOT protect combo.
          </div>
          <table class="skillRefTable">
            <tr><th>Level</th><th>Extra attempts after a failure</th></tr>
            <tr><td>Lv1</td><td>+1</td></tr>
            <tr><td>Lv2</td><td>+2</td></tr>
            <tr><td>Lv3</td><td>+3</td></tr>
            <tr><td>Lv4</td><td>+4</td></tr>
            <tr><td>Lv5</td><td>+5</td></tr>
          </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Failure into Opportunity (Silver tiles)</div>
          <div class="rule">
            Trigger: on a failed attempt, the tiles you traced become the candidate set.
            Choose up to the max silver tiles uniformly at random from that traced set — those become silver for your NEXT turn.
            On your NEXT turn, if your successful word uses at least 2 silver tiles, apply the multiplier.
            Silver tiles revert at the end of that next turn.
          </div>
          <table class="skillRefTable">
            <tr><th>Level</th><th>Max silver tiles</th><th>Silver multiplier (if ≥2 used)</th></tr>
            <tr><td>Lv1</td><td>1</td><td>×1.5</td></tr>
            <tr><td>Lv2</td><td>1</td><td>×1.9</td></tr>
            <tr><td>Lv3</td><td>2</td><td>×1.9</td></tr>
            <tr><td>Lv4</td><td>2</td><td>×2.6</td></tr>
            <tr><td>Lv5</td><td>3</td><td>×2.6</td></tr>
          </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Self Investment</div>
          <div class="rule">
            End of each of your turns: lose points (score cannot go below 0).
            In exchange, words of length 5+ gain a multiplier (applied after combo).
          </div>
          <table class="skillRefTable">
            <tr><th>Level</th><th>Turn penalty</th><th>5+ letter multiplier</th></tr>
            <tr><td>Lv1</td><td>−3</td><td>×1.2</td></tr>
            <tr><td>Lv2</td><td>−5</td><td>×1.45</td></tr>
            <tr><td>Lv3</td><td>−7</td><td>×1.8</td></tr>
            <tr><td>Lv4</td><td>−10</td><td>×2.3</td></tr>
            <tr><td>Lv5</td><td>−14</td><td>×3.0</td></tr>
          </table>
        </div>

        <div class="skillRefItem">
          <div class="name"><span class="skillCatDot"></span>Technical Skills Category Bonus: Skill Destruction</div>
          <div class="rule">
            When you successfully find a word: reduce the level of a random opponent skill by 1.
            Skills at level 1 are never selected. Max once per turn.
          </div>
          <table class="skillRefTable">
            <tr><th>Tier</th><th>Activation chance</th></tr>
            <tr><td>Tier 1</td><td>50%</td></tr>
            <tr><td>Tier 2</td><td>100%</td></tr>
          </table>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function getAttemptsLeftDisplay(g){
  if (!g || !Number.isFinite(g.attempts)) return "0";
  const extra = Number.isFinite(g.extraChanceLeft) ? g.extraChanceLeft : 0;
  if (g.attempts <= 0 && extra <= 0) return "0";
  if (extra > 0) return `${g.attempts} + ${extra}`;
  return String(g.attempts);
}

function formatComboMultiplier(combo){
  const mult = comboMultiplier(combo);
  return `${mult.toFixed(2)}x`;
}
