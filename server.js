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

function getDraftState(draftId) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft) return null;
  const teams = db.prepare('SELECT * FROM teams WHERE draft_id = ? ORDER BY pick_order').all(draftId);
  const players = db.prepare(
    'SELECT * FROM players WHERE draft_id = ? ORDER BY name COLLATE NOCASE'
  ).all(draftId);
  const { commissioner_token, ...draftPublic } = draft;
  return {
    ...draftPublic,
    teams,
    players: players.map(p => ({ ...p, metadata: p.metadata ? JSON.parse(p.metadata) : {} }))
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

function bulkInsertPlayers(draftId, records) {
  const stmt = db.prepare(
    'INSERT INTO players (id, draft_id, name, position, team_affiliation, metadata) VALUES (?, ?, ?, ?, ?, ?)'
  );
  let count = 0;
  db.transaction(() => {
    for (const row of records) {
      const lc = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v]));
      const name = lc.name || lc.player || lc['player name'] || lc['player_name'];
      if (!name?.trim()) continue;
      const { name: _a, player: _b, position, pos, team, team_affiliation, ...rest } = lc;
      stmt.run(
        randomUUID(), draftId, name.trim(),
        position || pos || null,
        team || team_affiliation || null,
        Object.keys(rest).length ? JSON.stringify(rest) : null
      );
      count++;
    }
  })();
  return count;
}

// ── Timer Management ──────────────────────────────────────────────────────────

const activeTimers = new Map(); // draftId -> { interval, endsAt }

function startPickTimer(draftId) {
  clearPickTimer(draftId);
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft || draft.status !== 'active' || draft.pick_timer === 0) return;

  const endsAt = Date.now() + draft.pick_timer * 1000;

  const interval = setInterval(() => {
    const remaining = Math.max(0, endsAt - Date.now());
    io.to(`draft:${draftId}`).emit('timer-tick', { remaining });

    if (remaining === 0) {
      clearPickTimer(draftId);
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
      if (d?.status === 'active') {
        if (d.format === 'auction') closeAuction(draftId);
        else autoPick(draftId);
      }
    }
  }, 500);

  activeTimers.set(draftId, { interval, endsAt });
}

function clearPickTimer(draftId) {
  const entry = activeTimers.get(draftId);
  if (entry) { clearInterval(entry.interval); activeTimers.delete(draftId); }
}

function autoPick(draftId) {
  const player = db.prepare(
    'SELECT id FROM players WHERE draft_id = ? AND drafted_by IS NULL ORDER BY rowid LIMIT 1'
  ).get(draftId);
  if (player) processPick(draftId, player.id, null, true);
}

// ── Pick Processing ───────────────────────────────────────────────────────────

function processPick(draftId, playerId, teamToken, isAutoPick = false) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft || draft.status !== 'active') return false;

  const teams = db.prepare('SELECT * FROM teams WHERE draft_id = ? ORDER BY pick_order').all(draftId);
  const expectedIdx = getTeamIndexForPick(draft.current_pick, teams.length, draft.format);
  const pickingTeam = teams[expectedIdx];

  if (!isAutoPick && teamToken && pickingTeam?.token !== teamToken) return false;

  const player = db.prepare(
    'SELECT * FROM players WHERE id = ? AND draft_id = ? AND drafted_by IS NULL'
  ).get(playerId, draftId);
  if (!player) return false;

  db.prepare('UPDATE players SET drafted_by = ?, pick_number = ? WHERE id = ?')
    .run(pickingTeam.id, draft.current_pick, playerId);

  const remaining = db.prepare(
    'SELECT COUNT(*) as c FROM players WHERE draft_id = ? AND drafted_by IS NULL'
  ).get(draftId).c;
  const nextPick = draft.current_pick + 1;

  if (remaining === 0) {
    db.prepare("UPDATE drafts SET status = 'completed', current_pick = ? WHERE id = ?").run(nextPick, draftId);
    clearPickTimer(draftId);
  } else {
    db.prepare('UPDATE drafts SET current_pick = ? WHERE id = ?').run(nextPick, draftId);
    if (draft.mode === 'live') startPickTimer(draftId);
  }

  const state = getDraftState(draftId);
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

function startNomination(draftId, playerId) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft || draft.status !== 'active') return;

  const player = db.prepare(
    'SELECT * FROM players WHERE id = ? AND draft_id = ? AND drafted_by IS NULL'
  ).get(playerId, draftId);
  if (!player) return;

  const endsAt = new Date(Date.now() + draft.pick_timer * 1000).toISOString();
  db.prepare('UPDATE drafts SET current_nomination = ?, nomination_ends_at = ? WHERE id = ?')
    .run(playerId, endsAt, draftId);

  if (draft.mode === 'live') startPickTimer(draftId);

  const state = getDraftState(draftId);
  io.to(`draft:${draftId}`).emit('draft-state', state);
}

