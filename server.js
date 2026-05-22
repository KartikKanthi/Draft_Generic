import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'crypto';
import db from './db.js';
import { calculatePoints, SCORING_PRESETS } from './points.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getDraftState(draftId) {
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft) return null;
  const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
  const players = await db.all(
    'SELECT * FROM players WHERE draft_id = $1 ORDER BY LOWER(name)', [draftId]
  );
  const { commissioner_token, ...draftPublic } = draft;

  let currentBids = [];
  if (draft.current_nomination) {
    currentBids = await db.all(`
      SELECT b.team_id, b.amount, t.name as team_name
      FROM bids b
      JOIN teams t ON b.team_id = t.id
      WHERE b.draft_id = $1 AND b.player_id = $2
      ORDER BY b.amount DESC, b.created_at ASC
    `, [draftId, draft.current_nomination]);
  }

  return {
    ...draftPublic,
    teams,
    players: players.map(p => ({ ...p, metadata: p.metadata ? JSON.parse(p.metadata) : {} })),
    current_bids: currentBids
  };
}

function getTeamIndexForPick(pickNumber, numTeams, format) {
  const round = Math.floor(pickNumber / numTeams);
  const pickInRound = pickNumber % numTeams;
  if (format === 'snake') return round % 2 === 0 ? pickInRound : numTeams - 1 - pickInRound;
  return pickInRound;
}

function parseCsvBuffer(buffer) {
  return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}

async function bulkInsertPlayers(draftId, records) {
  let count = 0;
  await db.transaction(async (client) => {
    let sortOrder = 0;
    for (const row of records) {
      const lc = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v]));
      const name = lc.name || lc.player || lc['player name'] || lc['player_name'];
      if (!name?.trim()) continue;
      const { name: _a, player: _b, position, pos, team, team_affiliation, ...rest } = lc;
      await client.query(
        'INSERT INTO players (id, draft_id, name, position, team_affiliation, metadata, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [randomUUID(), draftId, name.trim(), position || pos || null, team || team_affiliation || null,
         Object.keys(rest).length ? JSON.stringify(rest) : null, sortOrder++]
      );
      count++;
    }
  });
  return count;
}

// ── Timer Management ──────────────────────────────────────────────────────────

const activeTimers = new Map();

async function startPickTimer(draftId, endsAtOverride = null) {
  clearPickTimer(draftId);
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft || draft.status !== 'active' || draft.pick_timer === 0) return;

  const endsAt = endsAtOverride ?? Date.now() + draft.pick_timer * 1000;

  const interval = setInterval(async () => {
    const remaining = Math.max(0, endsAt - Date.now());
    io.to(`draft:${draftId}`).emit('timer-tick', { remaining });

    if (remaining === 0) {
      clearPickTimer(draftId);
      const d = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
      if (d?.status === 'active') {
        if (d.format === 'auction') await closeAuction(draftId);
        else await autoPick(draftId);
      }
    }
  }, 500);

  activeTimers.set(draftId, { interval, endsAt });
}

function clearPickTimer(draftId) {
  const entry = activeTimers.get(draftId);
  if (entry) { clearInterval(entry.interval); activeTimers.delete(draftId); }
}

async function autoPick(draftId) {
  const player = await db.get(
    'SELECT id FROM players WHERE draft_id = $1 AND drafted_by IS NULL ORDER BY sort_order LIMIT 1',
    [draftId]
  );
  if (player) await processPick(draftId, player.id, null, true);
}

// ── Pick Processing ───────────────────────────────────────────────────────────

async function processPick(draftId, playerId, teamToken, isAutoPick = false) {
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft || draft.status !== 'active') return false;

  const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
  const expectedIdx = getTeamIndexForPick(draft.current_pick, teams.length, draft.format);
  const pickingTeam = teams[expectedIdx];

  if (!isAutoPick && teamToken && pickingTeam?.token !== teamToken) return false;

  const player = await db.get(
    'SELECT * FROM players WHERE id = $1 AND draft_id = $2 AND drafted_by IS NULL',
    [playerId, draftId]
  );
  if (!player) return false;

  await db.run('UPDATE players SET drafted_by = $1, pick_number = $2 WHERE id = $3',
    [pickingTeam.id, draft.current_pick, playerId]);

  const countRow = await db.get(
    'SELECT COUNT(*) as c FROM players WHERE draft_id = $1 AND drafted_by IS NULL', [draftId]
  );
  const remaining = parseInt(countRow.c);
  const nextPick = draft.current_pick + 1;

  if (remaining === 0) {
    await db.run("UPDATE drafts SET status = 'completed', current_pick = $1 WHERE id = $2", [nextPick, draftId]);
    clearPickTimer(draftId);
  } else {
    await db.run('UPDATE drafts SET current_pick = $1 WHERE id = $2', [nextPick, draftId]);
    if (draft.mode === 'live') await startPickTimer(draftId);
  }

  const state = await getDraftState(draftId);
  io.to(`draft:${draftId}`).emit('draft-state', state);
  io.to(`draft:${draftId}`).emit('pick-made', {
    player: { id: player.id, name: player.name, position: player.position },
    team: { id: pickingTeam.id, name: pickingTeam.name },
    pickNumber: draft.current_pick,
    isAutoPick
  });
  return true;
}

