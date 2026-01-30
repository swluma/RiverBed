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
  POINT_FOUNTAIN: { id:"POINT_FOUNTAIN", cat:"POINT", name:"Point Fountain",   max:5 },
  FAIL_OPP:       { id:"FAIL_OPP",       cat:"POINT", name:"Failure into Opportunity",  max:5 },
  SAFETY_NET:     { id:"SAFETY_NET",     cat:"TECH",  name:"Safety Net",             max:5 },

  // Counter
  VALUE_DECAY:    { id:"VALUE_DECAY",    cat:"COUNTER", name:"Value Decay",         max:5 },
  WIN_FOOTSTEPS:  { id:"WIN_FOOTSTEPS",  cat:"COUNTER", name:"Winner’s Footsteps",  max:5 },
  COLOR_CANCEL:   { id:"COLOR_CANCEL",   cat:"COUNTER", name:"Color Cancellation",  max:5 },

  // Technical
  EXTRA_CHANCE:   { id:"EXTRA_CHANCE",   cat:"TECH", name:"Extra Chance",               max:5 },
  SPELL_FINDER:   { id:"SPELL_FINDER",   cat:"TECH", name:"Spell Finder",               max:5 },
};

const POINT_INCREASE_PCT = [0, 0.05, 0.08, 0.12, 0.15, 0.20];
  const FOUNTAIN_BONUS     = [0, 3, 5, 10, 15, 20];

const DECAY_STEP         = [0, 0.05, 0.08, 0.12, 0.15, 0.20];
const DECAY_MIN_MULT     = [1, 0.75, 0.60, 0.40, 0.25, 0.00];
const DECAY_MAX_DECAY_PCT = DECAY_MIN_MULT.map(m => Math.round((1 - m) * 100));

const GOLD_MAX_TILES     = [0, 1, 1, 2, 2, 3];
  const GOLD_BONUS         = [0, 6, 10, 10, 15, 20];

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

const WHITE_MAX_TILES   = [0, 2, 3, 3, 4, 6];
const WHITE_MULT        = [1, 1.3, 1.5, 1.7, 1.85, 2.0];

const SAFETY_NET_POINTS  = [0, 3, 5, 8, 10, 15];

const SPELL_FINDER_MINLENS = [0, 3, 3, 4, 5, 6];
const SPELL_FINDER_BASE_HINT_TILES = [0, 1, 2, 2, 2, 2];

const clampSpellFinderLv = (lv) => {
  if (!Number.isFinite(lv)) return 0;
  return Math.max(0, Math.min(lv, SPELL_FINDER_MINLENS.length - 1));
};

const SPELL_FINDER_MINLEN = (lv) => SPELL_FINDER_MINLENS[clampSpellFinderLv(lv)] ?? 0;
const SPELL_FINDER_HINT_TILES = (lv) => SPELL_FINDER_BASE_HINT_TILES[clampSpellFinderLv(lv)] ?? 0;

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
  if (combo === 1) return 1.03;
  if (combo === 2) return 1.06;
  if (combo === 3) return 1.10;
  if (combo === 4) return 1.14;
  if (combo === 5) return 1.18;
  if (combo === 6) return 1.22;
  return 1.35; // >=7 cap
};

export function comboMultiplier(combo){
  return COMBO_MULT(combo);
}

function roundInt(x){
  // standard rounding, 0.5 up
  return Math.round(x);
}

function formatWhiteMult(mult){
  const s = mult.toFixed(2);
  if (s.endsWith(".00")) return s.slice(0, -3);
  if (s.endsWith("0")) return s.slice(0, -1);
  return s;
}

