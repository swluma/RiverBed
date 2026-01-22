import {
  SIZE, MIN_WORD_LEN, WIN_SCORE,
  EMBED_COUNT, EMBED_LONG_COUNT, EMBED_LONG_MINLEN,
  GEN_MAX_RESTARTS, GEN_TRIES_PER_WORD
} from "./config.js";

/**
 * RULES IMPLEMENTED EXACTLY AS GIVEN.
 * - No per-turn time limit.
 * - Attempts: base 1 each turn; release <3 letters does not consume.
 * - Turn ends on success OR attempts reach 0.
 * - Duplicate match-wide causes FAIL and consumes attempt.
 * - Scoring order EXACT per specification.
 * - Skills + category bonuses per specification.
 */

/* ------------------------
   Skill tables
------------------------ */

export const CATEGORIES = {
  POINT: "Point Skills",
  COUNTER: "Counter Skills",
  TECH: "Technical Skills",
};

export const SKILLS = {
  // Point
  POINT_INCREASE: { id:"POINT_INCREASE", cat:"POINT", name:"Point Increase", max:5 },
  POINT_ABSORB:   { id:"POINT_ABSORB",   cat:"POINT", name:"Point Absorption", max:5 },
  POINT_FOUNTAIN: { id:"POINT_FOUNTAIN", cat:"POINT", name:"Point Fountain",   max:5 },

  // Counter
  VALUE_DECAY:    { id:"VALUE_DECAY",    cat:"COUNTER", name:"Value Decay",         max:5 },
  WIN_FOOTSTEPS:  { id:"WIN_FOOTSTEPS",  cat:"COUNTER", name:"Winner’s Footsteps",  max:5 },
  COLOR_CANCEL:   { id:"COLOR_CANCEL",   cat:"COUNTER", name:"Color Cancellation",  max:5 },

  // Technical
  EXTRA_CHANCE:   { id:"EXTRA_CHANCE",   cat:"TECH", name:"Extra Chance",               max:5 },
  FAIL_OPP:       { id:"FAIL_OPP",       cat:"TECH", name:"Failure into Opportunity",  max:5 },
  SELF_INVEST:    { id:"SELF_INVEST",    cat:"TECH", name:"Self Investment",            max:5 },
};

const POINT_INCREASE_PCT = [0, 0.10, 0.18, 0.27, 0.38, 0.50];
const ABSORB_VALUE       = [0, 2, 4, 6, 8, 10];
const FOUNTAIN_BONUS     = [0, 5, 8, 12, 18, 25];

const DECAY_STEP         = [0, 0.06, 0.08, 0.10, 0.12, 0.15];

const GOLD_MAX_TILES     = [0, 1, 1, 2, 2, 3];
const GOLD_BONUS         = [0, 6, 10, 10, 15, 15];

const CANCEL_REDUCTION = (lv) => {
  // Lv1 −1
  // Lv2 −1 (50% chance of −2)
  // Lv3 −2
  // Lv4 −2 (50% chance of −3)
  // Lv5 −3
  if (lv <= 0) return 0;
  if (lv === 1) return 1;
  if (lv === 2) return (Math.random() < 0.5) ? 2 : 1;
  if (lv === 3) return 2;
  if (lv === 4) return (Math.random() < 0.5) ? 3 : 2;
  return 3;
};

const EXTRA_CHANCE_ADD   = [0, 1, 2, 3, 4, 5];

const SILVER_MAX_TILES   = [0, 1, 1, 2, 2, 3];
const SILVER_MULT        = [1, 1.5, 1.9, 1.9, 2.6, 2.6];

const INVEST_PENALTY     = [0, 3, 5, 7, 10, 14];
const INVEST_MULT        = [1, 1.2, 1.45, 1.8, 2.3, 3.0];

// Length table: total before combo/skills (already includes base)
const LEN_TABLE = (len) => {
  if (len === 3) return 8;
  if (len === 4) return 12;
  if (len === 5) return 18;
  if (len === 6) return 26;
  if (len === 7) return 36;
  if (len === 8) return 48;
  if (len === 9) return 62;
  return 78; // 10+
};

