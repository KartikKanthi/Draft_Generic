import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

await pool.query(`
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
    owner_id TEXT REFERENCES users(id),
    position_requirements TEXT,
    picks_per_team INTEGER NOT NULL DEFAULT 0,
    auction_paused INTEGER NOT NULL DEFAULT 0,
    nomination_paused_remaining_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    pick_order INTEGER NOT NULL,
    budget INTEGER NOT NULL DEFAULT 200
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    name TEXT NOT NULL,
    position TEXT,
    team_affiliation TEXT,
    metadata TEXT,
    drafted_by TEXT REFERENCES teams(id),
    pick_number INTEGER,
    bid_amount INTEGER,
    unsold INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(draft_id, player_id, team_id)
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS leagues (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    name TEXT NOT NULL,
    sport TEXT,
    scoring_rules JSONB NOT NULL DEFAULT '{}',
    squad_size INTEGER NOT NULL DEFAULT 15,
    starting_size INTEGER NOT NULL DEFAULT 11,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL REFERENCES leagues(id),
    round_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'upcoming',
    lineup_deadline TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS stat_entries (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL REFERENCES leagues(id),
    round_id TEXT NOT NULL REFERENCES rounds(id),
    player_id TEXT NOT NULL REFERENCES players(id),
    stats JSONB NOT NULL DEFAULT '{}',
    points REAL NOT NULL DEFAULT 0,
    points_breakdown JSONB NOT NULL DEFAULT '{}',
    UNIQUE(round_id, player_id)
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS lineups (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL REFERENCES leagues(id),
    round_id TEXT NOT NULL REFERENCES rounds(id),
    team_id TEXT NOT NULL REFERENCES teams(id),
    player_id TEXT NOT NULL REFERENCES players(id),
    is_starter BOOLEAN NOT NULL DEFAULT true,
    UNIQUE(round_id, team_id, player_id)
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL REFERENCES leagues(id),
    proposing_team_id TEXT NOT NULL REFERENCES teams(id),
    receiving_team_id TEXT NOT NULL REFERENCES teams(id),
    offered_player_ids JSONB NOT NULL DEFAULT '[]',
    requested_player_ids JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS waiver_claims (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL REFERENCES leagues(id),
    team_id TEXT NOT NULL REFERENCES teams(id),
    claim_player_id TEXT NOT NULL REFERENCES players(id),
    drop_player_id TEXT REFERENCES players(id),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

// Safe migrations for existing databases
for (const sql of [
  'ALTER TABLE drafts ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id)',
  'ALTER TABLE drafts ADD COLUMN IF NOT EXISTS position_requirements TEXT',
  'ALTER TABLE drafts ADD COLUMN IF NOT EXISTS picks_per_team INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE drafts ADD COLUMN IF NOT EXISTS auction_paused INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE drafts ADD COLUMN IF NOT EXISTS nomination_paused_remaining_ms INTEGER',
  'ALTER TABLE drafts ADD COLUMN IF NOT EXISTS pick_deadline TIMESTAMPTZ',
  "ALTER TABLE drafts ADD COLUMN IF NOT EXISTS quiet_hours_start INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE drafts ADD COLUMN IF NOT EXISTS quiet_hours_end INTEGER NOT NULL DEFAULT 8",
  "ALTER TABLE drafts ADD COLUMN IF NOT EXISTS quiet_timezone TEXT NOT NULL DEFAULT 'Europe/London'",
  'ALTER TABLE players ADD COLUMN IF NOT EXISTS unsold INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE players ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE players ADD COLUMN IF NOT EXISTS country TEXT',
  'ALTER TABLE leagues ADD COLUMN IF NOT EXISTS waiver_order JSONB',
  'ALTER TABLE teams ADD COLUMN IF NOT EXISTS email TEXT',
  'ALTER TABLE teams ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id)',
]) {
  await pool.query(sql);
}

export default {
  get: async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result.rows[0] ?? null;
  },
  all: async (sql, params = []) => {
    const result = await pool.query(sql, params);
    return result.rows;
  },
  run: async (sql, params = []) => {
    await pool.query(sql, params);
  },
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
};
