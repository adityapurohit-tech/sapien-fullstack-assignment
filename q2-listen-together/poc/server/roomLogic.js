// Pure state machine for one room. The owner (single writer) turns each command into a new
// state with version + 1. Nothing here does I/O, so it is easy to test and reason about.
//
// Hard state (versioned, persisted, fenced): track, playing, positionMs, serverTimeMs, queue, hostId.
// Soft state (members, skip votes) lives in the actor and is published on a coalesced channel,
// so 5,000 people joining or voting never churns the anchor that playback depends on.

import { positionAt } from '../shared/anchor.js';

export const CLIENT_COMMANDS = new Set(['play', 'pause', 'seek', 'skip', 'enqueue', 'dequeue']);
const HOST_ONLY = new Set(['play', 'pause', 'seek', 'skip', 'dequeue']);
const RECENT_CMDS = 256;

export class CommandError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function initialState({ roomId, roomName, hostId, track }) {
  return {
    roomId,
    roomName,
    epoch: 0,
    version: 0,
    hostId,
    track,
    trackSeq: 1,
    playing: false,
    positionMs: 0,
    serverTimeMs: 0,
    queue: [],
    nextQid: 1,
    recentCmdIds: [],
  };
}

/** What clients see. recentCmdIds is internal. */
export function publicView(s) {
  return {
    roomId: s.roomId,
    roomName: s.roomName,
    epoch: s.epoch,
    version: s.version,
    hostId: s.hostId,
    track: s.track,
    trackSeq: s.trackSeq,
    playing: s.playing,
    positionMs: s.positionMs,
    serverTimeMs: s.serverTimeMs,
    queue: s.queue,
  };
}

function nextTrack(state, catalog) {
  if (state.queue.length > 0) {
    const [head, ...rest] = state.queue;
    return { track: catalog.find((t) => t.id === head.trackId), queue: rest };
  }
  // empty queue: autoplay the next catalogue track
  const idx = catalog.findIndex((t) => t.id === state.track?.id);
  return { track: catalog[(idx + 1) % catalog.length], queue: [] };
}

function advance(s, now, ctx) {
  const { track, queue } = nextTrack(s, ctx.catalog);
  s.track = track;
  s.queue = queue;
  s.trackSeq += 1;
  s.playing = true;
  s.positionMs = 0;
  s.serverTimeMs = now + ctx.config.startLeadMs; // everyone fetches the first segment, then starts together
}

/**
 * @returns {{state, duplicate?:boolean, changed:boolean}}
 * @throws CommandError
 */
export function reduce(state, cmd, now, ctx) {
  if (cmd.cmdId && state.recentCmdIds.includes(cmd.cmdId)) return { state, duplicate: true, changed: false };
  if (!cmd.system && HOST_ONLY.has(cmd.type) && cmd.userId !== state.hostId) {
    throw new CommandError('not_host', 'Only the host can do that');
  }

  const s = structuredClone(state);
  const dur = s.track ? s.track.durationMs : 0;

  switch (cmd.type) {
    case 'pause': {
      if (!s.playing) return { state, changed: false };
      // The final position is computed ONCE, here, and carried in the message:
      // every listener lands on exactly this position however late the message arrives.
      const raw = positionAt(s, now);
      s.positionMs = Math.max(s.positionMs, Math.min(raw, dur));
      s.playing = false;
      s.serverTimeMs = now;
      break;
    }
    case 'play': {
      if (s.playing) return { state, changed: false };
      if (s.positionMs >= dur - 50) s.positionMs = 0;
      s.playing = true;
      s.serverTimeMs = now + ctx.config.resumeLeadMs;
      break;
    }
    case 'seek': {
      const p = Number(cmd.positionMs);
      if (!Number.isFinite(p)) throw new CommandError('bad_request', 'positionMs must be a number');
      s.positionMs = Math.max(0, Math.min(Math.round(p), dur - 1000));
      s.serverTimeMs = s.playing ? now + ctx.config.startLeadMs : now;
      break;
    }
    case 'skip':
      advance(s, now, ctx);
      break;
    case 'trackEnded': // system timer from the owner
      if (cmd.trackSeq !== s.trackSeq) return { state, changed: false };
      advance(s, now, ctx);
      break;
    case 'enqueue': {
      const track = ctx.catalog.find((t) => t.id === cmd.trackId);
      if (!track) throw new CommandError('bad_request', 'Unknown track');
      if (s.queue.length >= ctx.config.maxQueue) throw new CommandError('queue_full', 'Queue is full');
      s.queue.push({ qid: s.nextQid++, trackId: track.id, title: track.title, artist: track.artist, by: cmd.userName || 'someone' });
      break;
    }
    case 'dequeue':
      s.queue = s.queue.filter((q) => q.qid !== cmd.qid);
      break;
    case 'setHost': // system: host handover after the grace period
      if (s.hostId === cmd.hostId) return { state, changed: false };
      s.hostId = cmd.hostId;
      break;
    default:
      throw new CommandError('bad_request', `Unknown command ${cmd.type}`);
  }

  s.version += 1;
  if (cmd.cmdId) {
    s.recentCmdIds.push(cmd.cmdId);
    if (s.recentCmdIds.length > RECENT_CMDS) s.recentCmdIds.splice(0, s.recentCmdIds.length - RECENT_CMDS);
  }
  return { state: s, changed: true };
}

/** Votes needed to skip: half of the connected listeners, rounded up. */
export function votesNeeded(connected) {
  return Math.max(1, Math.ceil(connected / 2));
}
