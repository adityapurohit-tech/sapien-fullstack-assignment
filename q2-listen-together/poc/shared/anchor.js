// Shared by the server and the browser. The whole sync model is these few lines:
// a room state is an *anchor* - "at server time serverTimeMs the track is at positionMs" -
// and every client derives the current position from it. No position stream is ever sent.

/**
 * Raw position of the track at a given server time.
 * While playing it can be negative: a scheduled start (serverTimeMs in the future)
 * means "start in -result ms". It is capped at the track duration.
 */
export function positionAt(state, serverNowMs) {
  if (!state || !state.track) return 0;
  if (!state.playing) return state.positionMs;
  const pos = state.positionMs + (serverNowMs - state.serverTimeMs);
  return Math.min(pos, state.track.durationMs);
}

/** Total order on room states: higher epoch wins, then higher version. */
export function isNewer(a, b) {
  if (!b) return true;
  if (a.epoch !== b.epoch) return a.epoch > b.epoch;
  return a.version > b.version;
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