function closeAuction(draftId) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft || !draft.current_nomination) return;

  const topBid = db.prepare(`
    SELECT b.*, t.budget FROM bids b
    JOIN teams t ON b.team_id = t.id
    WHERE b.draft_id = ? AND b.player_id = ?
    ORDER BY b.amount DESC, b.created_at ASC LIMIT 1
  `).get(draftId, draft.current_nomination);

  const teams = db.prepare('SELECT * FROM teams WHERE draft_id = ? ORDER BY pick_order').all(draftId);
  const winnerId = topBid ? topBid.team_id : teams[0]?.id;
  const winAmount = topBid ? topBid.amount : 1;

  if (winnerId) {
    db.prepare('UPDATE players SET drafted_by = ?, pick_number = ?, bid_amount = ? WHERE id = ?')
      .run(winnerId, draft.current_pick, winAmount, draft.current_nomination);
    db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(winAmount, winnerId);
  }

  db.prepare(
    'UPDATE drafts SET current_pick = current_pick + 1, current_nomination = NULL, nomination_ends_at = NULL WHERE id = ?'
  ).run(draftId);

  const remaining = db.prepare(
    'SELECT COUNT(*) as c FROM players WHERE draft_id = ? AND drafted_by IS NULL'
  ).get(draftId).c;
  if (remaining === 0) {
    db.prepare("UPDATE drafts SET status = 'completed' WHERE id = ?").run(draftId);
  }

  const state = getDraftState(draftId);
  const winnerTeam = teams.find(t => t.id === winnerId);
  const wonPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(draft.current_nomination);
  io.to(`draft:${draftId}`).emit('auction-closed', {
    player: { id: wonPlayer?.id, name: wonPlayer?.name },
    team: { id: winnerId, name: winnerTeam?.name },
    amount: winAmount
  });
  io.to(`draft:${draftId}`).emit('draft-state', state);
}

// ── API Routes ────────────────────────────────────────────────────────────────