// ── Auction Logic ─────────────────────────────────────────────────────────────

async function autoNominateNext(draftId) {
  const next = await db.get(
    'SELECT id FROM players WHERE draft_id = $1 AND drafted_by IS NULL AND unsold = 0 ORDER BY sort_order LIMIT 1',
    [draftId]
  );
  if (next) await startNomination(draftId, next.id);
}

async function startNomination(draftId, playerId) {
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft || draft.status !== 'active') return;

  const player = await db.get(
    'SELECT * FROM players WHERE id = $1 AND draft_id = $2 AND drafted_by IS NULL',
    [playerId, draftId]
  );
  if (!player) return;

  const endsAt = new Date(Date.now() + draft.pick_timer * 1000).toISOString();
  await db.run('UPDATE drafts SET current_nomination = $1, nomination_ends_at = $2 WHERE id = $3',
    [playerId, endsAt, draftId]);

  if (draft.mode === 'live' && !draft.auction_paused) await startPickTimer(draftId);

  const state = await getDraftState(draftId);
  io.to(`draft:${draftId}`).emit('draft-state', state);
}

async function closeAuction(draftId) {
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft || !draft.current_nomination) return;

  const topBid = await db.get(`
    SELECT b.*, t.budget FROM bids b
    JOIN teams t ON b.team_id = t.id
    WHERE b.draft_id = $1 AND b.player_id = $2
    ORDER BY b.amount DESC, b.created_at ASC LIMIT 1
  `, [draftId, draft.current_nomination]);

  const wonPlayer = await db.get('SELECT * FROM players WHERE id = $1', [draft.current_nomination]);

  if (!topBid) {
    await db.run('UPDATE players SET unsold = 1 WHERE id = $1', [draft.current_nomination]);
    await db.run(
      'UPDATE drafts SET current_nomination = NULL, nomination_ends_at = NULL WHERE id = $1',
      [draftId]
    );
    io.to(`draft:${draftId}`).emit('auction-closed', {
      player: { id: wonPlayer?.id, name: wonPlayer?.name },
      team: null,
      amount: null
    });
  } else {
    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
    const winnerId = topBid.team_id;
    const winAmount = parseInt(topBid.amount);
    const winnerTeam = teams.find(t => t.id === winnerId);

    await db.run('UPDATE players SET drafted_by = $1, pick_number = $2, bid_amount = $3 WHERE id = $4',
      [winnerId, draft.current_pick, winAmount, draft.current_nomination]);
    await db.run('UPDATE teams SET budget = budget - $1 WHERE id = $2', [winAmount, winnerId]);
    await db.run(
      'UPDATE drafts SET current_pick = current_pick + 1, current_nomination = NULL, nomination_ends_at = NULL WHERE id = $1',
      [draftId]
    );

    io.to(`draft:${draftId}`).emit('auction-closed', {
      player: { id: wonPlayer?.id, name: wonPlayer?.name },
      team: { id: winnerId, name: winnerTeam?.name },
      amount: winAmount
    });
  }

  const countRow = await db.get(
    'SELECT COUNT(*) as c FROM players WHERE draft_id = $1 AND drafted_by IS NULL AND unsold = 0', [draftId]
  );
  if (parseInt(countRow.c) === 0) {
    await db.run("UPDATE drafts SET status = 'completed' WHERE id = $1", [draftId]);
  }

  const state = await getDraftState(draftId);
  io.to(`draft:${draftId}`).emit('draft-state', state);

  const updatedDraft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (updatedDraft?.status === 'active' && !updatedDraft.auction_paused) {
    await autoNominateNext(draftId);
  }
}

