import crypto from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I so codes survive being read aloud

export const uid = (n = 8) => crypto.randomBytes(n * 2).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);
export const secretToken = () => crypto.randomBytes(18).toString('base64url');

export function roomCode() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

export const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v))));

// Strip control characters, angle brackets and zero-width characters, collapse whitespace.
export function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u2028-\u202f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// "Ice-Cream", "ice cream" and "icecream" must all count as the same guess.
export function normalizeGuess(s) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// A near miss: one edit away (two for long words). Very short words are never "close".
export function isCloseGuess(guess, word) {
  if (word.length < 4 || guess === word) return false;
  const limit = word.length >= 7 ? 2 : 1;
  return levenshtein(guess, word) <= limit;
}

export class TokenBucket {
  constructor(capacity, perSecond) {
    this.cap = capacity;
    this.rate = perSecond;
    this.tokens = capacity;
    this.t = Date.now();
  }
  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.t) * this.rate) / 1000);
    this.t = now;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
