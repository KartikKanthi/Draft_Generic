import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, 'draft.db');
mkdirSync(dirname(dbPath), { recursive: true });
const _db = new DatabaseSync(dbPath);

_db.exec('PRAGMA journal_mode = WAL');
_db.exec('PRAGMA foreign_keys = ON');

_db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('snake', 'linear', 'auction')),
    mode TEXT NOT NULL CHECK(mode IN ('live', 'async')),
    num_teams INTEGER NOT NULL CHECK(num_teams BETWEEN 2 AND 32),
    pick_timer INTEGER NOT NULL DEFAULT 90,
    auction_budget INTEGER NOT NULL DEFAULT 200,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'active', 'completed')),
    current_pick INTEGER NOT NULL DEFAULT 0,
    current_nomination TEXT,
    nomination_ends_at TEXT,
    commissioner_token TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    pick_order INTEGER NOT NULL,
    budget INTEGER NOT NULL DEFAULT 200
  );

  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    name TEXT NOT NULL,
    position TEXT,
    team_affiliation TEXT,
    metadata TEXT,
    drafted_by TEXT REFERENCES teams(id),
    pick_number INTEGER,
    bid_amount INTEGER
  );

  CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(draft_id, player_id, team_id)
  );
`);

// Migrate: add position_requirements column if it doesn't exist yet
try { _db.exec('ALTER TABLE drafts ADD COLUMN position_requirements TEXT'); } catch {}
try { _db.exec('ALTER TABLE drafts ADD COLUMN auction_paused INTEGER NOT NULL DEFAULT 0'); } catch {}
try { _db.exec('ALTER TABLE drafts ADD COLUMN nomination_paused_remaining_ms INTEGER'); } catch {}

// Wrap node:sqlite to provide a better-sqlite3-compatible API surface
const db = {
  prepare: (sql) => _db.prepare(sql),
  exec: (sql) => _db.exec(sql),
  // Returns a function that, when called, wraps fn in a transaction
  transaction: (fn) => (...args) => {
    _db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      _db.exec('COMMIT');
      return result;
    } catch (e) {
      try { _db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
};

export default db;