app.post('/api/drafts', upload.single('players_csv'), (req, res) => {
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

    db.prepare(`
      INSERT INTO drafts (id, name, format, mode, num_teams, pick_timer, auction_budget, commissioner_token, position_requirements)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(draftId, name.trim(), format, mode, numTeams, timer, budget, commissionerToken, posReqs);

    let playerCount = 0;
    if (req.file) {
      const records = parseCsvBuffer(req.file.buffer);
      playerCount = bulkInsertPlayers(draftId, records);
    }

    res.json({ draft_id: draftId, commissioner_token: commissionerToken, player_count: playerCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drafts/:id/players', upload.single('players_csv'), (req, res) => {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.commissioner_token !== req.headers['x-commissioner-token'])
    return res.status(403).json({ error: 'Unauthorized' });
  if (draft.status !== 'waiting')
    return res.status(400).json({ error: 'Cannot upload players after draft has started' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    db.prepare('DELETE FROM players WHERE draft_id = ?').run(req.params.id);
    const records = parseCsvBuffer(req.file.buffer);
    const count = bulkInsertPlayers(req.params.id, records);
    const state = getDraftState(req.params.id);
    io.to(`draft:${req.params.id}`).emit('draft-state', state);
    res.json({ player_count: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drafts/:id', (req, res) => {
  const state = getDraftState(req.params.id);
  if (!state) return res.status(404).json({ error: 'Draft not found' });
  res.json(state);
});

app.post('/api/drafts/:id/team-by-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const team = db.prepare('SELECT id FROM teams WHERE draft_id = ? AND token = ?').get(req.params.id, token);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json({ team_id: team.id });
});

app.delete('/api/drafts/:id', (req, res) => {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.commissioner_token !== req.headers['x-commissioner-token'])
    return res.status(403).json({ error: 'Unauthorized' });

  db.transaction(() => {
    db.prepare('DELETE FROM bids WHERE draft_id = ?').run(req.params.id);
    db.prepare('DELETE FROM players WHERE draft_id = ?').run(req.params.id);
    db.prepare('DELETE FROM teams WHERE draft_id = ?').run(req.params.id);
    db.prepare('DELETE FROM drafts WHERE id = ?').run(req.params.id);
  })();

  clearPickTimer(req.params.id);
  io.to(`draft:${req.params.id}`).emit('draft-deleted', {});
  res.json({ success: true });
});

app.post('/api/drafts/:id/join', (req, res) => {
  const { team_name } = req.body;
  if (!team_name?.trim()) return res.status(400).json({ error: 'team_name required' });

  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.status !== 'waiting') return res.status(400).json({ error: 'Draft already started' });

  const teamCount = db.prepare('SELECT COUNT(*) as c FROM teams WHERE draft_id = ?').get(req.params.id).c;
  if (teamCount >= draft.num_teams) return res.status(400).json({ error: 'Draft is full' });

  const teamId = randomUUID();
  const token = randomUUID();
  db.prepare(
    'INSERT INTO teams (id, draft_id, name, token, pick_order, budget) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(teamId, req.params.id, team_name.trim(), token, teamCount, draft.auction_budget);

  const state = getDraftState(req.params.id);
  io.to(`draft:${req.params.id}`).emit('draft-state', state);

  res.json({ team_id: teamId, token, pick_order: teamCount });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('join-draft', ({ draftId, commissionerToken, teamToken }) => {
    socket.join(`draft:${draftId}`);
    socket.data.draftId = draftId;

    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft) { socket.emit('error', { message: 'Draft not found' }); return; }

    socket.data.isCommissioner = draft.commissioner_token === commissionerToken;

    if (teamToken) {
      const team = db.prepare('SELECT * FROM teams WHERE draft_id = ? AND token = ?').get(draftId, teamToken);
      if (team) { socket.data.teamId = team.id; socket.data.teamToken = teamToken; }
    }

    socket.emit('init', {
      state: getDraftState(draftId),
      isCommissioner: socket.data.isCommissioner,
      teamId: socket.data.teamId || null
    });
  });

  socket.on('start-draft', ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft || draft.commissioner_token !== commissionerToken || draft.status !== 'waiting') return;

    const teams = db.prepare('SELECT * FROM teams WHERE draft_id = ? ORDER BY RANDOM()').all(draftId);
    if (teams.length < 2) { socket.emit('error', { message: 'Need at least 2 teams to start' }); return; }

    const playerCount = db.prepare('SELECT COUNT(*) as c FROM players WHERE draft_id = ?').get(draftId).c;
    if (playerCount === 0) { socket.emit('error', { message: 'Upload a player pool before starting' }); return; }

    const updateOrder = db.prepare('UPDATE teams SET pick_order = ? WHERE id = ?');
    db.transaction(() => teams.forEach((t, i) => updateOrder.run(i, t.id)))();
    db.prepare('UPDATE drafts SET status = ?, num_teams = ? WHERE id = ?')
      .run('active', teams.length, draftId);

    const state = getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
    io.to(`draft:${draftId}`).emit('draft-started', {});

    if (draft.format !== 'auction' && draft.mode === 'live') startPickTimer(draftId);
  });

  socket.on('make-pick', ({ teamToken, playerId }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft || draft.status !== 'active' || draft.format === 'auction') return;

    const team = db.prepare('SELECT * FROM teams WHERE draft_id = ? AND token = ?').get(draftId, teamToken);
    if (!team) return;

    const teams = db.prepare('SELECT * FROM teams WHERE draft_id = ? ORDER BY pick_order').all(draftId);
    const expectedIdx = getTeamIndexForPick(draft.current_pick, teams.length, draft.format);
    if (teams[expectedIdx]?.id !== team.id) {
      socket.emit('error', { message: "It's not your turn" });
      return;
    }

    processPick(draftId, playerId, teamToken, false);
  });

  socket.on('nominate-player', ({ commissionerToken, playerId }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    if (draft.format !== 'auction' || draft.status !== 'active') return;
    if (draft.current_nomination) { socket.emit('error', { message: 'Nomination already active' }); return; }

    startNomination(draftId, playerId);
  });

  socket.on('place-bid', ({ teamToken, amount }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft || draft.format !== 'auction' || draft.status !== 'active' || !draft.current_nomination) return;

    const team = db.prepare('SELECT * FROM teams WHERE draft_id = ? AND token = ?').get(draftId, teamToken);
    if (!team) return;

    const bid = parseInt(amount);
    if (isNaN(bid) || bid < 1 || bid > team.budget) {
      socket.emit('error', { message: `Bid must be between $1 and $${team.budget}` });
      return;
    }

    db.prepare(`
      INSERT INTO bids (id, draft_id, player_id, team_id, amount)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, player_id, team_id) DO UPDATE SET amount = excluded.amount, created_at = datetime('now')
    `).run(randomUUID(), draftId, draft.current_nomination, team.id, bid);

    io.to(`draft:${draftId}`).emit('bid-placed', {
      teamId: team.id, teamName: team.name, amount: bid
    });
  });

  socket.on('close-auction', ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    clearPickTimer(draftId);
    closeAuction(draftId);
  });

  socket.on('skip-nomination', ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    clearPickTimer(draftId);
    db.prepare(
      'UPDATE drafts SET current_nomination = NULL, nomination_ends_at = NULL WHERE id = ?'
    ).run(draftId);
    const state = getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
  });

  socket.on('complete-draft', ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    clearPickTimer(draftId);
    db.prepare("UPDATE drafts SET status = 'completed' WHERE id = ?").run(draftId);
    const state = getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────

// Restore timers for active live drafts surviving a server restart
const activeDrafts = db.prepare(
  "SELECT * FROM drafts WHERE status = 'active' AND mode = 'live' AND pick_timer > 0"
).all();
for (const draft of activeDrafts) {
  if (draft.format !== 'auction') startPickTimer(draft.id);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Fantasy Draft running at http://localhost:${PORT}`);
});
