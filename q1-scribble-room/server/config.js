import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name, dflt) => (process.env[name] !== undefined ? Number(process.env[name]) : dflt);

// Everything tunable lives here, so tests and the load test can shorten timers or lift limits
// through environment variables without touching the game logic.
export const cfg = {
  PORT: num('PORT', 4100),
  GRACE_MS: num('GRACE_MS', 30000),               // how long a dropped player keeps their seat and score
  DRAWER_GRACE_MS: num('DRAWER_GRACE_MS', 8000),  // how long a turn waits for a dropped drawer
  CHOOSE_MS: num('CHOOSE_MS', 15000),             // time the drawer has to pick one of 3 words
  TURN_END_MS: num('TURN_END_MS', 5000),          // pause between turns
  MIN_DRAW_S: num('MIN_DRAW_S', 20),
  MAX_DRAW_S: 180,
  MAX_PLAYERS: num('MAX_PLAYERS', 12),
  MAX_ROOMS: num('MAX_ROOMS', 20000),
  ROOM_IDLE_MS: num('ROOM_IDLE_MS', 10 * 60 * 1000),
  MAX_CONN_PER_IP: num('MAX_CONN_PER_IP', 40),
  CREATE_PER_MIN_PER_IP: num('CREATE_PER_MIN_PER_IP', 20),
  // Abuse limits
  MAX_CHAT_CHARS: 100,
  MAX_PTS_PER_MSG: 64,
  MAX_POINTS_PER_TURN: num('MAX_POINTS_PER_TURN', 40000),
  MAX_ACTIONS_PER_TURN: 1500,
  MAX_FILLS_PER_TURN: 40,
  MAX_LOG_EVENTS: 6000,
  MAX_MSG_BYTES: 2048,                            // every message except create/settings
  MAX_SETTINGS_BYTES: 32768,
  // Persistence (server restart recovery)
  PERSIST: num('PERSIST', 1) === 1,
  PERSIST_INTERVAL_MS: num('PERSIST_INTERVAL_MS', 2000),
  DATA_FILE: process.env.DATA_FILE || path.join(here, '..', 'data', 'state.json'),
  PUBLIC_DIR: path.join(here, '..', 'public'),
};
