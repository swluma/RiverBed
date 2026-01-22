// Dictionary: keep GitHub fetch (as requested)
export const DICT_URL =
  "https://raw.githubusercontent.com/aparrish/wordfreq-en-25000/main/wordfreq-en-25000-log.json";

// Field
export const SIZE = 6;
export const MIN_WORD_LEN = 3;

// Match
export const WIN_SCORE = 300;

// Embedded-word rules
export const EMBED_COUNT = 5;
export const EMBED_LONG_COUNT = 2;     // exactly 2 words length >= 7
export const EMBED_LONG_MINLEN = 7;

// Generation robustness (kept local, no rule changes)
export const GEN_MAX_RESTARTS = 300;   // restart whole board generation if embed fails
export const GEN_TRIES_PER_WORD = 500; // tries per word placement attempt

// UI / feedback
export const FAIL_COUNTDOWN_MS = 420;