const COMBO_MULT = (combo) => {
  if (combo <= 0) return 1.0;
  if (combo === 1) return 1.00;
  if (combo === 2) return 1.05;
  if (combo === 3) return 1.15;
  if (combo === 4) return 1.30;
  if (combo === 5) return 1.50;
  if (combo === 6) return 1.75;
  return 2.00; // >=7 cap
};

function roundInt(x){
  // standard rounding, 0.5 up
  return Math.round(x);
}

function randInt(n){ return Math.floor(Math.random() * n); }
function shuffle(a){
  for (let i=a.length-1;i>0;i--){
    const j = randInt(i+1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDistinctIndices(count, max){
  const arr = Array.from({length:max}, (_,i)=>i);
  shuffle(arr);
  return arr.slice(0, Math.min(count, max));
}

function idxToRC(idx){
  return { r: Math.floor(idx / SIZE), c: idx % SIZE };
}

function neighbors8(idx){
  const {r,c} = idxToRC(idx);
  const out = [];
  for (let dr=-1; dr<=1; dr++){
    for (let dc=-1; dc<=1; dc++){
      if (dr===0 && dc===0) continue;
      const nr=r+dr, nc=c+dc;
      if (nr>=0 && nr<SIZE && nc>=0 && nc<SIZE){
        out.push(nr*SIZE+nc);
      }
    }
  }
  return out;
}

/* ------------------------
   Game State
------------------------ */

export function createNewGame(dictSet, dictWords, winScore = WIN_SCORE){
  const g = {
    dictSet,
    dictWords,
    board: null,              // letters array length 36
    embeddedWords: null,       // hidden list (never shown)
    foundWords: new Set(),     // match-wide duplicate rule
    log: [],                   // success-only entries

    turnNo: 1,
    active: 0, // 0=P1, 1=P2
    attempts: 1,
    extraChanceLeft: 0,
    gameOver: false,
    winScore: winScore,

    // Pending skill selection (after a turn ends, before next turn begins)
    skillSelect: {
      pending: false,
      chooser: null,
      nextActive: null,
      offers: null,
      autoAdvance: false,
    },

    // Turn-local tile states
    gold: new Set(),
    silver: new Set(),
    gray: new Set(),

    // Players
    players: [
      makePlayer(0),
      makePlayer(1),
    ],

    // Input tracking
    selection: [],        // indices in current swipe
    selectionSet: new Set(),
    selectionWord: "",
  };

  // Create a fixed field with embedded targets satisfying EXACT constraints
  const { letters, embedded } = generateFieldWithEmbeddedTargets(dictWords);
  g.board = letters;
  g.embeddedWords = embedded;

  // Start-of-turn tile spawns (gold/silver/gray)
  startTurn(g);

  return g;
}

function makePlayer(id){
  return {
    id,
    name: id===0 ? "Player 1" : "Player 2",
    color: id===0 ? "RED" : "BLUE",
    score: 0,
    combo: 0,

    // For Value Decay tracking (same-length success streak)
    sameLenStreak: 0,
    sameLenLast: 0,

    // Skills levels
    skills: {
      POINT_INCREASE: 0,
      POINT_ABSORB: 0,
      POINT_FOUNTAIN: 0,
      VALUE_DECAY: 0,
      WIN_FOOTSTEPS: 0,
      COLOR_CANCEL: 0,
      EXTRA_CHANCE: 0,
      FAIL_OPP: 0,
      SELF_INVEST: 0,
    },

    // Fountain tile index (single)
    fountainIdx: null,

    // Winner's Footsteps: triggered by opponent success -> on NEXT turn for this player
    pendingGoldTrigger: false,

    // Failure into Opportunity: selected tiles become silver for NEXT turn
    pendingSilver: new Set(),

    // Color Cancellation: reduction to apply on opponent's NEXT turn (special tiles only)
    imposeCancelOnOpponentNextTurn: 0,

    // Technical category bonus: skill destruction can happen max once per turn
    destroyedThisTurn: false,
  };
}

/* ------------------------
   Field generation with EXACT embedded rules
------------------------ */

function generateFieldWithEmbeddedTargets(dictWords){
  const poolShort = [];
  const poolLong = [];

  for (const w of dictWords){
    if (!/^[a-z]+$/.test(w)) continue;
    if (w.length < MIN_WORD_LEN) continue;
    if (w.length >= EMBED_LONG_MINLEN) poolLong.push(w);
    else poolShort.push(w);
  }

  const maxRestarts = GEN_MAX_RESTARTS;
  for (let attempt=0; attempt<maxRestarts; attempt++){
    const chosenLong = pickRandomDistinct(poolLong, EMBED_LONG_COUNT);
    const chosenShort = pickRandomDistinct(poolShort, EMBED_COUNT - EMBED_LONG_COUNT);
    if (chosenLong.length !== EMBED_LONG_COUNT || chosenShort.length !== (EMBED_COUNT-EMBED_LONG_COUNT)){
      continue;
    }
    const chosen = [...chosenLong, ...chosenShort];

    const letters = Array(SIZE*SIZE).fill(null);

    let okAll = true;
    for (const word of chosen){
      const ok = tryPlaceWordOnBoard(letters, word, GEN_TRIES_PER_WORD);
      if (!ok){ okAll = false; break; }
    }
    if (!okAll) continue;

    for (let i=0; i<letters.length; i++){
      if (letters[i] == null) letters[i] = randomLetter();
    }

    return { letters, embedded: chosen };
  }

  throw new Error("Field generation failed: could not embed required target words.");
}

function pickRandomDistinct(arr, n){
  if (arr.length < n) return [];
  const idxs = pickDistinctIndices(n, arr.length);
  return idxs.map(i => arr[i]);
}

function tryPlaceWordOnBoard(letters, word, maxTries){
  const L = word.length;
  const target = word.toUpperCase();

  for (let t=0; t<maxTries; t++){
    const start = randInt(SIZE*SIZE);
    if (!cellCanHold(letters, start, target[0])) continue;

    const path = [start];
    const used = new Set([start]);

    let ok = true;
    let cur = start;

    for (let i=1; i<L; i++){
      const opts = neighbors8(cur)
        .filter(n => !used.has(n))
        .filter(n => cellCanHold(letters, n, target[i]));

      if (opts.length === 0){ ok = false; break; }
      const nxt = opts[randInt(opts.length)];
      path.push(nxt);
      used.add(nxt);
      cur = nxt;
    }

    if (!ok) continue;

    for (let i=0; i<L; i++){
      const idx = path[i];
      if (letters[idx] == null) letters[idx] = target[i];
    }
    return true;
  }
  return false;

  function cellCanHold(letters, idx, ch){
    const cur = letters[idx];
    return (cur == null) || (cur === ch);
  }
}

const LETTER_FREQ = [
  ["E", 12.7], ["T", 9.1], ["A", 8.2], ["O", 7.5], ["I", 7.0], ["N", 6.7],
  ["S", 6.3], ["H", 6.1], ["R", 6.0], ["D", 4.3], ["L", 4.0], ["C", 2.8],
  ["U", 2.8], ["M", 2.4], ["W", 2.4], ["F", 2.2], ["G", 2.0], ["Y", 2.0],
  ["P", 1.9], ["B", 1.5], ["V", 1.0], ["K", 0.8], ["J", 0.15], ["X", 0.15],
  ["Q", 0.10], ["Z", 0.07],
];
const LETTER_TOTAL = LETTER_FREQ.reduce((s,[,w])=>s+w,0);
function randomLetter(){
  let x = Math.random() * LETTER_TOTAL;
  for (const [ch,w] of LETTER_FREQ){
    x -= w;
    if (x <= 0) return ch;
  }
  return "E";
}

/* ------------------------
   Turn start/end & spawns
------------------------ */

export function startTurn(g){
  if (g.gameOver) return;

  g.selection = [];
  g.selectionSet = new Set();
  g.selectionWord = "";

  g.attempts = 1;
  g.gold.clear();
  g.silver.clear();
  g.gray.clear();

  const ap = g.players[g.active];
  const op = g.players[1 - g.active];

  g.extraChanceLeft = EXTRA_CHANCE_ADD[ap.skills.EXTRA_CHANCE];

  // Counter category bonus: gray tiles on opponent's turn
  const opCounterTier = counterTier(op);
  const grayCount = (opCounterTier === 2) ? 2 : (opCounterTier === 1 ? 1 : 0);
  if (grayCount > 0){
    const idxs = pickDistinctIndices(grayCount, SIZE*SIZE);
    for (const i of idxs) g.gray.add(i);
  }

  // Winner's Footsteps gold
  let goldCount = 0;
  const wfLv = ap.skills.WIN_FOOTSTEPS;
  if (wfLv >= 1 && ap.pendingGoldTrigger){
    goldCount = GOLD_MAX_TILES[wfLv];
  }

  // Failure into Opportunity silver from pending
  let silverIndices = Array.from(ap.pendingSilver);
  ap.pendingSilver.clear();

  // Place gold uniformly random
  let goldIndices = [];
  if (goldCount > 0){
    goldIndices = pickDistinctIndices(goldCount, SIZE*SIZE);
  }

  // Color Cancellation reduction from opponent (special tiles only)
  const reduction = op.imposeCancelOnOpponentNextTurn || 0;
  op.imposeCancelOnOpponentNextTurn = 0;

  const union = new Set([...goldIndices, ...silverIndices]);
  const unionArr = Array.from(union);
  shuffle(unionArr);

  const removeCount = Math.min(reduction, unionArr.length);
  for (let i=0; i<removeCount; i++){
    union.delete(unionArr[i]);
  }

  for (const idx of goldIndices){
    if (union.has(idx)) g.gold.add(idx);
  }
  for (const idx of silverIndices){
    if (union.has(idx)) g.silver.add(idx);
  }

  ap.pendingGoldTrigger = false;
  ap.destroyedThisTurn = false;
}

export function endTurn(g, reason){
  if (g.gameOver) return;

  // End-of-turn revert: gold/silver/gray do NOT persist into skill selection
  g.gold.clear();
  g.silver.clear();
  g.gray.clear();

  const ap = g.players[g.active];

  // Self Investment penalty (end of your turn)
  const invLv = ap.skills.SELF_INVEST;
  if (invLv > 0){
    ap.score = Math.max(0, ap.score - INVEST_PENALTY[invLv]);
    if (checkVictory(g)) return;
  }

  // Point category bonus (end of your turn)
  const pTier = pointTier(ap);
  if (pTier === 1){
    ap.score += 8;
    if (checkVictory(g)) return;
  } else if (pTier === 2){
    ap.score += 15;
    if (checkVictory(g)) return;
  }

  // Skill selection happens BEFORE the next turn begins.
  // Keep g.active as the player who just ended their turn.
  const offers = computeSkillOffersForPlayer(ap);

  g.skillSelect.pending = true;
  g.skillSelect.chooser = g.active;
  g.skillSelect.nextActive = 1 - g.active;
  g.skillSelect.offers = offers;
  g.skillSelect.autoAdvance = (offers.length === 0);
}


/* ------------------------
   Swipe handling
------------------------ */

export function canSelectTile(g, idx){
  if (g.gray.has(idx)) return false;
  return true;
}

export function beginSwipe(g, idx){
  if (g.gameOver) return;
  if (!canSelectTile(g, idx)) return;
  g.selection = [idx];
  g.selectionSet = new Set([idx]);
  g.selectionWord = g.board[idx];
}

export function extendSwipe(g, idx){
  if (g.gameOver) return;
  if (!canSelectTile(g, idx)) return;
  if (g.selectionSet.has(idx)) return;

  const last = g.selection[g.selection.length - 1];
  if (!isAdjacent(last, idx)) return;

  g.selection.push(idx);
  g.selectionSet.add(idx);
  g.selectionWord += g.board[idx];
}

export function releaseSwipe(g){
  if (g.gameOver) return { type:"NOOP" };

  const len = g.selection.length;

  if (len < MIN_WORD_LEN){
    return { type:"NO_CONSUME_SHORT", len };
  }

  g.attempts -= 1;

  const word = g.selectionWord.toLowerCase();

  if (g.foundWords.has(word)){
    const result = handleFailure(g, { reason:"DUPLICATE", word });
    return { type:"FAIL_DUPLICATE", word, len, ...result };
  }

  if (!g.dictSet.has(word)){
    const result = handleFailure(g, { reason:"NOT_IN_DICT", word });
    return { type:"FAIL_INVALID", word, len, ...result };
  }

  const success = handleSuccess(g, word, len);
  return { type:"SUCCESS", word, len, ...success };
}

function isAdjacent(a, b){
  const ar = Math.floor(a / SIZE), ac = a % SIZE;
  const br = Math.floor(b / SIZE), bc = b % SIZE;
  const dr = Math.abs(ar - br), dc = Math.abs(ac - bc);
  return (dr <= 1 && dc <= 1 && !(dr === 0 && dc === 0));
}

/* ------------------------
   Failure handling
------------------------ */

function handleFailure(g, {reason, word}){
  const ap = g.players[g.active];

  ap.combo = 0;

  const foLv = ap.skills.FAIL_OPP;
  if (foLv >= 1){
    const maxSilver = SILVER_MAX_TILES[foLv];
    const candidates = Array.from(new Set(g.selection));
    shuffle(candidates);
    const chosen = candidates.slice(0, Math.min(maxSilver, candidates.length));
    ap.pendingSilver = new Set(chosen);
  } else {
    ap.pendingSilver = new Set();
  }

  const ecLv = ap.skills.EXTRA_CHANCE;
  if (ecLv > 0 && g.extraChanceLeft > 0){
    g.attempts += 1;
    g.extraChanceLeft -= 1;
  }

  const ended = (g.attempts <= 0);
  if (ended){
    endTurn(g, "OUT_OF_ATTEMPTS");
  }

  return { ended, reason };
}

/* ------------------------
   Success handling (SCORING ORDER EXACT)
------------------------ */

function handleSuccess(g, word, wordLen){
  const ap = g.players[g.active];
  const op = g.players[1 - g.active];

  ap.combo += 1;

  const baseLen = LEN_TABLE(wordLen);

  let score = baseLen * COMBO_MULT(ap.combo);

  const decayLv = op.skills.VALUE_DECAY;
  if (decayLv > 0){
    if (ap.sameLenLast === wordLen) ap.sameLenStreak += 1;
    else ap.sameLenStreak = 1;
    ap.sameLenLast = wordLen;

    if (ap.sameLenStreak >= 2){
      const step = DECAY_STEP[decayLv];
      const decayMult = Math.max(0.40, 1.00 - step * (ap.sameLenStreak - 1));
      score *= decayMult;
    }
  } else {
    if (ap.sameLenLast === wordLen) ap.sameLenStreak += 1;
    else ap.sameLenStreak = 1;
    ap.sameLenLast = wordLen;
  }

  const piLv = ap.skills.POINT_INCREASE;
  if (piLv > 0){
    score *= (1 + POINT_INCREASE_PCT[piLv]);
  }

  const invLv = ap.skills.SELF_INVEST;
  if (invLv > 0 && wordLen >= 5){
    score *= INVEST_MULT[invLv];
  }

  const foLv = ap.skills.FAIL_OPP;
  const usedSilverCount = countOverlap(g.selectionSet, g.silver);
  if (foLv > 0 && usedSilverCount >= 2){
    score *= SILVER_MULT[foLv];
  }

  const pfLv = ap.skills.POINT_FOUNTAIN;
  const usedFountainSelf = (ap.fountainIdx != null && g.selectionSet.has(ap.fountainIdx));
  if (pfLv > 0 && usedFountainSelf){
    score += FOUNTAIN_BONUS[pfLv];
  }

  const wfLv = ap.skills.WIN_FOOTSTEPS;
  const usedGold = countOverlap(g.selectionSet, g.gold) >= 1;
  if (wfLv > 0 && usedGold){
    score += GOLD_BONUS[wfLv];
  }

  const finalWordPoints = roundInt(score);
  let fountainShared = 0;

  const paLv = ap.skills.POINT_ABSORB;
  if (paLv > 0){
    const stolen = ABSORB_VALUE[paLv];
    op.score = Math.max(0, op.score - stolen);
    ap.score += stolen;
    if (checkVictory(g)) return { ended:true, finalWordPoints, endedByVictory:true };
  }

  const usedOpponentFountain = (op.fountainIdx != null && g.selectionSet.has(op.fountainIdx));
  if (usedOpponentFountain){
    const opponentBonus = roundInt(finalWordPoints * 0.5);
    fountainShared = opponentBonus;
    op.score += opponentBonus;
    if (checkVictory(g)) return { ended:true, finalWordPoints, endedByVictory:true };
  }

  ap.score += finalWordPoints;
  if (checkVictory(g)) return { ended:true, finalWordPoints, endedByVictory:true };

  g.foundWords.add(word);
  g.log.push({
    word,
    player: ap.id,
    pts: finalWordPoints,
    shared: fountainShared,
  });

  if (pfLv > 0){
    const lastIdx = g.selection[g.selection.length - 1];
    ap.fountainIdx = lastIdx;
  }

  if (op.skills.WIN_FOOTSTEPS >= 1){
    op.pendingGoldTrigger = true;
  }

  const ccLv = ap.skills.COLOR_CANCEL;
  if (ccLv >= 1){
    op.imposeCancelOnOpponentNextTurn = CANCEL_REDUCTION(ccLv);
  }

  attemptSkillDestruction(g);

  g.attempts = 0;

  endTurn(g, "SUCCESS");

  return { ended:true, finalWordPoints, endedByVictory:false };
}

function countOverlap(setA, setB){
  let n=0;
  for (const x of setA) if (setB.has(x)) n++;
  return n;
}

/* ------------------------
   Category bonuses
------------------------ */

export function pointTier(p){
  const total =
    p.skills.POINT_INCREASE +
    p.skills.POINT_ABSORB +
    p.skills.POINT_FOUNTAIN;

  if (total >= 6) return 2;
  if (total >= 3) return 1;
  return 0;
}

export function counterTier(p){
  const total =
    p.skills.VALUE_DECAY +
    p.skills.WIN_FOOTSTEPS +
    p.skills.COLOR_CANCEL;

  if (total >= 6) return 2;
  if (total >= 3) return 1;
  return 0;
}

export function techTier(p){
  const total =
    p.skills.EXTRA_CHANCE +
    p.skills.FAIL_OPP +
    p.skills.SELF_INVEST;

  if (total >= 6) return 2;
  if (total >= 3) return 1;
  return 0;
}

function attemptSkillDestruction(g){
  const ap = g.players[g.active];
  const op = g.players[1 - g.active];

  if (ap.destroyedThisTurn) return;

  const tTier = techTier(ap);
  if (tTier === 0) return;

  const chance = (tTier === 1) ? 0.5 : 1.0;
  if (Math.random() > chance) return;

  const reducible = [];
  for (const k of Object.keys(op.skills)){
    if (op.skills[k] >= 2) reducible.push(k);
  }
  if (reducible.length === 0) return;

  const chosen = reducible[randInt(reducible.length)];
  op.skills[chosen] -= 1;
  ap.destroyedThisTurn = true;
}

/* ------------------------
   Skill selection
------------------------ */

function computeSkillOffersForPlayer(p){
  const offers = [];
  for (const cat of ["POINT","COUNTER","TECH"]){
    const skillsInCat = Object.values(SKILLS).filter(s => s.cat === cat);
    const available = skillsInCat.filter(s => p.skills[s.id] < s.max);
    if (available.length === 0) continue;
    const pick = available[randInt(available.length)];
    offers.push(pick);
  }
  return offers;
}

function advanceTurnNow(g){
  const next = (g.skillSelect && g.skillSelect.nextActive != null)
    ? g.skillSelect.nextActive
    : (1 - g.active);

  if (g.skillSelect){
    g.skillSelect.pending = false;
    g.skillSelect.chooser = null;
    g.skillSelect.nextActive = null;
    g.skillSelect.offers = null;
    g.skillSelect.autoAdvance = false;
  }

  g.active = next;
  g.turnNo += 1;
  startTurn(g);
}

export function getSkillOffers(g){
  // If a turn has ended, offers are cached for that player.
  if (g.skillSelect && g.skillSelect.pending){
    const offers = g.skillSelect.offers || [];

    // If the player has no available skills (all maxed), skip selection entirely.
    // We still must NOT open the modal for the next player, so return [] once,
    // and advance to the next turn immediately.
    if (g.skillSelect.autoAdvance && offers.length === 0){
      advanceTurnNow(g);
      return [];
    }
    return offers;
  }

  // Fallback (should rarely happen): compute for current active.
  return computeSkillOffersForPlayer(g.players[g.active]);
}

export function upgradeSkill(g, skillId){
  const ap = g.players[g.active];
  if (!(skillId in ap.skills)) return false;
  const meta = SKILLS[skillId];
  if (!meta) return false;
  if (ap.skills[skillId] >= meta.max) return false;

  ap.skills[skillId] += 1;

  // After the active player chooses a skill, the next turn begins.
  if (g.skillSelect && g.skillSelect.pending){
    advanceTurnNow(g);
  }

  return true;
}


/* ------------------------
   Victory check
------------------------ */

export function checkVictory(g){
  const p1 = g.players[0];
  const p2 = g.players[1];
  const target = (g && Number.isFinite(g.winScore)) ? g.winScore : WIN_SCORE;
  if (p1.score >= target || p2.score >= target){
    g.gameOver = true;
    return true;
  }
  return false;
}

export function setWinScore(g, winScore){
  if (!g) return false;
  g.winScore = winScore;
  const p1 = g.players[0];
  const p2 = g.players[1];
  const ended = (p1.score >= winScore || p2.score >= winScore);
  g.gameOver = ended;
  return ended;
}

/* ------------------------
   Skill detailed descriptions for UI
------------------------ */


export function describeSkillCompact(p, skillId){
  const lv = p.skills[skillId];

  switch(skillId){
    case "POINT_INCREASE":
      return `×${(1+POINT_INCREASE_PCT[lv]).toFixed(2)} (+${Math.round(POINT_INCREASE_PCT[lv]*100)}%)`;
    case "POINT_ABSORB":
      return `steal ${ABSORB_VALUE[lv]} pts`;
    case "POINT_FOUNTAIN":
      return `self +${FOUNTAIN_BONUS[lv]} / opponent share 50%`;
    case "VALUE_DECAY":
      return `step ${DECAY_STEP[lv].toFixed(2)} (min ×0.40)`;
    case "WIN_FOOTSTEPS":
      return `gold max ${GOLD_MAX_TILES[lv]}, +${GOLD_BONUS[lv]} if used`;
    case "COLOR_CANCEL":
      if (lv===1) return `−1 special tile`;
      if (lv===2) return `−1 (50% −2)`;
      if (lv===3) return `−2`;
      if (lv===4) return `−2 (50% −3)`;
      return `−3`;
    case "EXTRA_CHANCE":
      return `+${EXTRA_CHANCE_ADD[lv]} attempts after fail`;
    case "FAIL_OPP":
      return `silver max ${SILVER_MAX_TILES[lv]}, ×${SILVER_MULT[lv].toFixed(1)} if ≥2 used`;
    case "SELF_INVEST":
      return `-${INVEST_PENALTY[lv]}/turn, 5+ ×${INVEST_MULT[lv].toFixed(2)}`;
    default:
      return `Lv${lv}`;
  }
}

export function describeSkill(p, skillId){
  const lv = p.skills[skillId];

  switch(skillId){
    case "POINT_INCREASE": {
      const pct = Math.round(POINT_INCREASE_PCT[lv] * 100);
      return `Lv${lv}/5 — After combo (and after Value Decay if it applies): multiply your word’s Base+Length score by ×${(1+POINT_INCREASE_PCT[lv]).toFixed(2)} (+${pct}%).`;
    }
    case "POINT_ABSORB": {
      const steal = ABSORB_VALUE[lv];
      return `Lv${lv}/5 — On every successful word: steal ${steal} points from the opponent (opponent score can’t go below 0). This happens AFTER your word’s final points are computed, and BEFORE those word points are added.`;
    }
    case "POINT_FOUNTAIN": {
      const bonus = FOUNTAIN_BONUS[lv];
      return `Lv${lv}/5 — When you find a word, the LAST tile becomes your Fountain (only 1 at a time; new replaces old). Using YOUR Fountain in a later word adds +${bonus} flat points. If the OPPONENT uses your Fountain in a word, you gain 50% of that word’s FINAL points (rounded), and the opponent still keeps full word points.`;
    }
    case "VALUE_DECAY": {
      const step = DECAY_STEP[lv];
      return `Lv${lv}/5 — Affects the opponent ONLY. Track opponent’s “same-length success streak” (counts only on their successful words; resets to 1 if length changes). If streak ≥2, multiply their score by max(0.40, 1.00 − ${step.toFixed(2)} × (streak−1)). Applied after combo, before their own multipliers.`;
    }
    case "WIN_FOOTSTEPS": {
      const maxGold = GOLD_MAX_TILES[lv];
      const bonus = GOLD_BONUS[lv];
      return `Lv${lv}/5 — Trigger: if the opponent finds a word, then on YOUR NEXT turn spawn up to ${maxGold} visible GOLD tiles (uniform random among all 36). If your found word uses ≥1 gold tile: add +${bonus} flat points. Gold tiles are visible to both players and disappear at the end of your turn.`;
    }
    case "COLOR_CANCEL": {
      return `Lv${lv}/5 — When you find a word, the opponent’s NEXT turn spawns fewer “special tiles” (GOLD from Winner’s Footsteps and SILVER from Failure into Opportunity). Gray tiles are NOT reduced, and Fountain tiles are never removed. Reduction: Lv1 −1, Lv2 −1 (50% chance −2), Lv3 −2, Lv4 −2 (50% chance −3), Lv5 −3.`;
    }
    case "EXTRA_CHANCE": {
      const add = EXTRA_CHANCE_ADD[lv];
      return `Lv${lv}/5 — After a failed attempt (invalid word / duplicate / not in dictionary): immediately gain +${add} extra attempts for the SAME turn. IMPORTANT: the failure still consumes the attempt and ALWAYS resets combo; extra attempts do NOT protect combo.`;
    }
    case "FAIL_OPP": {
      const maxS = SILVER_MAX_TILES[lv];
      const mult = SILVER_MULT[lv];
      return `Lv${lv}/5 — Trigger on failure: from the tiles you traced in that failed attempt, choose up to ${maxS} uniformly at random; those become SILVER on your NEXT turn. On that next turn, if your successful word uses ≥2 silver tiles, multiply that word’s score by ×${mult.toFixed(1)}. Silver tiles are visible and disappear at the end of that next turn.`;
    }
    case "SELF_INVEST": {
      const lose = INVEST_PENALTY[lv];
      const mult = INVEST_MULT[lv];
      return `Lv${lv}/5 — End of each of YOUR turns: lose ${lose} points (score can’t go below 0). In return, for words of length 5+ you multiply your score by ×${mult.toFixed(2)} (applied after combo and after Point Increase, if you have it).`;
    }
    default:
      return `Lv${lv}/5`;
  }
}

export function describeOffer(p, skillMeta){
  const id = skillMeta.id;
  const lv = p.skills[id];
  const next = Math.min(lv + 1, 5);

  const catLabel =
    skillMeta.cat === "POINT" ? "Point Skill" :
    skillMeta.cat === "COUNTER" ? "Counter Skill" :
    "Technical Skill";

  let effect = "";
  switch(id){
    case "POINT_INCREASE": effect = `Next: ×${(1+POINT_INCREASE_PCT[next]).toFixed(2)} (+${Math.round(POINT_INCREASE_PCT[next]*100)}%)`; break;
    case "POINT_ABSORB":   effect = `Next: steal ${ABSORB_VALUE[next]} pts on success`; break;
    case "POINT_FOUNTAIN": effect = `Next: self-use +${FOUNTAIN_BONUS[next]} pts`; break;
    case "VALUE_DECAY":    effect = `Next: decay step ${DECAY_STEP[next].toFixed(2)} (min ×0.40)`; break;
    case "WIN_FOOTSTEPS":  effect = `Next: max gold ${GOLD_MAX_TILES[next]}, gold bonus +${GOLD_BONUS[next]}`; break;
    case "COLOR_CANCEL":   effect = `Next: stronger reduction`; break;
    case "EXTRA_CHANCE":   effect = `Next: +${EXTRA_CHANCE_ADD[next]} attempts after failure`; break;
    case "FAIL_OPP":       effect = `Next: max silver ${SILVER_MAX_TILES[next]}, silver mult ×${SILVER_MULT[next].toFixed(1)}`; break;
    case "SELF_INVEST":    effect = `Next: -${INVEST_PENALTY[next]} / turn, 5+ ×${INVEST_MULT[next].toFixed(2)}`; break;
  }

  return { catLabel, effect };
}