// ── API Routes ────────────────────────────────────────────────────────────────

app.post('/api/drafts', upload.single('players_csv'), async (req, res) => {
  try {
    const { name, format, mode, num_teams, pick_timer, auction_budget, position_requirements } = req.body;
    if (!name?.trim() || !format || !mode || !num_teams)
      return res.status(400).json({ error: 'Missing required fields' });

    const numTeams = parseInt(num_teams);
    if (isNaN(numTeams) || numTeams < 2 || numTeams > 32)
      return res.status(400).json({ error: 'num_teams must be between 2 and 32' });

    const draftId = randomUUID();
    const commissionerToken = randomUUID();
    const timer = Math.max(0, parseInt(pick_timer) || 90);
    const budget = Math.max(1, parseInt(auction_budget) || 200);
    const posReqs = position_requirements || null;

    await db.run(`
      INSERT INTO drafts (id, name, format, mode, num_teams, pick_timer, auction_budget, commissioner_token, position_requirements)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [draftId, name.trim(), format, mode, numTeams, timer, budget, commissionerToken, posReqs]);

    let playerCount = 0;
    if (req.file) {
      const records = parseCsvBuffer(req.file.buffer);
      playerCount = await bulkInsertPlayers(draftId, records);
    }

    res.json({ draft_id: draftId, commissioner_token: commissionerToken, player_count: playerCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drafts/:id/players', upload.single('players_csv'), async (req, res) => {
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [req.params.id]);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.commissioner_token !== req.headers['x-commissioner-token'])
    return res.status(403).json({ error: 'Unauthorized' });
  if (draft.status !== 'waiting')
    return res.status(400).json({ error: 'Cannot upload players after draft has started' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    await db.run('DELETE FROM players WHERE draft_id = $1', [req.params.id]);
    const records = parseCsvBuffer(req.file.buffer);
    const count = await bulkInsertPlayers(req.params.id, records);
    const state = await getDraftState(req.params.id);
    io.to(`draft:${req.params.id}`).emit('draft-state', state);
    res.json({ player_count: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drafts/:id', async (req, res) => {
  const state = await getDraftState(req.params.id);
  if (!state) return res.status(404).json({ error: 'Draft not found' });
  res.json(state);
});

app.post('/api/drafts/:id/team-by-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const team = await db.get('SELECT id FROM teams WHERE draft_id = $1 AND token = $2', [req.params.id, token]);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json({ team_id: team.id });
});

app.delete('/api/drafts/:id', async (req, res) => {
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [req.params.id]);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.commissioner_token !== req.headers['x-commissioner-token'])
    return res.status(403).json({ error: 'Unauthorized' });

  await db.transaction(async (client) => {
    await client.query('DELETE FROM bids WHERE draft_id = $1', [req.params.id]);
    await client.query('DELETE FROM players WHERE draft_id = $1', [req.params.id]);
    await client.query('DELETE FROM teams WHERE draft_id = $1', [req.params.id]);
    await client.query('DELETE FROM drafts WHERE id = $1', [req.params.id]);
  });

  clearPickTimer(req.params.id);
  io.to(`draft:${req.params.id}`).emit('draft-deleted', {});
  res.json({ success: true });
});

app.post('/api/drafts/:id/join', async (req, res) => {
  const { team_name } = req.body;
  if (!team_name?.trim()) return res.status(400).json({ error: 'team_name required' });

  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [req.params.id]);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.status !== 'waiting') return res.status(400).json({ error: 'Draft already started' });

  const countRow = await db.get('SELECT COUNT(*) as c FROM teams WHERE draft_id = $1', [req.params.id]);
  const teamCount = parseInt(countRow.c);
  if (teamCount >= draft.num_teams) return res.status(400).json({ error: 'Draft is full' });

  const teamId = randomUUID();
  const token = randomUUID();
  await db.run(
    'INSERT INTO teams (id, draft_id, name, token, pick_order, budget) VALUES ($1, $2, $3, $4, $5, $6)',
    [teamId, req.params.id, team_name.trim(), token, teamCount, draft.auction_budget]
  );

  const state = await getDraftState(req.params.id);
  io.to(`draft:${req.params.id}`).emit('draft-state', state);

  res.json({ team_id: teamId, token, pick_order: teamCount });
});

// ── League Helpers ────────────────────────────────────────────────────────────

async function getLeagueWithAuth(leagueId, commissionerToken) {
  const league = await db.get(`
    SELECT l.*, d.commissioner_token FROM leagues l
    JOIN drafts d ON l.draft_id = d.id WHERE l.id = $1
  `, [leagueId]);
  if (!league) return { error: 'League not found', status: 404 };
  if (commissionerToken && league.commissioner_token !== commissionerToken)
    return { error: 'Unauthorized', status: 403 };
  return { league };
}

async function computeStandings(leagueId, teams, rounds) {
  const allEntries = await db.all(`
    SELECT se.player_id, se.round_id, se.points, p.drafted_by
    FROM stat_entries se JOIN players p ON se.player_id = p.id
    WHERE se.league_id = $1
  `, [leagueId]);

  const allLineups = await db.all(
    'SELECT round_id, team_id, player_id, is_starter FROM lineups WHERE league_id = $1',
    [leagueId]
  );

  // Build lookup: { round_id: { team_id: { submitted: true, starters: Set<player_id> } } }
  const lineupMap = {};
  for (const l of allLineups) {
    if (!lineupMap[l.round_id]) lineupMap[l.round_id] = {};
    if (!lineupMap[l.round_id][l.team_id]) lineupMap[l.round_id][l.team_id] = { submitted: true, starters: new Set() };
    if (l.is_starter) lineupMap[l.round_id][l.team_id].starters.add(l.player_id);
  }

  return teams.map(team => {
    const teamEntries = allEntries.filter(e => e.drafted_by === team.id);
    const roundPoints = rounds.map(r => {
      const rEntries = teamEntries.filter(e => e.round_id === r.id);
      const lineup = lineupMap[r.id]?.[team.id];
      const scoringEntries = lineup?.submitted
        ? rEntries.filter(e => lineup.starters.has(e.player_id))
        : rEntries;
      const pts = scoringEntries.reduce((s, e) => s + e.points, 0);
      return { round_id: r.id, round_name: r.name, round_number: r.round_number, points: Math.round(pts * 10) / 10 };
    });
    const total = Math.round(roundPoints.reduce((s, r) => s + r.points, 0) * 10) / 10;
    return { team_id: team.id, team_name: team.name, total_points: total, rounds: roundPoints };
  }).sort((a, b) => b.total_points - a.total_points);
}

// ── League Routes ─────────────────────────────────────────────────────────────

app.get('/api/scoring-presets', (_req, res) => res.json(SCORING_PRESETS));

app.post('/api/leagues', async (req, res) => {
  try {
    const { draft_id, name, sport, scoring_rules, squad_size, starting_size } = req.body;
    const commToken = req.headers['x-commissioner-token'];
    if (!draft_id || !name?.trim()) return res.status(400).json({ error: 'draft_id and name required' });

    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draft_id]);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.commissioner_token !== commToken) return res.status(403).json({ error: 'Unauthorized' });
    if (draft.status !== 'completed') return res.status(400).json({ error: 'Draft must be completed first' });

    const existing = await db.get('SELECT id FROM leagues WHERE draft_id = $1', [draft_id]);
    if (existing) return res.json({ league_id: existing.id, already_exists: true });

    const leagueId = randomUUID();
    await db.run(`
      INSERT INTO leagues (id, draft_id, name, sport, scoring_rules, squad_size, starting_size)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [leagueId, draft_id, name.trim(), sport || null,
        JSON.stringify(scoring_rules || {}),
        parseInt(squad_size) || 15, parseInt(starting_size) || 11]);

    res.json({ league_id: leagueId });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/leagues/:id', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });

    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [league.draft_id]);
    const rounds = await db.all('SELECT * FROM rounds WHERE league_id = $1 ORDER BY round_number', [req.params.id]);
    const standings = await computeStandings(req.params.id, teams, rounds);
    const draft = await db.get('SELECT name FROM drafts WHERE id = $1', [league.draft_id]);

    const { commissioner_token, ...leaguePublic } = league;
    res.json({ ...leaguePublic, draft_name: draft.name, standings, rounds });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.put('/api/leagues/:id/scoring-rules', async (req, res) => {
  try {
    const commToken = req.headers['x-commissioner-token'];
    const { league, error, status } = await getLeagueWithAuth(req.params.id, commToken);
    if (error) return res.status(status).json({ error });

    await db.run('UPDATE leagues SET scoring_rules = $1 WHERE id = $2',
      [JSON.stringify(req.body.scoring_rules), req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/leagues/:id/rounds', async (req, res) => {
  try {
    const commToken = req.headers['x-commissioner-token'];
    const { league, error, status } = await getLeagueWithAuth(req.params.id, commToken);
    if (error) return res.status(status).json({ error });

    const { name, lineup_deadline } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Round name required' });

    const countRow = await db.get('SELECT COUNT(*) as c FROM rounds WHERE league_id = $1', [req.params.id]);
    const roundNumber = parseInt(countRow.c) + 1;
    const roundId = randomUUID();
    await db.run(
      'INSERT INTO rounds (id, league_id, round_number, name, lineup_deadline) VALUES ($1,$2,$3,$4,$5)',
      [roundId, req.params.id, roundNumber, name.trim(), lineup_deadline || null]
    );
    res.json({ round_id: roundId, round_number: roundNumber });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.put('/api/leagues/:id/rounds/:roundId/status', async (req, res) => {
  try {
    const commToken = req.headers['x-commissioner-token'];
    const { league, error, status } = await getLeagueWithAuth(req.params.id, commToken);
    if (error) return res.status(status).json({ error });

    const { status: newStatus } = req.body;
    if (!['upcoming', 'active', 'completed'].includes(newStatus))
      return res.status(400).json({ error: 'Invalid status' });

    await db.run('UPDATE rounds SET status = $1 WHERE id = $2 AND league_id = $3',
      [newStatus, req.params.roundId, req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/leagues/:id/rounds/:roundId', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });

    const round = await db.get('SELECT * FROM rounds WHERE id = $1 AND league_id = $2',
      [req.params.roundId, req.params.id]);
    if (!round) return res.status(404).json({ error: 'Round not found' });

    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [league.draft_id]);
    const players = await db.all('SELECT * FROM players WHERE draft_id = $1 AND drafted_by IS NOT NULL ORDER BY LOWER(name)', [league.draft_id]);
    const statEntries = await db.all('SELECT * FROM stat_entries WHERE round_id = $1', [req.params.roundId]);
    const lineupRows = await db.all('SELECT * FROM lineups WHERE round_id = $1', [req.params.roundId]);
    const entryMap = Object.fromEntries(statEntries.map(e => [e.player_id, e]));

    // Build lineup map: { team_id: { submitted, starters: Set } }
    const lineupMap = {};
    for (const l of lineupRows) {
      if (!lineupMap[l.team_id]) lineupMap[l.team_id] = { submitted: true, starters: new Set() };
      if (l.is_starter) lineupMap[l.team_id].starters.add(l.player_id);
    }

    const playerStats = players.map(p => {
      const entry = entryMap[p.id];
      const team = teams.find(t => t.id === p.drafted_by);
      const lineup = lineupMap[p.drafted_by];
      const isStarter = lineup ? lineup.starters.has(p.id) : null; // null = no lineup submitted
      return {
        player_id: p.id,
        player_name: p.name,
        position: p.position,
        real_team: p.team_affiliation,
        fantasy_team_id: p.drafted_by,
        fantasy_team_name: team?.name,
        is_starter: isStarter,
        stats: entry?.stats ?? null,
        points: entry?.points ?? null,
        points_breakdown: entry?.points_breakdown ?? null
      };
    }).sort((a, b) => (b.points ?? -Infinity) - (a.points ?? -Infinity));

    const teamBreakdown = teams.map(team => {
      const tp = playerStats.filter(p => p.fantasy_team_id === team.id);
      const lineup = lineupMap[team.id];
      const scoringPlayers = lineup?.submitted ? tp.filter(p => p.is_starter) : tp;
      const total = Math.round(scoringPlayers.reduce((s, p) => s + (p.points ?? 0), 0) * 10) / 10;
      return { team_id: team.id, team_name: team.name, round_points: total, lineup_submitted: !!lineup?.submitted, players: tp };
    }).sort((a, b) => b.round_points - a.round_points);

    const { commissioner_token, ...leaguePublic } = league;
    res.json({ league: leaguePublic, round, player_stats: playerStats, team_breakdown: teamBreakdown });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/leagues/:id/rounds/:roundId/stats', async (req, res) => {
  try {
    const commToken = req.headers['x-commissioner-token'];
    const { league, error, status } = await getLeagueWithAuth(req.params.id, commToken);
    if (error) return res.status(status).json({ error });

    const round = await db.get('SELECT * FROM rounds WHERE id = $1 AND league_id = $2',
      [req.params.roundId, req.params.id]);
    if (!round) return res.status(404).json({ error: 'Round not found' });

    const { player_id, stats, preview_only } = req.body;
    if (!player_id || !stats) return res.status(400).json({ error: 'player_id and stats required' });

    const rules = (league.scoring_rules?.rules) || [];
    const { total, breakdown } = calculatePoints(stats, rules);

    if (preview_only) return res.json({ points: total, breakdown });

    const player = await db.get('SELECT * FROM players WHERE id = $1 AND draft_id = $2',
      [player_id, league.draft_id]);
    if (!player) return res.status(404).json({ error: 'Player not found in this league' });

    await db.run(`
      INSERT INTO stat_entries (id, league_id, round_id, player_id, stats, points, points_breakdown)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(round_id, player_id) DO UPDATE SET
        stats = EXCLUDED.stats, points = EXCLUDED.points, points_breakdown = EXCLUDED.points_breakdown
    `, [randomUUID(), req.params.id, req.params.roundId, player_id,
        JSON.stringify(stats), total, JSON.stringify(breakdown)]);

    res.json({ points: total, breakdown });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/leagues/:id/team/:teamId', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });

    const team = await db.get('SELECT * FROM teams WHERE id = $1 AND draft_id = $2',
      [req.params.teamId, league.draft_id]);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const players = await db.all('SELECT * FROM players WHERE drafted_by = $1 ORDER BY LOWER(name)', [req.params.teamId]);
    const rounds = await db.all('SELECT * FROM rounds WHERE league_id = $1 ORDER BY round_number', [req.params.id]);

    const playerIds = players.map(p => p.id);
    const entries = playerIds.length ? await db.all(`
      SELECT se.*, r.name as round_name, r.round_number, r.status as round_status
      FROM stat_entries se JOIN rounds r ON se.round_id = r.id
      WHERE se.player_id = ANY($1) AND se.league_id = $2
    `, [playerIds, req.params.id]) : [];

    const lineupRows = await db.all(
      'SELECT * FROM lineups WHERE team_id = $1 AND league_id = $2',
      [req.params.teamId, req.params.id]
    );

    // Per-round lineup lookup: { round_id: { submitted, starters: Set } }
    const lineupByRound = {};
    for (const l of lineupRows) {
      if (!lineupByRound[l.round_id]) lineupByRound[l.round_id] = { submitted: true, starters: new Set() };
      if (l.is_starter) lineupByRound[l.round_id].starters.add(l.player_id);
    }

    const playerData = players.map(p => {
      const pEntries = entries.filter(e => e.player_id === p.id)
        .sort((a, b) => a.round_number - b.round_number)
        .map(e => ({
          ...e,
          is_starter: lineupByRound[e.round_id]
            ? lineupByRound[e.round_id].starters.has(p.id)
            : null
        }));
      // Only count starters' points in total
      const totalPts = Math.round(pEntries.reduce((s, e) => {
        const lineup = lineupByRound[e.round_id];
        if (!lineup?.submitted || lineup.starters.has(p.id)) return s + e.points;
        return s;
      }, 0) * 10) / 10;
      return { ...p, round_stats: pEntries, total_points: totalPts };
    }).sort((a, b) => b.total_points - a.total_points);

    // Round-level lineup summary for the UI
    const roundLineups = rounds.map(r => ({
      round_id: r.id,
      round_name: r.name,
      round_number: r.round_number,
      status: r.status,
      submitted: !!lineupByRound[r.id]?.submitted,
      starter_count: lineupByRound[r.id] ? lineupByRound[r.id].starters.size : 0
    }));

    const { commissioner_token, ...leaguePublic } = league;
    res.json({ league: leaguePublic, team, players: playerData, rounds: roundLineups });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/leagues/:id/rounds/:roundId/lineup/:teamId', async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT player_id, is_starter FROM lineups WHERE round_id = $1 AND team_id = $2 AND league_id = $3',
      [req.params.roundId, req.params.teamId, req.params.id]
    );
    res.json({
      submitted: rows.length > 0,
      starters: rows.filter(r => r.is_starter).map(r => r.player_id),
      bench: rows.filter(r => !r.is_starter).map(r => r.player_id)
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/leagues/:id/rounds/:roundId/lineup', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });

    const round = await db.get('SELECT * FROM rounds WHERE id = $1 AND league_id = $2',
      [req.params.roundId, req.params.id]);
    if (!round) return res.status(404).json({ error: 'Round not found' });
    if (round.status === 'completed') return res.status(400).json({ error: 'Round is completed — lineup locked' });

    const { team_token, starter_ids } = req.body;
    if (!team_token || !Array.isArray(starter_ids))
      return res.status(400).json({ error: 'team_token and starter_ids required' });

    const team = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2',
      [league.draft_id, team_token]);
    if (!team) return res.status(403).json({ error: 'Invalid team token' });

    const players = await db.all('SELECT id FROM players WHERE drafted_by = $1', [team.id]);
    const playerIds = new Set(players.map(p => p.id));

    const invalid = starter_ids.filter(id => !playerIds.has(id));
    if (invalid.length) return res.status(400).json({ error: 'Some starter IDs not in your squad' });

    const maxStarters = league.starting_size || 11;
    if (starter_ids.length > maxStarters)
      return res.status(400).json({ error: `Max ${maxStarters} starters allowed` });

    const starterSet = new Set(starter_ids);
    await db.transaction(async (client) => {
      await client.query('DELETE FROM lineups WHERE round_id = $1 AND team_id = $2 AND league_id = $3',
        [req.params.roundId, team.id, req.params.id]);
      for (const player of players) {
        await client.query(
          'INSERT INTO lineups (id, league_id, round_id, team_id, player_id, is_starter) VALUES ($1,$2,$3,$4,$5,$6)',
          [randomUUID(), req.params.id, req.params.roundId, team.id, player.id, starterSet.has(player.id)]
        );
      }
    });

    res.json({ success: true, starters: starter_ids.length, bench: players.length - starter_ids.length });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('join-draft', async ({ draftId, commissionerToken, teamToken }) => {
    socket.join(`draft:${draftId}`);
    socket.data.draftId = draftId;

    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft) { socket.emit('error', { message: 'Draft not found' }); return; }

    socket.data.isCommissioner = draft.commissioner_token === commissionerToken;

    if (teamToken) {
      const team = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [draftId, teamToken]);
      if (team) { socket.data.teamId = team.id; socket.data.teamToken = teamToken; }
    }

    socket.emit('init', {
      state: await getDraftState(draftId),
      isCommissioner: socket.data.isCommissioner,
      teamId: socket.data.teamId || null
    });
  });

  socket.on('start-draft', async ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken || draft.status !== 'waiting') return;

    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY RANDOM()', [draftId]);
    if (teams.length < 2) { socket.emit('error', { message: 'Need at least 2 teams to start' }); return; }

    const countRow = await db.get('SELECT COUNT(*) as c FROM players WHERE draft_id = $1', [draftId]);
    if (parseInt(countRow.c) === 0) { socket.emit('error', { message: 'Upload a player pool before starting' }); return; }

    await db.transaction(async (client) => {
      for (let i = 0; i < teams.length; i++) {
        await client.query('UPDATE teams SET pick_order = $1 WHERE id = $2', [i, teams[i].id]);
      }
    });
    await db.run('UPDATE drafts SET status = $1, num_teams = $2 WHERE id = $3',
      ['active', teams.length, draftId]);

    const state = await getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
    io.to(`draft:${draftId}`).emit('draft-started', {});

    if (draft.format !== 'auction' && draft.mode === 'live') await startPickTimer(draftId);
    else if (draft.format === 'auction') await autoNominateNext(draftId);
  });

  socket.on('make-pick', async ({ teamToken, playerId }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.status !== 'active' || draft.format === 'auction') return;

    const team = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [draftId, teamToken]);
    if (!team) return;

    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
    const expectedIdx = getTeamIndexForPick(draft.current_pick, teams.length, draft.format);
    if (teams[expectedIdx]?.id !== team.id) {
      socket.emit('error', { message: "It's not your turn" });
      return;
    }

    await processPick(draftId, playerId, teamToken, false);
  });

  socket.on('nominate-player', async ({ commissionerToken, playerId }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    if (draft.format !== 'auction' || draft.status !== 'active') return;
    if (draft.current_nomination) { socket.emit('error', { message: 'Nomination already active' }); return; }

    await startNomination(draftId, playerId);
  });

  socket.on('place-bid', async ({ teamToken, amount }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.format !== 'auction' || draft.status !== 'active' || !draft.current_nomination) return;

    const team = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [draftId, teamToken]);
    if (!team) return;

    const bid = parseInt(amount);
    if (isNaN(bid) || bid < 1 || bid > team.budget) {
      socket.emit('error', { message: `Bid must be between $1 and $${team.budget}` });
      return;
    }

    const topRow = await db.get(
      'SELECT MAX(amount) as top FROM bids WHERE draft_id = $1 AND player_id = $2',
      [draftId, draft.current_nomination]
    );
    const currentTop = parseInt(topRow?.top) || 0;
    if (bid <= currentTop) {
      socket.emit('error', { message: `Bid must be higher than current top bid of $${currentTop}` });
      return;
    }

    await db.run(`
      INSERT INTO bids (id, draft_id, player_id, team_id, amount)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(draft_id, player_id, team_id) DO UPDATE SET amount = EXCLUDED.amount, created_at = NOW()
    `, [randomUUID(), draftId, draft.current_nomination, team.id, bid]);

    const BID_EXTENSION_MS = 20 * 1000;
    const currentTimer = activeTimers.get(draftId);
    if (currentTimer && draft.mode === 'live') {
      const remaining = currentTimer.endsAt - Date.now();
      if (remaining < BID_EXTENSION_MS) {
        const newEndsAt = Date.now() + BID_EXTENSION_MS;
        await db.run('UPDATE drafts SET nomination_ends_at = $1 WHERE id = $2',
          [new Date(newEndsAt).toISOString(), draftId]);
        await startPickTimer(draftId, newEndsAt);
      }
    }

    io.to(`draft:${draftId}`).emit('bid-placed', {
      teamId: team.id, teamName: team.name, amount: bid
    });
  });

  socket.on('close-auction', async ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    clearPickTimer(draftId);
    await closeAuction(draftId);
  });

  socket.on('skip-nomination', async ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    if (!draft.current_nomination) return;
    clearPickTimer(draftId);
    await db.run('UPDATE players SET unsold = 1 WHERE id = $1', [draft.current_nomination]);
    await db.run(
      'UPDATE drafts SET current_nomination = NULL, nomination_ends_at = NULL WHERE id = $1',
      [draftId]
    );
    const countRow = await db.get(
      'SELECT COUNT(*) as c FROM players WHERE draft_id = $1 AND drafted_by IS NULL AND unsold = 0', [draftId]
    );
    if (parseInt(countRow.c) === 0) {
      await db.run("UPDATE drafts SET status = 'completed' WHERE id = $1", [draftId]);
    }
    const updatedDraft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (updatedDraft.status === 'active' && !updatedDraft.auction_paused) {
      await autoNominateNext(draftId);
    } else {
      const state = await getDraftState(draftId);
      io.to(`draft:${draftId}`).emit('draft-state', state);
    }
  });

  socket.on('pause-auction', async ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    if (draft.format !== 'auction' || draft.status !== 'active' || draft.auction_paused) return;

    const currentTimer = activeTimers.get(draftId);
    const remaining = currentTimer ? Math.max(0, currentTimer.endsAt - Date.now()) : null;
    clearPickTimer(draftId);

    await db.run('UPDATE drafts SET auction_paused = 1, nomination_paused_remaining_ms = $1 WHERE id = $2',
      [remaining, draftId]);

    const state = await getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
  });

  socket.on('resume-auction', async ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    if (draft.format !== 'auction' || draft.status !== 'active' || !draft.auction_paused) return;

    await db.run('UPDATE drafts SET auction_paused = 0, nomination_paused_remaining_ms = NULL WHERE id = $1',
      [draftId]);

    if (draft.current_nomination) {
      if (draft.mode === 'live' && draft.nomination_paused_remaining_ms > 0) {
        const newEndsAt = Date.now() + draft.nomination_paused_remaining_ms;
        await db.run('UPDATE drafts SET nomination_ends_at = $1 WHERE id = $2',
          [new Date(newEndsAt).toISOString(), draftId]);
        await startPickTimer(draftId, newEndsAt);
      }
      const state = await getDraftState(draftId);
      io.to(`draft:${draftId}`).emit('draft-state', state);
    } else {
      await autoNominateNext(draftId);
    }
  });

  socket.on('complete-draft', async ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    clearPickTimer(draftId);
    await db.run("UPDATE drafts SET status = 'completed' WHERE id = $1", [draftId]);
    const state = await getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────

const activeDrafts = await db.all(
  "SELECT * FROM drafts WHERE status = 'active' AND mode = 'live' AND pick_timer > 0"
);
for (const draft of activeDrafts) {
  if (draft.format !== 'auction') await startPickTimer(draft.id);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Fantasy Draft running at http://localhost:${PORT}`);
});
