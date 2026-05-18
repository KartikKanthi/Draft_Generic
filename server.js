import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'crypto';
import db from './db.js';

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