function randInt(n){ return Math.floor(Math.random() * n); }
function shuffle(a){
  for (let i=a.length-1;i>0;i--){
    const j = randInt(i+1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function shuffleBoard(g){
  if (!g || !Array.isArray(g.board)) return false;
  shuffle(g.board);
  g.embeddedWords = [];
  clearSelection(g);
  g.pendingConfirm = false;
  if (g.hint){
    g.hint.usedThisTurn = false;
    g.hint.tiles.clear();
    g.hint.word = null;
  }
  if (g.players){
    for (const p of g.players){
      clearSpellFinder(p);
    }
  }
  return true;
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

function neighbors4(idx){
  const {r,c} = idxToRC(idx);
  const out = [];
  if (r > 0) out.push((r-1)*SIZE + c);
  if (r < SIZE-1) out.push((r+1)*SIZE + c);
  if (c > 0) out.push(r*SIZE + (c-1));
  if (c < SIZE-1) out.push(r*SIZE + (c+1));
  return out;
}

/* ------------------------
   Game State
------------------------ */

export function createNewGame(dictSet, dictWords, embedWords, winScore = WIN_SCORE, initialSkills = null){
  const g = {
    dictSet,
    dictWords,
    commonWords: Array.isArray(embedWords) && embedWords.length > 0 ? embedWords : dictWords,
    board: null,              // letters array length 36
    embeddedWords: null,       // hidden list (never shown)
    foundWords: new Set(),     // match-wide duplicate rule
    log: [],                   // success + event entries
    pointLog: [],              // skill-triggered point bonuses

    turnNo: 1,
    active: 0, // 0=P1, 1=P2
    attempts: 1,
    extraChanceLeft: 0,
    gameOver: false,
    winScore: winScore,
    timeLimits: [0, 0],

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
    white: new Set(),
    gray: new Set(),
    purple: new Set(),

    // Hint state (per turn)
    hint: {
      usedThisTurn: false,
      tiles: new Set(),
      word: null,
    },

    // Players
    players: [
      makePlayer(0),
      makePlayer(1),
    ],

    // Input tracking
    selection: [],        // indices in current swipe
    selectionSet: new Set(),
    selectionWord: "",
    pendingConfirm: false,
  };

  applyInitialSkills(g, initialSkills);

  // Create a fixed field with embedded targets satisfying EXACT constraints
  const embedPool = (embedWords && embedWords.length > 0) ? embedWords : dictWords;
  let attempts = 0;
  let generated = null;
  while (!generated){
    const extraTen = pickRandomWordOfLength(dictWords, 10);
    const required = extraTen ? [extraTen] : [];
    try {
      generated = generateFieldWithEmbeddedTargets(embedPool, required);
    } catch (err){
      attempts += 1;
      console.warn(`[boggle] field generation failed (retry ${attempts})`, err);
    }
  }
  const { letters, embedded } = generated;
  g.board = letters;
  g.embeddedWords = embedded;
  console.log("[boggle] embedded words:", embedded.join(", "));

  updateDecaySteps(g);

  // Start-of-turn tile spawns (gold/white/gray)
  startTurn(g);

  return g;
}

function applyInitialSkills(g, initialSkills){
  if (!g || !initialSkills) return;
  const norm = normalizeInitialSkills(initialSkills);
  for (const id of Object.keys(SKILLS)){
    g.players[0].skills[id] = norm.p1[id];
    g.players[1].skills[id] = norm.p2[id];
  }
}

function normalizeInitialSkills(initialSkills){
  const out = { p1: {}, p2: {} };
  for (const [id, meta] of Object.entries(SKILLS)){
    const max = meta?.max ?? 5;
    const p1Raw = Number.parseInt(initialSkills?.p1?.[id], 10);
    const p2Raw = Number.parseInt(initialSkills?.p2?.[id], 10);
    out.p1[id] = Number.isFinite(p1Raw) ? Math.max(0, Math.min(max, p1Raw)) : 0;
    out.p2[id] = Number.isFinite(p2Raw) ? Math.max(0, Math.min(max, p2Raw)) : 0;
  }
  return out;
}

function makePlayer(id){
  return {
    id,
    name: id===0 ? "Player 1" : "Player 2",
    color: id===0 ? "RED" : "BLUE",
    score: 0,
    combo: 0,
    decayStepPct: 0,
    decaySteps: 0,
    lastWordTiles: new Set(),

    // Skills levels
    skills: {
      POINT_INCREASE: 0,
      POINT_FOUNTAIN: 0,
      VALUE_DECAY: 0,
      WIN_FOOTSTEPS: 0,
      COLOR_CANCEL: 0,
      EXTRA_CHANCE: 0,
      FAIL_OPP: 0,
      SAFETY_NET: 0,
      SPELL_FINDER: 0,
    },

    // Fountain tile index (single)
    fountainIdx: null,

  // Winner's Footsteps: triggered by opponent success -> on NEXT turn for this player
  pendingGoldTrigger: false,

    // Failure into Opportunity: when a turn ends without finding any word, random board tiles become white for NEXT turn
    pendingWhiteCount: 0,
    lastFailedTiles: new Set(),

    // Color Cancellation: reduction to apply on opponent's NEXT turn (special tiles + fountain)
    imposeCancelOnOpponentNextTurn: 0,

    hasFoundWordThisTurn: false,
    safetyNetUsed: false,
    failedSwipeThisTurn: false,

    // Spell Finder: fixed target + hint tiles
    spellFinder: {
      word: null,
      path: [],
      tiles: new Set(),
      tileLimitThisTurn: null,
    },
  };
}

function effectiveDecayPctFor(player, opponent){
  return decayEffectDetails(player, opponent).pct;
}

function decayEffectDetails(player, opponent){
  const decayLv = opponent.skills.VALUE_DECAY || 0;
  const steps = player.decaySteps || 0;
  if (decayLv <= 0 || steps <= 0) return { multiplier: 1, pct: 0 };
  const step = DECAY_STEP[decayLv] || 0;
  const minMult = DECAY_MIN_MULT[decayLv] ?? 0;
  const multiplier = Math.max(minMult, 1 - step * steps);
  const pct = Math.round((1 - multiplier) * 100);
  return { multiplier, pct };
}

function updateDecaySteps(g){
  if (!g || !g.players || g.players.length < 2) return;
  const p1 = g.players[0];
  const p2 = g.players[1];
  p1.decayStepPct = effectiveDecayPctFor(p1, p2);
  p2.decayStepPct = effectiveDecayPctFor(p2, p1);
}

/* ------------------------
   Field generation with EXACT embedded rules
------------------------ */

function generateFieldWithEmbeddedTargets(dictWords, requiredWords = []){
  const poolShort = [];
  const poolLong = [];

  const requiredSet = new Set(
    (requiredWords || [])
      .map(w => String(w || "").toLowerCase())
      .filter(w => /^[a-z]+$/.test(w))
      .filter(w => w.length >= MIN_WORD_LEN)
  );

  for (const w of dictWords){
    if (!/^[a-z]+$/.test(w)) continue;
    if (w.length < MIN_WORD_LEN) continue;
    if (requiredSet.has(w)) continue;
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
    const chosen = [...requiredSet, ...chosenLong, ...chosenShort];

    const letters = Array(SIZE*SIZE).fill(null);

    let okAll = true;
    for (const word of chosen){
      const ok = tryPlaceWordOnBoard(letters, word, GEN_TRIES_PER_WORD);
      if (!ok){ okAll = false; break; }
    }
    if (!okAll) continue;

    for (let i=0; i<letters.length; i++){
      if (letters[i] == null) letters[i] = randomLetterNoOrthAdjacency(letters, i);
    }

    return { letters, embedded: chosen };
  }

  throw new Error("Field generation failed: could not embed required target words.");
}

function pickRandomWordOfLength(words, len){
  if (!Array.isArray(words) || words.length === 0) return null;
  const matches = [];
  for (const w of words){
    if (typeof w !== "string") continue;
    if (w.length !== len) continue;
    if (!/^[a-z]+$/.test(w)) continue;
    matches.push(w);
  }
  if (matches.length === 0) return null;
  return matches[randInt(matches.length)];
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
    const planned = new Map();
    if (!canPlaceLetterAt(letters, start, target[0], planned)) continue;

    const path = [start];
    const used = new Set([start]);
    planned.set(start, target[0]);

    let ok = true;
    let cur = start;

    for (let i=1; i<L; i++){
      const opts = neighbors8(cur)
        .filter(n => !used.has(n))
        .filter(n => canPlaceLetterAt(letters, n, target[i], planned));

      if (opts.length === 0){ ok = false; break; }
      const nxt = opts[randInt(opts.length)];
      path.push(nxt);
      used.add(nxt);
      planned.set(nxt, target[i]);
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
}

function canPlaceLetterAt(letters, idx, ch, planned){
  const cur = letters[idx];
  if (cur != null && cur !== ch) return false;

  const ortho = neighbors4(idx);
  for (const n of ortho){
    const existing = letters[n];
    if (existing === ch) return false;
    if (planned && planned.get(n) === ch) return false;
  }

  return true;
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

function randomLetterNoOrthAdjacency(letters, idx){
  const disallowed = new Set();
  for (const n of neighbors4(idx)){
    const ch = letters[n];
    if (ch != null) disallowed.add(ch);
  }

  const candidates = LETTER_FREQ
    .map(([ch]) => ch)
    .filter(ch => !disallowed.has(ch));

  if (candidates.length === 0) return randomLetter();

  let total = 0;
  const weights = candidates.map((ch) => {
    const w = LETTER_FREQ.find(([c]) => c === ch)[1];
    total += w;
    return [ch, w];
  });

  let x = Math.random() * total;
  for (const [ch, w] of weights){
    x -= w;
    if (x <= 0) return ch;
  }
  return candidates[0];
}

/* ------------------------
   Turn start/end & spawns
------------------------ */

export function startTurn(g){
  if (g.gameOver) return;

  clearSelection(g);
  g.pendingConfirm = false;

  if (g.hint){
    g.hint.usedThisTurn = false;
    g.hint.tiles.clear();
    g.hint.word = null;
  }

  g.attempts = 1;
  g.gold.clear();
  g.white.clear();
  g.gray.clear();

  const ap = g.players[g.active];
  const op = g.players[1 - g.active];
  g.purple.clear();
  if (op && (op.skills.VALUE_DECAY || 0) > 0 && ap.lastWordTiles){
    for (const idx of ap.lastWordTiles){
      if (Number.isInteger(idx) && idx >= 0 && idx < SIZE * SIZE){
        g.purple.add(idx);
      }
    }
  }
  ap.hasFoundWordThisTurn = false;
  ap.safetyNetUsed = false;
  ap.failedSwipeThisTurn = false;
  if (ap.spellFinder){
    ap.spellFinder.tileLimitThisTurn = null;
  }

  g.extraChanceLeft = EXTRA_CHANCE_ADD[ap.skills.EXTRA_CHANCE];

  // Counter category bonus: gray tiles on opponent's turn
  const opCounterTier = counterTier(op);
  const grayCount = (opCounterTier === 2) ? 4 : (opCounterTier === 1 ? 2 : 0);
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

  // Failure into Opportunity white from pending (prioritize last failed swipe tiles)
  const whiteCount = ap.pendingWhiteCount || 0;
  ap.pendingWhiteCount = 0;
  let whiteIndices = [];
  if (whiteCount > 0){
    const chosen = [];
    const chosenSet = new Set();
    for (const idx of ap.lastFailedTiles){
      if (chosenSet.size >= whiteCount) break;
      if (!Number.isInteger(idx) || idx < 0 || idx >= SIZE * SIZE) continue;
      if (chosenSet.has(idx)) continue;
      chosenSet.add(idx);
      chosen.push(idx);
    }
    if (chosenSet.size < whiteCount){
      const needed = whiteCount - chosenSet.size;
      const available = [];
      for (let i=0; i<SIZE * SIZE; i++){
        if (chosenSet.has(i)) continue;
        available.push(i);
      }
      shuffle(available);
      for (let i=0; i<needed && i<available.length; i++){
        chosenSet.add(available[i]);
        chosen.push(available[i]);
      }
    }
    whiteIndices = chosen;
  }
  ap.lastFailedTiles.clear();

  // Place gold uniformly random
  let goldIndices = [];
  if (goldCount > 0){
    goldIndices = pickDistinctIndices(goldCount, SIZE*SIZE);
  }

  // Color Cancellation reduction targeting this player (special tiles + fountain)
  const reduction = ap.imposeCancelOnOpponentNextTurn || 0;
  ap.imposeCancelOnOpponentNextTurn = 0;

  updateSpellFinderForPlayer(g, g.active);
  const spellTiles = ap.spellFinder?.tiles ? Array.from(ap.spellFinder.tiles) : [];
  const union = new Set([...goldIndices, ...whiteIndices, ...spellTiles]);
  const unionArr = Array.from(union);
  shuffle(unionArr);

  const removeCount = Math.min(reduction, unionArr.length);
  for (let i=0; i<removeCount; i++){
    union.delete(unionArr[i]);
  }

  for (const idx of goldIndices){
    if (union.has(idx)) g.gold.add(idx);
  }
  for (const idx of whiteIndices){
    if (union.has(idx)) g.white.add(idx);
  }

  if (ap.spellFinder && ap.spellFinder.tiles){
    const kept = new Set();
    for (const idx of ap.spellFinder.tiles){
      if (union.has(idx)) kept.add(idx);
    }
    ap.spellFinder.tiles = kept;
    ap.spellFinder.tileLimitThisTurn = kept.size;
  }

  if (reduction > 0 && ap.fountainIdx != null){
    ap.fountainIdx = null;
  }

  ap.pendingGoldTrigger = false;
}

export function endTurn(g, reason){
  if (g.gameOver) return;

  tryActivateSafetyNet(g);

  clearSelection(g);
  g.pendingConfirm = false;

  // End-of-turn revert: gold/white/gray do NOT persist into skill selection
  g.gold.clear();
  g.white.clear();
  g.gray.clear();
  if (g.hint){
    g.hint.tiles.clear();
    g.hint.word = null;
    g.hint.usedThisTurn = false;
  }

  const ap = g.players[g.active];
  applyTechTierBonus(g);
  if (g.gameOver) return;

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
  g.pendingConfirm = false;
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
    clearSelection(g);
    g.pendingConfirm = false;
    return { type:"NO_CONSUME_SHORT", len };
  }

  g.pendingConfirm = true;
  return { type:"PENDING", len, word: g.selectionWord };
}

export function confirmSwipe(g){
  if (g.gameOver) return { type:"NOOP" };
  if (!g.pendingConfirm) return { type:"NO_PENDING" };

  const len = g.selection.length;
  if (len < MIN_WORD_LEN){
    clearSelection(g);
    g.pendingConfirm = false;
    return { type:"NO_CONSUME_SHORT", len };
  }

  g.pendingConfirm = false;
  consumeAttempt(g);

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

function clearSelection(g){
  g.selection = [];
  g.selectionSet = new Set();
  g.selectionWord = "";
}

function isAdjacent(a, b){
  const ar = Math.floor(a / SIZE), ac = a % SIZE;
  const br = Math.floor(b / SIZE), bc = b % SIZE;
  const dr = Math.abs(ar - br), dc = Math.abs(ac - bc);
  return (dr <= 1 && dc <= 1 && !(dr === 0 && dc === 0));
}

function consumeAttempt(g){
  if (g.attempts > 0){
    g.attempts -= 1;
    return;
  }
  if (g.extraChanceLeft > 0){
    g.extraChanceLeft -= 1;
  }
}

/* ------------------------
   Failure handling
------------------------ */

export function timeoutTurn(g){
  if (g.gameOver) return { type:"NOOP" };
  clearSelection(g);
  g.pendingConfirm = false;
  g.attempts = 0;
  g.extraChanceLeft = 0;
  const result = handleFailure(g, { reason:"TIMEOUT", word:null });
  return { type:"TIMEOUT", ...result };
}

function handleFailure(g, {reason, word}){
  const ap = g.players[g.active];
  const comboAtFailure = ap.combo;
  const swipeFailedAttempt = Boolean(reason && reason !== "TIMEOUT");
  if (swipeFailedAttempt){
    ap.failedSwipeThisTurn = true;
    expandSpellFinderHintOnFailure(ap);
  }

  const ended = (g.attempts <= 0 && g.extraChanceLeft <= 0);
  const preserveCombo = (ap.skills.EXTRA_CHANCE >= 5) && !ended;
  if (!preserveCombo){
    ap.combo = 0;
  }
  ap.decaySteps = 0;
  updateDecaySteps(g);

  const foLv = ap.skills.FAIL_OPP;
  ap.lastFailedTiles = new Set(g.selection);
  ap.pendingWhiteCount = 0;
  if (foLv >= 1 && !ap.hasFoundWordThisTurn){
    ap.pendingWhiteCount = WHITE_MAX_TILES[foLv];
  }

  const turnEnded = ended || g.gameOver;
  if (turnEnded){
    endTurn(g, g.gameOver ? "VICTORY" : "OUT_OF_ATTEMPTS");
  }

  return { ended: turnEnded, reason };
}

function expandSpellFinderHintOnFailure(player){
  if (!player) return;
  const lv = player.skills.SPELL_FINDER || 0;
  if (lv < 4) return;
  const spell = player.spellFinder;
  if (!spell || !Array.isArray(spell.path)) return;
  const pathLen = spell.path.length;
  if (pathLen <= 0) return;
  const baseTiles = SPELL_FINDER_HINT_TILES(lv);
  const currentLimit = (typeof spell.tileLimitThisTurn === "number")
    ? spell.tileLimitThisTurn
    : baseTiles;
  if (currentLimit >= pathLen) return;
  spell.tileLimitThisTurn = Math.min(pathLen, currentLimit + 1);
  rebuildSpellFinderTiles(player, lv);
}

function tryActivateSafetyNet(g){
  if (!g || g.gameOver) return;
  const ap = g.players[g.active];
  if (!ap) return;

  const snLv = ap.skills.SAFETY_NET || 0;
  if (snLv <= 0) return;
  if (ap.safetyNetUsed) return;
  if (!ap.failedSwipeThisTurn) return;
  const combo = Number.isFinite(ap.combo) ? ap.combo : 0;
  if (combo > 1) return;

  const safetyPts = SAFETY_NET_POINTS[snLv] || 0;
  if (safetyPts <= 0) return;

  ap.score += safetyPts;
  g.pointLog.push({
    label: "Safety Net",
    detail: "Triggered after a failed swipe while combo ≤1.",
    player: ap.id,
    pts: safetyPts,
  });
  ap.safetyNetUsed = true;
  checkVictory(g);
}

/* ------------------------
   Success handling (SCORING ORDER EXACT)
------------------------ */

function handleSuccess(g, word, wordLen){
  const ap = g.players[g.active];
  const op = g.players[1 - g.active];

  ap.hasFoundWordThisTurn = true;
  ap.combo += 1;

  const baseLen = LEN_TABLE(wordLen);
  const preDecayScore = baseLen * COMBO_MULT(ap.combo);
  const decayLv = op.skills.VALUE_DECAY || 0;
  const usedPurple = countOverlap(g.selectionSet, g.purple) >= 1;
  if (decayLv > 0 && usedPurple){
    ap.decaySteps += 1;
  } else {
    ap.decaySteps = 0;
  }

  const { multiplier } = decayEffectDetails(ap, op);
  const afterDecayBase = preDecayScore * multiplier;
  updateDecaySteps(g);

  const piLv = ap.skills.POINT_INCREASE;
  const foLv = ap.skills.FAIL_OPP;
  const usedWhiteCount = countOverlap(g.selectionSet, g.white);
  const pfLv = ap.skills.POINT_FOUNTAIN;
  const usedFountainSelf = (ap.fountainIdx != null && g.selectionSet.has(ap.fountainIdx));
  const wfLv = ap.skills.WIN_FOOTSTEPS;
  const usedGold = countOverlap(g.selectionSet, g.gold) >= 1;

  const scoreContext = {
    piLv,
    foLv,
    pfLv,
    wfLv,
    usedWhiteCount,
    usedFountainSelf,
    usedGold,
  };

  const scoreWithDecay = applyPostDecayScore(afterDecayBase, ap, scoreContext);
  const scoreWithoutDecay = applyPostDecayScore(preDecayScore, ap, scoreContext);

  const finalWordPoints = roundInt(scoreWithDecay);
  const altFinalWordPoints = roundInt(scoreWithoutDecay);
  const decayLoss = Math.max(0, altFinalWordPoints - finalWordPoints);

  let fountainShared = 0;
  const usedOpponentFountain = (op.fountainIdx != null && g.selectionSet.has(op.fountainIdx));
  if (usedOpponentFountain){
    const opponentBonus = roundInt(finalWordPoints * 0.5);
    fountainShared = opponentBonus;
    op.score += opponentBonus;
    if (checkVictory(g)) return { ended:true, finalWordPoints, endedByVictory:true };
  }

  let spellFinderShared = 0;
  let spellFinderReduction = 0;
  const opSpellLv = op.skills.SPELL_FINDER || 0;
  if (opSpellLv >= 5 && op.spellFinder && op.spellFinder.word === word){
    spellFinderShared = roundInt(finalWordPoints * 0.5);
    spellFinderReduction = spellFinderShared;
    op.score += spellFinderShared;
    if (checkVictory(g)) return { ended:true, finalWordPoints, endedByVictory:true };
  }

  ap.score += Math.max(0, finalWordPoints - spellFinderReduction);
  if (checkVictory(g)) return { ended:true, finalWordPoints, endedByVictory:true };

  if (decayLoss > 0){
    op.score += decayLoss;
    if (checkVictory(g)) return { ended:true, finalWordPoints, endedByVictory:true };
  }

  g.foundWords.add(word);
  const sharedTotal = fountainShared + spellFinderShared;
  g.log.push({
    word,
    player: ap.id,
    pts: finalWordPoints,
    shared: sharedTotal,
    stolen: decayLoss,
  });

  if (ap.spellFinder && ap.spellFinder.word === word){
    clearSpellFinder(ap);
  }

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

  ap.lastWordTiles = new Set(g.selection);

  g.attempts = 0;

  endTurn(g, "SUCCESS");

  return { ended:true, finalWordPoints, endedByVictory:false };
}

function countOverlap(setA, setB){
  let n=0;
  for (const x of setA) if (setB.has(x)) n++;
  return n;
}

function applyPostDecayScore(baseScore, ap, context){
  let s = baseScore;
  const piLv = context.piLv || 0;
  const foLv = context.foLv || 0;
  const usedWhiteCount = context.usedWhiteCount || 0;
  if (piLv > 0){
    s *= (1 + POINT_INCREASE_PCT[piLv]);
  }
  if (foLv > 0 && usedWhiteCount >= 2){
    s *= WHITE_MULT[foLv];
  }
  const pfLv = context.pfLv || 0;
  const usedFountainSelf = context.usedFountainSelf;
  if (pfLv > 0 && usedFountainSelf){
    s += FOUNTAIN_BONUS[pfLv];
  }
  const wfLv = context.wfLv || 0;
  if (wfLv > 0 && context.usedGold){
    s += GOLD_BONUS[wfLv];
  }
  s *= pointCategoryMultiplier(ap);
  return s;
}

export function projectWordScore(g, playerIndex, wordLen, path, options = {}){ 
  if (!g || !Array.isArray(g.players) || !Array.isArray(path) || wordLen < MIN_WORD_LEN){
    return 0;
  }
  const ap = g.players[playerIndex];
  const op = g.players[1 - playerIndex];
  if (!ap || !op){
    return 0;
  }

  const pathSet = new Set(path);
  let combo = (Number.isFinite(ap.combo) ? ap.combo : 0) + 1;
  let baseScore = LEN_TABLE(wordLen) * COMBO_MULT(combo);

  const usesPurple = countOverlap(pathSet, g.purple) >= 1;
  const nextDecaySteps = usesPurple ? ((ap.decaySteps || 0) + 1) : 0;
  if ((op.skills.VALUE_DECAY || 0) > 0 && nextDecaySteps > 0){
    const projectedPlayer = { ...ap, decaySteps: nextDecaySteps };
    const details = decayEffectDetails(projectedPlayer, op);
    if (details.multiplier < 1){
      baseScore *= details.multiplier;
    }
  }

  const piLv = ap.skills.POINT_INCREASE || 0;
  if (piLv > 0){
    baseScore *= (1 + POINT_INCREASE_PCT[piLv]);
  }

  const foLv = ap.skills.FAIL_OPP || 0;
  if (foLv > 0 && countOverlap(pathSet, g.white) >= 2){
    baseScore *= WHITE_MULT[foLv];
  }

  const pfLv = ap.skills.POINT_FOUNTAIN || 0;
  if (pfLv > 0 && ap.fountainIdx != null && pathSet.has(ap.fountainIdx)){
    baseScore += FOUNTAIN_BONUS[pfLv];
  }

  const wfLv = ap.skills.WIN_FOOTSTEPS || 0;
  if (wfLv > 0 && countOverlap(pathSet, g.gold) >= 1){
    baseScore += GOLD_BONUS[wfLv];
  }
  const tilePreference = options.tilePreference || {};
  const beneficialGold = countOverlap(pathSet, g.gold);
  const beneficialWhite = countOverlap(pathSet, g.white);
  const usedFountainSelf = (ap.fountainIdx != null && pathSet.has(ap.fountainIdx));
  const tilePreferenceBonus =
    (beneficialGold * (tilePreference.gold || 0)) +
    (beneficialWhite * (tilePreference.white || 0)) +
    (usedFountainSelf ? (tilePreference.fountain || 0) : 0);
  baseScore += tilePreferenceBonus;
  const opponentFountain = op.fountainIdx;
  if (options.opponentFountainPenalty && opponentFountain != null && pathSet.has(opponentFountain)){
    baseScore -= options.opponentFountainPenalty;
  }

  const lengthPreference = options.lengthPreference;
  if (lengthPreference){
    const minLen = Number.isFinite(lengthPreference.min) ? lengthPreference.min : MIN_WORD_LEN;
    const maxLen = Number.isFinite(lengthPreference.max) ? lengthPreference.max : Infinity;
    if (wordLen >= minLen && wordLen <= maxLen){
      if (typeof lengthPreference.bonus === "number"){
        baseScore += lengthPreference.bonus;
      }
    } else if (typeof lengthPreference.penaltyPerStep === "number" && lengthPreference.penaltyPerStep > 0){
      const under = Math.max(0, minLen - wordLen);
      const over = Math.max(0, wordLen - maxLen);
      const penaltySteps = under + over;
      baseScore -= penaltySteps * lengthPreference.penaltyPerStep;
    }
  }

  baseScore *= pointCategoryMultiplier(ap);
  return Math.round(baseScore);
}

export function findComputerWord(g, playerIndex, options = {}){
  if (!g || !Array.isArray(g.dictWords) || g.dictWords.length === 0) return null;

  const sampleSize = Number.isFinite(options.sampleSize) ? Math.max(1, options.sampleSize) : 400;
  const stopScore = Number.isFinite(options.stopScore) ? options.stopScore : 0;

  const pools = [];
  if (Array.isArray(g.commonWords) && g.commonWords.length > 0){
    pools.push(g.commonWords);
  }
  pools.push(g.dictWords);

  let tries = 0;
  let best = null;

  for (const pool of pools){
    if (!Array.isArray(pool) || pool.length === 0) continue;
    const poolLen = pool.length;
    const start = randInt(poolLen);
    for (let offset = 0; offset < poolLen && tries < sampleSize; offset++){
      const idx = (start + offset) % poolLen;
      const rawWord = pool[idx];
      tries += 1;
      if (!rawWord) continue;
      const word = String(rawWord).toLowerCase();
      if (word.length < MIN_WORD_LEN) continue;
      if (g.foundWords.has(word)) continue;

      const path = findWordPathOnBoard(g.board, word, g.gray);
      if (!path) continue;

      const score = projectWordScore(g, playerIndex, path.length, path, {
        tilePreference: options.tilePreference,
        opponentFountainPenalty: options.opponentFountainPenalty,
      });
      if (!best || score > best.score || (score === best.score && path.length > best.path.length)){
        best = { word, path, score };
      }
      if (stopScore > 0 && best && best.score >= stopScore){
        return best;
      }
    }
  }

  if (best){
    return best;
  }

  const fallback = findHintWordAndPath(g);
  if (!fallback) return null;
  const fallbackScore = projectWordScore(g, playerIndex, fallback.path.length, fallback.path, {
    tilePreference: options.tilePreference,
    opponentFountainPenalty: options.opponentFountainPenalty,
  });
  return { word: fallback.word, path: fallback.path, score: fallbackScore };
}

export function totalSkillLevels(p){
  let total = 0;
  for (const v of Object.values(p.skills)) total += v;
  return total;
}

export function canUseHint(g){
  if (!g || g.gameOver) return false;
  if (g.skillSelect && g.skillSelect.pending) return false;
  if (!g.hint || g.hint.usedThisTurn) return false;
  const ap = g.players[g.active];
  return totalSkillLevels(ap) >= 3;
}

export function applyHint(g, allocations){
  if (!g || g.gameOver) return { ok:false, reason:"NO_GAME" };
  if (!g.hint) return { ok:false, reason:"NO_STATE" };
  if (g.hint.usedThisTurn) return { ok:false, reason:"USED_THIS_TURN" };

  const ap = g.players[g.active];
  if (totalSkillLevels(ap) < 3) return { ok:false, reason:"INSUFFICIENT_SKILLS" };

  const normalized = normalizeHintAllocations(ap, allocations);
  if (!normalized.ok) return { ok:false, reason:normalized.reason };

  const hint = findHintWordAndPath(g);
  if (!hint) return { ok:false, reason:"NO_HINT_AVAILABLE" };

  applyHintAllocations(ap, normalized.allocations);
  updateDecaySteps(g);
  updateSpellFinderForPlayer(g, g.active);

  // Derived state adjustments after skill reduction
  const newExtra = EXTRA_CHANCE_ADD[ap.skills.EXTRA_CHANCE];
  g.extraChanceLeft = Math.min(g.extraChanceLeft, newExtra);

  if (ap.skills.POINT_FOUNTAIN <= 0){
    ap.fountainIdx = null;
  }

  g.hint.usedThisTurn = true;
  g.hint.tiles = new Set(hint.path);
  g.hint.word = hint.word;

  return { ok:true, word: hint.word, path: hint.path };
}

function normalizeHintAllocations(p, allocations){
  if (!allocations || typeof allocations !== "object"){
    return { ok:false, reason:"INVALID_ALLOCATIONS" };
  }
  let total = 0;
  const out = {};

  for (const [skillId, amountRaw] of Object.entries(allocations)){
    if (!(skillId in p.skills)) return { ok:false, reason:"INVALID_SKILL" };
    const amount = Number(amountRaw) || 0;
    if (amount < 0) return { ok:false, reason:"NEGATIVE_AMOUNT" };
    if (amount === 0) continue;
    if (amount > p.skills[skillId]) return { ok:false, reason:"OVER_ALLOCATED" };
    out[skillId] = amount;
    total += amount;
  }

  if (total !== 3) return { ok:false, reason:"TOTAL_NOT_THREE" };
  return { ok:true, allocations: out };
}

function applyHintAllocations(p, allocations){
  for (const [skillId, amount] of Object.entries(allocations)){
    p.skills[skillId] = Math.max(0, p.skills[skillId] - amount);
  }
}

function findHintWordAndPath(g){
  if (!g.dictWords || g.dictWords.length === 0) return null;
  const start = randInt(g.dictWords.length);
  for (let i=0; i<g.dictWords.length; i++){
    const idx = (start + i) % g.dictWords.length;
    const word = g.dictWords[idx];
    if (!word || word.length < MIN_WORD_LEN) continue;
    if (g.foundWords.has(word)) continue;
    const path = findWordPathOnBoard(g.board, word, g.gray);
    if (path) return { word, path };
  }
  return null;
}

function findWordPathOnBoard(letters, word, blocked){
  const target = word.toUpperCase();
  const L = target.length;
  if (L < MIN_WORD_LEN) return null;

  const used = new Set();
  const path = [];

  const dfs = (idx, pos) => {
    if (blocked && blocked.has(idx)) return false;
    if (letters[idx] !== target[pos]) return false;

    used.add(idx);
    path.push(idx);

    if (pos === L - 1) return true;

    const nextChar = target[pos + 1];
    const neigh = neighbors8(idx);
    for (const n of neigh){
      if (used.has(n)) continue;
      if (letters[n] !== nextChar) continue;
      if (dfs(n, pos + 1)) return true;
    }

    used.delete(idx);
    path.pop();
    return false;
  };

  for (let i=0; i<letters.length; i++){
    if (blocked && blocked.has(i)) continue;
    if (letters[i] !== target[0]) continue;
    used.clear();
    path.length = 0;
    if (dfs(i, 0)) return path.slice();
  }
  return null;
}

function clearSpellFinder(p){
  if (!p) return;
  if (!p.spellFinder){
    p.spellFinder = { word: null, path: [], tiles: new Set() };
  }
  p.spellFinder.word = null;
  p.spellFinder.path = [];
  p.spellFinder.tiles = new Set();
  p.spellFinder.tileLimitThisTurn = null;
}

function updateSpellFinderForPlayer(g, playerIndex){
  if (!g || !g.players || !g.players[playerIndex]) return;
  const p = g.players[playerIndex];
  const lv = p.skills.SPELL_FINDER || 0;
  if (lv <= 0){
    clearSpellFinder(p);
    return;
  }

  const minLen = SPELL_FINDER_MINLEN(lv);
  const opponentWord = g.players[1 - playerIndex]?.spellFinder?.word || null;

  let word = p.spellFinder?.word || null;
  let path = null;

  if (word){
    if (word.length < minLen) word = null;
    if (word && g.foundWords.has(word)) word = null;
    if (word && opponentWord && word === opponentWord) word = null;
    if (word){
      path = findWordPathOnBoard(g.board, word, g.gray);
      if (!path) word = null;
    }
  }

  if (!word){
    const chosen = findSpellFinderWordWithFallback(g, minLen, opponentWord);
    if (!chosen){
      clearSpellFinder(p);
      return;
    }
    word = chosen.word;
    path = chosen.path;
    p.spellFinder.tileLimitThisTurn = null;
    console.log(`[spell-finder] ${p.name} target: ${word}`);
  }

  if (!p.spellFinder){
    p.spellFinder = { word: null, path: [], tiles: new Set() };
  }
  p.spellFinder.word = word;
  p.spellFinder.path = path;
  rebuildSpellFinderTiles(p, lv);
}

function computeSpellFinderHintLimit(spellFinder, pathLength, lv){
  if (!spellFinder) return 0;
  const baseTiles = SPELL_FINDER_HINT_TILES(lv);
  const requested = (typeof spellFinder.tileLimitThisTurn === "number")
    ? Math.max(0, spellFinder.tileLimitThisTurn)
    : baseTiles;
  if (pathLength <= 0) return 0;
  return Math.min(pathLength, requested);
}

function rebuildSpellFinderTiles(player, lv){
  const spell = player?.spellFinder;
  if (!spell){
    return;
  }
  if (!Array.isArray(spell.path) || spell.path.length === 0){
    spell.tiles = new Set();
    return;
  }
  const limit = computeSpellFinderHintLimit(spell, spell.path.length, lv);
  spell.tiles = new Set(spell.path.slice(0, limit));
}

function findSpellFinderWord(g, minLen, opponentWord){
  const pool = (Array.isArray(g.commonWords) && g.commonWords.length > 0)
    ? g.commonWords
    : g.dictWords;
  if (!pool || pool.length === 0) return null;
  const start = randInt(pool.length);
  let bestLen = Infinity;
  const candidates = [];
  for (let i=0; i<pool.length; i++){
    const idx = (start + i) % pool.length;
    const word = pool[idx];
    if (!word || word.length < minLen) continue;
    if (word.length > bestLen) continue;
    if (g.foundWords.has(word)) continue;
    if (opponentWord && word === opponentWord) continue;
    const path = findWordPathOnBoard(g.board, word, g.gray);
    if (!path) continue;
    if (word.length < bestLen){
      bestLen = word.length;
      candidates.length = 0;
    }
    candidates.push({ word, path });
  }
  if (candidates.length > 0){
    return candidates[randInt(candidates.length)];
  }
  return null;
}

function findSpellFinderWordWithFallback(g, minLen, opponentWord){
  const startLen = Math.max(minLen, MIN_WORD_LEN);
  for (let len = startLen; len >= MIN_WORD_LEN; len--){
    const candidate = findSpellFinderWord(g, len, opponentWord);
    if (candidate) return candidate;
  }
  return null;
}

/* ------------------------
   Category bonuses
------------------------ */

export function pointTier(p){
  const total =
    p.skills.POINT_INCREASE +
    p.skills.POINT_FOUNTAIN +
    p.skills.FAIL_OPP;

  if (total >= 10) return 2;
  if (total >= 5) return 1;
  return 0;
}

export function counterTier(p){
  const total =
    p.skills.VALUE_DECAY +
    p.skills.WIN_FOOTSTEPS +
    p.skills.COLOR_CANCEL;

  if (total >= 10) return 2;
  if (total >= 5) return 1;
  return 0;
}

export function techTier(p){
  const total =
    p.skills.EXTRA_CHANCE +
    p.skills.SPELL_FINDER +
    p.skills.SAFETY_NET;

  if (total >= 10) return 2;
  if (total >= 5) return 1;
  return 0;
}

const POINT_CATEGORY_MULTIPLIERS = [1, 1.1, 1.2];
const TECH_CATEGORY_BONUS_POINTS = [0, 5, 10];

function pointCategoryMultiplier(p){
  const tier = pointTier(p);
  if (tier < 0 || tier >= POINT_CATEGORY_MULTIPLIERS.length){
    return 1;
  }
  return POINT_CATEGORY_MULTIPLIERS[tier];
}

function techTierBonusPoints(tier){
  if (!Number.isFinite(tier)) return 0;
  if (tier <= 0 || tier >= TECH_CATEGORY_BONUS_POINTS.length) return 0;
  return TECH_CATEGORY_BONUS_POINTS[tier];
}

function applyTechTierBonus(g){
  const ap = g.players[g.active];
  if (!ap) return;
  const tier = techTier(ap);
  const points = techTierBonusPoints(tier);
  if (points <= 0) return;
  ap.score += points;
  g.pointLog.push({
    label: `Tech Tier ${tier} bonus`,
    detail: "Technical category bonus applied at turn end.",
    player: ap.id,
    pts: points,
  });
  checkVictory(g);
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
  updateDecaySteps(g);

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
    case "POINT_FOUNTAIN":
      return `self +${FOUNTAIN_BONUS[lv]} / opponent share 50%`;
    case "VALUE_DECAY": {
      const stepPct = Math.round(DECAY_STEP[lv] * 100);
      const maxDecay = DECAY_MAX_DECAY_PCT[lv] ?? 0;
      return `purple step ${stepPct}% (max ${maxDecay}% decay)`;
    }
    case "WIN_FOOTSTEPS":
      return `gold max ${GOLD_MAX_TILES[lv]}, +${GOLD_BONUS[lv]} if used`;
    case "COLOR_CANCEL":
      if (lv===1) return `−1 special tile`;
      if (lv===2) return `−1 (50% −2)`;
      if (lv===3) return `−2`;
      if (lv===4) return `−2 (50% −3)`;
      return `−3`;
    case "EXTRA_CHANCE":
      if (lv >= 5) return `+${EXTRA_CHANCE_ADD[lv]} attempts; combo kept on success`;
      return `+${EXTRA_CHANCE_ADD[lv]} attempts after fail`;
    case "FAIL_OPP":
      return `white max ${WHITE_MAX_TILES[lv]} (after failing; prioritizes tiles from your most recent failed swipe before filling the rest randomly), ×${formatWhiteMult(WHITE_MULT[lv])} if ≥2 used`;
    case "SAFETY_NET":
      return `+${SAFETY_NET_POINTS[lv]} pts at the end of the failed turn when combo is 0 or 1 (once per turn)`;
    case "SPELL_FINDER": {
      const minLen = SPELL_FINDER_MINLEN(lv);
      const tiles = SPELL_FINDER_HINT_TILES(lv);
      const shareTag = (lv >= 5) ? "; 50% share if stolen" : "";
      const growthTag = (lv >= 4) ? ", grows on misses" : "";
      return `len>=${minLen}, hint ${tiles} tile${tiles > 1 ? "s" : ""}${growthTag}${shareTag}`;
    }
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
    case "POINT_FOUNTAIN": {
      const bonus = FOUNTAIN_BONUS[lv];
      return `Lv${lv}/5 — When you find a word, the LAST tile becomes your Fountain (only 1 at a time; new replaces old). Using YOUR Fountain in a later word adds +${bonus} flat points. If the OPPONENT uses your Fountain in a word, you gain 50% of that word’s FINAL points (rounded), and the opponent still keeps full word points.`;
    }
    case "VALUE_DECAY": {
      const stepPct = Math.round(DECAY_STEP[lv] * 100);
      const minMult = (DECAY_MIN_MULT[lv] ?? 0).toFixed(2);
      const maxDecayPct = DECAY_MAX_DECAY_PCT[lv] ?? 0;
      return `Lv${lv}/5 — Only the opponent is affected. On their turn, the tiles from your last word glow purple; using ≥1 of them to form a word multiplies that word’s score by 1.00 − ${stepPct}% × (consecutive purple hits) after combo and before point multipliers, with the decay capped at ${maxDecayPct}% so the multiplier never drops below ×${minMult}. The points shaved off are added to you instantly, and the purple tiles vanish after their turn ends.`;
    }
    case "WIN_FOOTSTEPS": {
      const maxGold = GOLD_MAX_TILES[lv];
      const bonus = GOLD_BONUS[lv];
      return `Lv${lv}/5 — Trigger: if the opponent finds a word, then on YOUR NEXT turn spawn up to ${maxGold} visible GOLD tiles (uniform random among all 36). If your found word uses ≥1 gold tile: add +${bonus} flat points. Gold tiles are visible to both players and disappear at the end of your turn.`;
    }
    case "COLOR_CANCEL": {
      return `Lv${lv}/5 — When you find a word, the opponent’s NEXT turn spawns fewer “special tiles” (GOLD from Winner’s Footsteps, WHITE from Failure into Opportunity, and GREEN Spell Finder hints). Gray tiles are NOT reduced. If the opponent has a Fountain tile, it is removed before their next turn begins. Reduction: Lv1 −1, Lv2 −1 (50% chance −2), Lv3 −2, Lv4 −2 (50% chance −3), Lv5 −3.`;
    }
    case "EXTRA_CHANCE": {
      const add = EXTRA_CHANCE_ADD[lv];
      const comboNote = (lv >= 5)
        ? " At Lv5, if you eventually succeed in the SAME turn (even using extra attempts), your combo is preserved."
        : " IMPORTANT: the failure still consumes the attempt and ALWAYS resets combo; extra attempts do NOT protect combo.";
      return `Lv${lv}/5 — After a failed attempt (invalid word / duplicate / not in dictionary): immediately gain +${add} extra attempts for the SAME turn.${comboNote}`;
    }
    case "FAIL_OPP": {
      const maxW = WHITE_MAX_TILES[lv];
      const mult = WHITE_MULT[lv];
      return `Lv${lv}/5 — Trigger whenever you fail an attempt before finding any word this turn (even if Extra Chance lets you recover): choose up to ${maxW} tiles for your NEXT turn by first marking the tiles from your most recent failed swipe and then filling any remaining slots with random board tiles that aren’t already white. On that next turn, if your successful word uses ≥2 white tiles, multiply that word’s score by ×${formatWhiteMult(mult)}. White tiles are visible and disappear at the end of that next turn.`;
    }
    case "SAFETY_NET": {
      const bonus = SAFETY_NET_POINTS[lv];
      return `Lv${lv}/5 — Trigger: when your turn finally ends in failure (invalid word / duplicate / timeout), your combo count is 0 or 1, and you have failed at least one swipe this turn (success afterward does not stop it). Gain +${bonus} flat points immediately (once per turn). This bonus bypasses combos, multipliers, and any other point-modifying skills, so the award is always the stated value.`;
    }
    case "SPELL_FINDER": {
      const minLen = SPELL_FINDER_MINLEN(lv);
      const tiles = SPELL_FINDER_HINT_TILES(lv);
      const share = (lv >= 5) ? " If your opponent finds your marked word, you gain 50% of that word's final points." : "";
      const fallback = ` If no word of length >=${minLen} exists, Spell Finder keeps lowering the threshold by 1 until a match is found.`;
      const growth = (lv >= 4)
        ? " Lv4+: each failed attempt (including Extra Chance) reveals one additional tile until the entire word is fully exposed."
        : "";
      return `Lv${lv}/5 - At the start of your turn, pick a random swipeable word not yet found in the match (and not assigned to the opponent's Spell Finder). The word stays fixed until you find it. Highlight the first ${tiles} letter${tiles > 1 ? "s" : ""} in green; word length must be >=${minLen}.${fallback}${growth}${share}`;
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
    case "POINT_FOUNTAIN": effect = `Next: self-use +${FOUNTAIN_BONUS[next]} pts`; break;
    case "VALUE_DECAY": {
      const maxDecay = DECAY_MAX_DECAY_PCT[next] ?? 0;
      effect = `Next: purple step ${Math.round(DECAY_STEP[next] * 100)}% (max ${maxDecay}% decay)`;
      break;
    }
    case "WIN_FOOTSTEPS":  effect = `Next: max gold ${GOLD_MAX_TILES[next]}, gold bonus +${GOLD_BONUS[next]}`; break;
    case "COLOR_CANCEL": {
      const cancelText =
        next === 1 ? "-1 special tile" :
        next === 2 ? "-1 special tile (50% chance of -2)" :
        next === 3 ? "-2 special tiles" :
        next === 4 ? "-2 special tiles (50% chance of -3)" :
        "-3 special tiles";
      effect = `Next: ${cancelText} (gold/white + remove fountain if present)`;
      break;
    }
    case "EXTRA_CHANCE": {
      const comboTag = (next >= 5) ? " + combo preserved on success" : "";
      effect = `Next: +${EXTRA_CHANCE_ADD[next]} attempts after failure${comboTag}`;
      break;
    }
    case "FAIL_OPP":       effect = `Next: max white ${WHITE_MAX_TILES[next]} (failures prioritize your last failed-swipe tiles), white mult ×${formatWhiteMult(WHITE_MULT[next])}`; break;
    case "SAFETY_NET":     effect = `Next: +${SAFETY_NET_POINTS[next]} pts at the end of the failed turn when combo is 0 or 1 and you failed at least one swipe this turn (once per turn, fixed)`; break;
    case "SPELL_FINDER": {
      const minLen = SPELL_FINDER_MINLEN(next);
      const tiles = SPELL_FINDER_HINT_TILES(next);
      const share = (next >= 5) ? ", 50% share if opponent finds" : "";
      const growth = (next >= 4) ? ", grows on misses" : "";
      effect = `Next: word len>=${minLen}, highlight ${tiles}${growth}${share}`;
      break;
    }
  }

  return { catLabel, effect };
}
