import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'crypto';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import db, { pool } from './db.js';
import { calculatePoints, SCORING_PRESETS } from './points.js';
import { sendPickNotification, sendDraftStartedNotification, sendTestEmail } from './email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PgStore = connectPgSimple(session);

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(join(__dirname, 'public')));

// ── Google OAuth ──────────────────────────────────────────────────────────────

if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await db.get('SELECT * FROM users WHERE google_id = $1', [profile.id]);
      if (!user) {
        const id = randomUUID();
        await db.run(
          'INSERT INTO users (id, google_id, email, name, avatar_url) VALUES ($1, $2, $3, $4, $5)',
          [id, profile.id, profile.emails[0].value, profile.displayName, profile.photos?.[0]?.value || null]
        );
        user = await db.get('SELECT * FROM users WHERE id = $1', [id]);
      }
      return done(null, user);
    } catch (err) { return done(err); }
  }));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    done(null, user || false);
  } catch (err) { done(err); }
});

app.get('/auth/google', (req, res, next) => {
  req.session.returnTo = req.headers.referer || '/';
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    const redirect = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(redirect);
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const { id, email, name, avatar_url } = req.user;
  res.json({ user: { id, email, name, avatar_url } });
});

app.get('/api/drafts/:id/commissioner-token', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const draft = await db.get('SELECT commissioner_token, owner_id FROM drafts WHERE id = $1', [req.params.id]);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your draft' });
  res.json({ commissioner_token: draft.commissioner_token });
});

app.get('/api/drafts/:id/my-team', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  const team = await db.get(
    'SELECT id, token FROM teams WHERE draft_id = $1 AND owner_id = $2',
    [req.params.id, req.user.id]
  );
  if (!team) return res.status(404).json({ error: 'No team found' });
  res.json({ team_id: team.id, token: team.token });
});

app.post('/api/test-email', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to address required' });
  const result = await sendTestEmail(to);
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/my-drafts', async (req, res) => {
  if (!req.user) return res.json({ commissioner_drafts: [], team_drafts: [] });

  const [commDrafts, teamRows] = await Promise.all([
    db.all('SELECT id FROM drafts WHERE owner_id = $1 ORDER BY created_at DESC', [req.user.id]),
    db.all('SELECT t.id AS team_id, t.token AS team_token, t.name AS team_name, t.draft_id FROM teams t WHERE t.owner_id = $1', [req.user.id])
  ]);

  const commIds = new Set(commDrafts.map(d => d.id));

  const [commStates, teamStates] = await Promise.all([
    Promise.all(commDrafts.map(d => getDraftState(d.id))),
    Promise.all(
      teamRows
        .filter(t => !commIds.has(t.draft_id))
        .map(async t => {
          const state = await getDraftState(t.draft_id);
          if (!state) return null;
          return { ...state, my_team_id: t.team_id, my_team_token: t.team_token, my_team_name: t.team_name };
        })
    )
  ]);

  res.json({
    commissioner_drafts: commStates.filter(Boolean),
    team_drafts: teamStates.filter(Boolean)
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getDraftState(draftId) {
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft) return null;
  const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
  const players = await db.all(
    'SELECT * FROM players WHERE draft_id = $1 ORDER BY sort_order, LOWER(name)', [draftId]
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
    current_bids: currentBids,
    is_slow_draft: draft.mode === 'async' && draft.pick_timer > 0,
    quiet_hours_start: draft.quiet_hours_start ?? 0,
    quiet_hours_end: draft.quiet_hours_end ?? 8,
    quiet_timezone: draft.quiet_timezone || 'Europe/London'
  };
}

function getTeamIndexForPick(pickNumber, numTeams, format) {
  const round = Math.floor(pickNumber / numTeams);
  const pickInRound = pickNumber % numTeams;
  if (format === 'snake') return round % 2 === 0 ? pickInRound : numTeams - 1 - pickInRound;
  return pickInRound;
}

function getPickOwner(pickNumber, teams, format, pickOwnership) {
  const override = (pickOwnership || {})[String(pickNumber)];
  if (override) return override;
  const idx = getTeamIndexForPick(pickNumber, teams.length, format);
  return teams[idx]?.id ?? null;
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
      const { name: _a, player: _b, position, pos, team, team_affiliation, country, nation, nationality, ...rest } = lc;
      await client.query(
        'INSERT INTO players (id, draft_id, name, position, team_affiliation, country, metadata, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [randomUUID(), draftId, name.trim(), position || pos || null, team || team_affiliation || null,
         country || nation || nationality || null,
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
  if (entry) {
    if (entry.interval) clearInterval(entry.interval);
    if (entry.timeout) clearTimeout(entry.timeout);
    activeTimers.delete(draftId);
  }
}

// ── Quiet-Hours Helpers ───────────────────────────────────────────────────────

function hourInTz(ms, timezone) {
  const h = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', hour12: false
  }).format(new Date(ms)));
  return h === 24 ? 0 : h;
}

// Scan minute-by-minute until we hit the start of targetHour in the given timezone.
// Handles DST transitions correctly.
function nextTzHour(fromMs, targetHour, timezone) {
  let t = Math.ceil(fromMs / 60000) * 60000;
  for (let i = 0; i < 26 * 60; i++) {
    if (hourInTz(t, timezone) === targetHour && hourInTz(t - 60000, timezone) !== targetHour) return t;
    t += 60000;
  }
  return fromMs + 27 * 3600000; // safety fallback
}

// Compute pick deadline accounting for quiet hours (hours don't count during quiet window).
function deadlineSkippingQuiet(fromMs, pickHours, quietStart, quietEnd, timezone) {
  if (quietStart === quietEnd) return fromMs + pickHours * 3600000;

  let remaining = pickHours * 3600000;
  let t = fromMs;

  for (let i = 0; i < 100 && remaining > 0; i++) {
    const h = hourInTz(t, timezone);
    if (h >= quietStart && h < quietEnd) {
      t = nextTzHour(t, quietEnd, timezone);
      continue;
    }
    const nextQ = nextTzHour(t, quietStart, timezone);
    const active = nextQ - t;
    if (remaining <= active) { t += remaining; remaining = 0; }
    else { remaining -= active; t = nextQ; }
  }

  return t;
}

// ── Slow Draft Deadline ───────────────────────────────────────────────────────

async function startSlowPickDeadline(draftId) {
  clearPickTimer(draftId);
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft || draft.status !== 'active' || !draft.pick_deadline) return;

  const endsAt = new Date(draft.pick_deadline).getTime();
  const delay = Math.max(0, endsAt - Date.now());

  const timeout = setTimeout(async () => {
    activeTimers.delete(draftId);
    const d = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (d?.status === 'active' && d.mode === 'async') {
      await autoPick(draftId);
    }
  }, delay);

  activeTimers.set(draftId, { timeout, endsAt });
}

async function setSlowPickDeadlineAndNotify(draftId, nextPickNumber) {
  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!draft || draft.pick_timer === 0) return;

  const qs = draft.quiet_hours_start ?? 0;
  const qe = draft.quiet_hours_end ?? 8;
  const tz = draft.quiet_timezone || 'Europe/London';
  const deadlineMs = deadlineSkippingQuiet(Date.now(), draft.pick_timer, qs, qe, tz);
  const deadline = new Date(deadlineMs).toISOString();
  await db.run('UPDATE drafts SET pick_deadline = $1 WHERE id = $2', [deadline, draftId]);

  startSlowPickDeadline(draftId);

  const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
  const pickOwnership = draft.pick_ownership || {};
  const nextTeamId = getPickOwner(nextPickNumber, teams, draft.format, pickOwnership);
  const nextTeam = teams.find(t => t.id === nextTeamId);
  if (nextTeam?.email) {
    const round = Math.floor(nextPickNumber / teams.length) + 1;
    const pickInRound = (nextPickNumber % teams.length) + 1;
    sendPickNotification({
      teamName: nextTeam.name,
      email: nextTeam.email,
      draftName: draft.name,
      draftId,
      teamToken: nextTeam.token,
      deadlineHours: draft.pick_timer,
      round,
      pickInRound,
    });
  }
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
  const pickOwnershipMap = draft.pick_ownership || {};
  const pickingTeamId = getPickOwner(draft.current_pick, teams, draft.format, pickOwnershipMap);
  const pickingTeam = teams.find(t => t.id === pickingTeamId);

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
  let nextPick = draft.current_pick + 1;
  const picksPerTeam = draft.picks_per_team || 0;

  let draftDone = remaining === 0;

  if (!draftDone && picksPerTeam > 0) {
    const pickCounts = await db.all(
      'SELECT drafted_by, COUNT(*) as c FROM players WHERE draft_id = $1 AND drafted_by IS NOT NULL GROUP BY drafted_by',
      [draftId]
    );
    const countMap = Object.fromEntries(pickCounts.map(r => [r.drafted_by, parseInt(r.c)]));
    if (teams.every(t => (countMap[t.id] || 0) >= picksPerTeam)) {
      draftDone = true;
    } else {
      while ((countMap[teams[getTeamIndexForPick(nextPick, teams.length, draft.format)]?.id] || 0) >= picksPerTeam) {
        nextPick++;
      }
    }
  }

  if (draftDone) {
    await db.run("UPDATE drafts SET status = 'completed', current_pick = $1, pick_deadline = NULL WHERE id = $2", [nextPick, draftId]);
    clearPickTimer(draftId);
  } else {
    await db.run('UPDATE drafts SET current_pick = $1 WHERE id = $2', [nextPick, draftId]);
    if (draft.mode === 'live') await startPickTimer(draftId);
    else if (draft.mode === 'async' && draft.pick_timer > 0) await setSlowPickDeadlineAndNotify(draftId, nextPick);
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
  let auctionDone = parseInt(countRow.c) === 0;

  if (!auctionDone && draft.picks_per_team > 0) {
    const allTeams = await db.all('SELECT id FROM teams WHERE draft_id = $1', [draftId]);
    const pickCounts = await db.all(
      'SELECT drafted_by, COUNT(*) as c FROM players WHERE draft_id = $1 AND drafted_by IS NOT NULL GROUP BY drafted_by',
      [draftId]
    );
    const countMap = Object.fromEntries(pickCounts.map(r => [r.drafted_by, parseInt(r.c)]));
    if (allTeams.every(t => (countMap[t.id] || 0) >= draft.picks_per_team)) auctionDone = true;
  }

  if (auctionDone) {
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
    const { name, format, mode, num_teams, pick_timer, auction_budget, position_requirements, picks_per_team,
            quiet_hours_start, quiet_hours_end, quiet_timezone } = req.body;
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
    const ppt = Math.max(0, parseInt(picks_per_team) || 0);
    const ownerId = req.user?.id || null;
    const quietStart = parseInt(quiet_hours_start ?? 0);
    const quietEnd = parseInt(quiet_hours_end ?? 8);
    const quietTz = quiet_timezone || 'Europe/London';

    await db.run(`
      INSERT INTO drafts (id, name, format, mode, num_teams, pick_timer, auction_budget, commissioner_token, position_requirements, picks_per_team, owner_id, quiet_hours_start, quiet_hours_end, quiet_timezone)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [draftId, name.trim(), format, mode, numTeams, timer, budget, commissionerToken, posReqs, ppt, ownerId, quietStart, quietEnd, quietTz]);

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
    // Delete leaf tables first (deepest FK dependencies), then parents
    await client.query(`DELETE FROM stat_entries WHERE league_id IN (SELECT id FROM leagues WHERE draft_id = $1)`, [req.params.id]);
    await client.query(`DELETE FROM lineups WHERE league_id IN (SELECT id FROM leagues WHERE draft_id = $1)`, [req.params.id]);
    await client.query(`DELETE FROM trades WHERE league_id IN (SELECT id FROM leagues WHERE draft_id = $1)`, [req.params.id]);
    await client.query(`DELETE FROM waiver_claims WHERE league_id IN (SELECT id FROM leagues WHERE draft_id = $1)`, [req.params.id]);
    await client.query(`DELETE FROM rounds WHERE league_id IN (SELECT id FROM leagues WHERE draft_id = $1)`, [req.params.id]);
    await client.query('DELETE FROM leagues WHERE draft_id = $1', [req.params.id]);
    await client.query('DELETE FROM draft_trades WHERE draft_id = $1', [req.params.id]);
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
  const { team_name, email } = req.body;
  if (!team_name?.trim()) return res.status(400).json({ error: 'team_name required' });

  const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [req.params.id]);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.status !== 'waiting') return res.status(400).json({ error: 'Draft already started' });

  const countRow = await db.get('SELECT COUNT(*) as c FROM teams WHERE draft_id = $1', [req.params.id]);
  const teamCount = parseInt(countRow.c);
  if (teamCount >= draft.num_teams) return res.status(400).json({ error: 'Draft is full' });

  const teamId = randomUUID();
  const token = randomUUID();
  const teamEmail = email?.trim() || null;
  const teamOwnerId = req.user?.id || null;
  await db.run(
    'INSERT INTO teams (id, draft_id, name, token, pick_order, budget, email, owner_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [teamId, req.params.id, team_name.trim(), token, teamCount, draft.auction_budget, teamEmail, teamOwnerId]
  );

  const state = await getDraftState(req.params.id);
  io.to(`draft:${req.params.id}`).emit('draft-state', state);

  res.json({ team_id: teamId, token, pick_order: teamCount });
});

app.put('/api/drafts/:id/pick-order', async (req, res) => {
  try {
    const commToken = req.headers['x-commissioner-token'];
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [req.params.id]);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.commissioner_token !== commToken) return res.status(403).json({ error: 'Unauthorized' });
    if (draft.status !== 'waiting') return res.status(400).json({ error: 'Cannot reorder after draft has started' });

    const { team_ids } = req.body;
    if (!Array.isArray(team_ids) || team_ids.length === 0)
      return res.status(400).json({ error: 'team_ids must be a non-empty array' });

    const teams = await db.all('SELECT id FROM teams WHERE draft_id = $1', [req.params.id]);
    const validIds = new Set(teams.map(t => t.id));
    if (team_ids.some(id => !validIds.has(id)))
      return res.status(400).json({ error: 'Invalid team ID in list' });

    await db.transaction(async (client) => {
      for (let i = 0; i < team_ids.length; i++) {
        await client.query('UPDATE teams SET pick_order = $1 WHERE id = $2 AND draft_id = $3',
          [i, team_ids[i], req.params.id]);
      }
    });

    const state = await getDraftState(req.params.id);
    io.to(`draft:${req.params.id}`).emit('draft-state', state);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.put('/api/drafts/:id/teams/:teamId/email', async (req, res) => {
  const { token, email } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const team = await db.get('SELECT * FROM teams WHERE id = $1 AND draft_id = $2 AND token = $3',
    [req.params.teamId, req.params.id, token]);
  if (!team) return res.status(403).json({ error: 'Invalid team token' });
  await db.run('UPDATE teams SET email = $1 WHERE id = $2', [email?.trim() || null, req.params.teamId]);
  res.json({ success: true });
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

// ── Sheet Import ─────────────────────────────────────────────────────────────

function parseRosterData(rows) {
  const managers = [];
  let currentManager = null;
  let isStarters = true;

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    const managerName = (row[0] || '').trim();
    const sectionLabel = (row[3] || '').trim();

    if (!managerName) continue; // separator / summary rows

    if (!currentManager || currentManager.name !== managerName) {
      if (currentManager) managers.push(currentManager);
      currentManager = { name: managerName, players: {} };
      isStarters = true;
    }

    if (sectionLabel === 'Sub') isStarters = false;
    else if (sectionLabel === 'Team') isStarters = true;

    // Each week occupies 3 cols starting at col 4: [playerName, role, points]
    for (let w = 0; w < 11; w++) {
      const base = 4 + w * 3;
      const name = (row[base] || '').trim();
      if (!name || name === '#N/A') continue;

      const role = (row[base + 1] || '').trim().replace(/\s*-\s*\d+$/, '');
      const pts = parseFloat(row[base + 2]);
      if (isNaN(pts)) continue;

      if (!currentManager.players[name]) {
        currentManager.players[name] = { role, weeks: {} };
      }
      currentManager.players[name].weeks[w + 1] = { pts, isStarter: isStarters };
    }
  }

  if (currentManager) managers.push(currentManager);
  return managers;
}

app.post('/api/import/ipl-sheet', async (req, res) => {
  try {
    const { sheet_id, league_name } = req.body;
    if (!sheet_id) return res.status(400).json({ error: 'sheet_id required' });

    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheet_id}/gviz/tq?tqx=out:csv&gid=583658764`;
    const csvRes = await fetch(csvUrl);
    if (!csvRes.ok) return res.status(400).json({ error: 'Could not fetch the sheet. Make sure it is set to "Anyone with the link can view".' });
    const csvText = await csvRes.text();

    const rows = parse(csvText, { relax_quotes: true, skip_empty_lines: false });
    const managers = parseRosterData(rows);
    if (!managers.length) return res.status(400).json({ error: 'No roster data found. Check the sheet format.' });

    const draftId = randomUUID();
    const commToken = randomUUID();
    const name = league_name?.trim() || 'IPL Fantasy League';

    await db.run(`
      INSERT INTO drafts (id, name, format, mode, num_teams, pick_timer, auction_budget, commissioner_token, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [draftId, name, 'auction', 'live', managers.length, 0, 200, commToken, 'completed']);

    // Create one team per manager
    const teamMap = {};
    for (let i = 0; i < managers.length; i++) {
      const m = managers[i];
      const teamId = randomUUID();
      const teamToken = randomUUID();
      await db.run(
        'INSERT INTO teams (id, draft_id, name, token, pick_order, budget) VALUES ($1,$2,$3,$4,$5,$6)',
        [teamId, draftId, m.name, teamToken, i, 200]
      );
      teamMap[m.name] = { id: teamId, token: teamToken };
    }

    // Create all unique players, assigning each to their manager's team
    const playerMap = {};
    for (const m of managers) {
      const team = teamMap[m.name];
      let sortOrder = 0;
      for (const [playerName, pData] of Object.entries(m.players)) {
        if (playerMap[playerName]) continue;
        const playerId = randomUUID();
        await db.run(
          'INSERT INTO players (id, draft_id, name, position, drafted_by, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
          [playerId, draftId, playerName, pData.role || null, team.id, sortOrder++]
        );
        playerMap[playerName] = playerId;
      }
    }

    // Create league with cricket scoring preset
    const leagueId = randomUUID();
    await db.run(`
      INSERT INTO leagues (id, draft_id, name, sport, scoring_rules, squad_size, starting_size)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [leagueId, draftId, name, 'cricket', JSON.stringify(SCORING_PRESETS.cricket), 15, 11]);

    // Determine which weeks have data (skip week 11+ which shows #N/A)
    const weekSet = new Set();
    for (const m of managers)
      for (const pData of Object.values(m.players))
        for (const w of Object.keys(pData.weeks))
          weekSet.add(parseInt(w));
    const weeks = [...weekSet].sort((a, b) => a - b).filter(w => w <= 10);

    // Create rounds (all completed)
    const roundMap = {};
    for (const w of weeks) {
      const roundId = randomUUID();
      await db.run(
        'INSERT INTO rounds (id, league_id, round_number, name, status) VALUES ($1,$2,$3,$4,$5)',
        [roundId, leagueId, w, `Week ${w}`, 'completed']
      );
      roundMap[w] = roundId;
    }

    // Bulk-insert stat entries and lineup rows
    await db.transaction(async (client) => {
      for (const m of managers) {
        const team = teamMap[m.name];
        for (const w of weeks) {
          const roundId = roundMap[w];
          for (const [playerName, pData] of Object.entries(m.players)) {
            const weekData = pData.weeks[w];
            if (!weekData) continue;
            const playerId = playerMap[playerName];
            if (!playerId) continue;

            await client.query(`
              INSERT INTO stat_entries (id, league_id, round_id, player_id, stats, points, points_breakdown)
              VALUES ($1,$2,$3,$4,'{}', $5,'{}')
              ON CONFLICT(round_id, player_id) DO UPDATE SET points = EXCLUDED.points
            `, [randomUUID(), leagueId, roundId, playerId, weekData.pts]);

            await client.query(`
              INSERT INTO lineups (id, league_id, round_id, team_id, player_id, is_starter)
              VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT(round_id, team_id, player_id) DO UPDATE SET is_starter = EXCLUDED.is_starter
            `, [randomUUID(), leagueId, roundId, team.id, playerId, weekData.isStarter]);
          }
        }
      }
    });

    res.json({
      success: true,
      draft_id: draftId,
      league_id: leagueId,
      commissioner_token: commToken,
      players_imported: Object.keys(playerMap).length,
      rounds_imported: weeks.length,
      teams: Object.entries(teamMap).map(([n, t]) => ({ name: n, team_id: t.id, team_token: t.token }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Trade Routes ─────────────────────────────────────────────────────────────

async function enrichTrade(trade) {
  const [propTeam, recvTeam] = await Promise.all([
    db.get('SELECT id, name FROM teams WHERE id = $1', [trade.proposing_team_id]),
    db.get('SELECT id, name FROM teams WHERE id = $1', [trade.receiving_team_id])
  ]);
  const allIds = [...(trade.offered_player_ids || []), ...(trade.requested_player_ids || [])];
  const players = allIds.length
    ? await db.all('SELECT id, name, position FROM players WHERE id = ANY($1)', [allIds])
    : [];
  const pMap = Object.fromEntries(players.map(p => [p.id, p]));
  return {
    ...trade,
    proposing_team_name: propTeam?.name,
    receiving_team_name: recvTeam?.name,
    offered_players: (trade.offered_player_ids || []).map(id => pMap[id]).filter(Boolean),
    requested_players: (trade.requested_player_ids || []).map(id => pMap[id]).filter(Boolean)
  };
}

app.get('/api/leagues/:id/trades', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });
    const trades = await db.all(
      'SELECT * FROM trades WHERE league_id = $1 ORDER BY created_at DESC', [req.params.id]
    );
    const enriched = await Promise.all(trades.map(t => enrichTrade(t)));
    res.json({ trades: enriched });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/leagues/:id/trades', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });
    const { team_token, receiving_team_id, offered_player_ids, requested_player_ids, note } = req.body;
    if (!team_token || !receiving_team_id || !Array.isArray(offered_player_ids) || !Array.isArray(requested_player_ids))
      return res.status(400).json({ error: 'team_token, receiving_team_id, offered_player_ids, requested_player_ids required' });
    const propTeam = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [league.draft_id, team_token]);
    if (!propTeam) return res.status(403).json({ error: 'Invalid team token' });
    if (propTeam.id === receiving_team_id) return res.status(400).json({ error: 'Cannot trade with yourself' });
    if (offered_player_ids.length) {
      const owned = await db.all('SELECT id FROM players WHERE id = ANY($1) AND drafted_by = $2', [offered_player_ids, propTeam.id]);
      if (owned.length !== offered_player_ids.length)
        return res.status(400).json({ error: 'Some offered players are not in your squad' });
    }
    if (requested_player_ids.length) {
      const owned = await db.all('SELECT id FROM players WHERE id = ANY($1) AND drafted_by = $2', [requested_player_ids, receiving_team_id]);
      if (owned.length !== requested_player_ids.length)
        return res.status(400).json({ error: "Some requested players are not in that team's squad" });
    }
    const tradeId = randomUUID();
    await db.run(`
      INSERT INTO trades (id, league_id, proposing_team_id, receiving_team_id, offered_player_ids, requested_player_ids, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [tradeId, req.params.id, propTeam.id, receiving_team_id,
        JSON.stringify(offered_player_ids), JSON.stringify(requested_player_ids), note || null]);
    res.json({ trade_id: tradeId });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.put('/api/leagues/:id/trades/:tradeId', async (req, res) => {
  try {
    const { action, team_token } = req.body;
    const commToken = req.headers['x-commissioner-token'];
    const authToken = (action === 'execute' || action === 'veto') ? commToken : null;
    const { league, error, status } = await getLeagueWithAuth(req.params.id, authToken);
    if (error) return res.status(status).json({ error });
    const trade = await db.get('SELECT * FROM trades WHERE id = $1 AND league_id = $2',
      [req.params.tradeId, req.params.id]);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    if (action === 'accept' || action === 'reject') {
      if (!team_token) return res.status(400).json({ error: 'team_token required' });
      const team = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [league.draft_id, team_token]);
      if (!team || team.id !== trade.receiving_team_id)
        return res.status(403).json({ error: 'Only the receiving team can accept or reject' });
      if (trade.status !== 'pending') return res.status(400).json({ error: 'Trade is no longer pending' });
      const newStatus = action === 'accept' ? 'accepted' : 'rejected';
      await db.run('UPDATE trades SET status = $1, updated_at = NOW() WHERE id = $2', [newStatus, trade.id]);
      return res.json({ success: true, status: newStatus });
    }

    if (action === 'execute' || action === 'veto') {
      if (trade.status !== 'accepted') return res.status(400).json({ error: 'Trade must be accepted before executing' });
      if (action === 'execute') {
        await db.transaction(async (client) => {
          for (const pid of (trade.offered_player_ids || []))
            await client.query('UPDATE players SET drafted_by = $1 WHERE id = $2', [trade.receiving_team_id, pid]);
          for (const pid of (trade.requested_player_ids || []))
            await client.query('UPDATE players SET drafted_by = $1 WHERE id = $2', [trade.proposing_team_id, pid]);
          await client.query('UPDATE trades SET status = $1, updated_at = NOW() WHERE id = $2', ['executed', trade.id]);
        });
      } else {
        await db.run('UPDATE trades SET status = $1, updated_at = NOW() WHERE id = $2', ['vetoed', trade.id]);
      }
      return res.json({ success: true, status: action === 'execute' ? 'executed' : 'vetoed' });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Waiver Routes ─────────────────────────────────────────────────────────────

app.get('/api/leagues/:id/waivers', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });
    const freeAgents = await db.all(
      'SELECT id, name, position, team_affiliation FROM players WHERE draft_id = $1 AND drafted_by IS NULL AND unsold = 0 ORDER BY LOWER(name)',
      [league.draft_id]
    );
    const pendingClaims = await db.all(`
      SELECT wc.*, t.name as team_name, cp.name as claim_player_name, dp.name as drop_player_name
      FROM waiver_claims wc
      JOIN teams t ON wc.team_id = t.id
      JOIN players cp ON wc.claim_player_id = cp.id
      LEFT JOIN players dp ON wc.drop_player_id = dp.id
      WHERE wc.league_id = $1 AND wc.status = 'pending'
      ORDER BY wc.created_at ASC
    `, [req.params.id]);
    const teams = await db.all('SELECT id, name FROM teams WHERE draft_id = $1 ORDER BY pick_order', [league.draft_id]);
    const waiverOrder = league.waiver_order || teams.map(t => t.id);
    res.json({ free_agents: freeAgents, pending_claims: pendingClaims, waiver_order: waiverOrder, teams });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/leagues/:id/waivers', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });
    const { team_token, claim_player_id, drop_player_id } = req.body;
    if (!team_token || !claim_player_id) return res.status(400).json({ error: 'team_token and claim_player_id required' });
    const team = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [league.draft_id, team_token]);
    if (!team) return res.status(403).json({ error: 'Invalid team token' });
    const claimPlayer = await db.get(
      'SELECT id FROM players WHERE id = $1 AND draft_id = $2 AND drafted_by IS NULL',
      [claim_player_id, league.draft_id]
    );
    if (!claimPlayer) return res.status(400).json({ error: 'Player is not a free agent' });
    if (drop_player_id) {
      const dropPlayer = await db.get('SELECT id FROM players WHERE id = $1 AND drafted_by = $2', [drop_player_id, team.id]);
      if (!dropPlayer) return res.status(400).json({ error: 'Drop player is not on your squad' });
    }
    const existing = await db.get(
      "SELECT id FROM waiver_claims WHERE league_id = $1 AND team_id = $2 AND claim_player_id = $3 AND status = 'pending'",
      [req.params.id, team.id, claim_player_id]
    );
    if (existing) return res.status(400).json({ error: 'You already have a pending claim on this player' });
    const claimId = randomUUID();
    await db.run(
      'INSERT INTO waiver_claims (id, league_id, team_id, claim_player_id, drop_player_id) VALUES ($1,$2,$3,$4,$5)',
      [claimId, req.params.id, team.id, claim_player_id, drop_player_id || null]
    );
    res.json({ claim_id: claimId });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/leagues/:id/waivers/:claimId', async (req, res) => {
  try {
    const { league, error, status } = await getLeagueWithAuth(req.params.id, null);
    if (error) return res.status(status).json({ error });
    const { team_token } = req.body;
    if (!team_token) return res.status(400).json({ error: 'team_token required' });
    const team = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [league.draft_id, team_token]);
    if (!team) return res.status(403).json({ error: 'Invalid team token' });
    const claim = await db.get(
      "SELECT id FROM waiver_claims WHERE id = $1 AND league_id = $2 AND team_id = $3 AND status = 'pending'",
      [req.params.claimId, req.params.id, team.id]
    );
    if (!claim) return res.status(404).json({ error: 'Claim not found or already processed' });
    await db.run('DELETE FROM waiver_claims WHERE id = $1', [req.params.claimId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/leagues/:id/waivers/process', async (req, res) => {
  try {
    const commToken = req.headers['x-commissioner-token'];
    const { league, error, status } = await getLeagueWithAuth(req.params.id, commToken);
    if (error) return res.status(status).json({ error });
    const claims = await db.all(
      "SELECT * FROM waiver_claims WHERE league_id = $1 AND status = 'pending' ORDER BY created_at ASC",
      [req.params.id]
    );
    const teams = await db.all('SELECT id FROM teams WHERE draft_id = $1', [league.draft_id]);
    const waiverOrder = league.waiver_order || teams.map(t => t.id);
    claims.sort((a, b) => {
      const ai = waiverOrder.indexOf(a.team_id);
      const bi = waiverOrder.indexOf(b.team_id);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    const claimedPlayers = new Set();
    let processed = 0, failed = 0;
    await db.transaction(async (client) => {
      for (const claim of claims) {
        const fa = await client.query(
          'SELECT id FROM players WHERE id = $1 AND drafted_by IS NULL', [claim.claim_player_id]
        );
        if (!fa.rows.length || claimedPlayers.has(claim.claim_player_id)) {
          await client.query("UPDATE waiver_claims SET status = 'rejected' WHERE id = $1", [claim.id]);
          failed++;
          continue;
        }
        await client.query('UPDATE players SET drafted_by = $1 WHERE id = $2', [claim.team_id, claim.claim_player_id]);
        if (claim.drop_player_id) {
          await client.query('UPDATE players SET drafted_by = NULL WHERE id = $1 AND drafted_by = $2',
            [claim.drop_player_id, claim.team_id]);
        }
        await client.query("UPDATE waiver_claims SET status = 'processed' WHERE id = $1", [claim.id]);
        claimedPlayers.add(claim.claim_player_id);
        processed++;
      }
    });
    res.json({ success: true, processed, failed });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.put('/api/leagues/:id/waivers/order', async (req, res) => {
  try {
    const commToken = req.headers['x-commissioner-token'];
    const { league, error, status } = await getLeagueWithAuth(req.params.id, commToken);
    if (error) return res.status(status).json({ error });
    const { waiver_order } = req.body;
    if (!Array.isArray(waiver_order)) return res.status(400).json({ error: 'waiver_order must be an array of team IDs' });
    await db.run('UPDATE leagues SET waiver_order = $1 WHERE id = $2', [JSON.stringify(waiver_order), req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Draft Trade Routes ────────────────────────────────────────────────────────

app.get('/api/drafts/:id/trades', async (req, res) => {
  try {
    const draft = await db.get('SELECT id FROM drafts WHERE id = $1', [req.params.id]);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    const trades = await db.all(`
      SELECT dt.*, pt.name as proposing_team_name, rt.name as receiving_team_name
      FROM draft_trades dt
      JOIN teams pt ON dt.proposing_team_id = pt.id
      JOIN teams rt ON dt.receiving_team_id = rt.id
      WHERE dt.draft_id = $1
      ORDER BY dt.created_at DESC
    `, [req.params.id]);
    res.json(trades);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/drafts/:id/trades', async (req, res) => {
  try {
    const { team_token, receiving_team_id,
            offered_pick_numbers = [], offered_player_ids = [],
            requested_pick_numbers = [], requested_player_ids = [],
            note } = req.body;

    if (!team_token || !receiving_team_id) return res.status(400).json({ error: 'team_token and receiving_team_id required' });
    if (offered_pick_numbers.length + offered_player_ids.length === 0)
      return res.status(400).json({ error: 'Must offer at least one pick or player' });
    if (requested_pick_numbers.length + requested_player_ids.length === 0)
      return res.status(400).json({ error: 'Must request at least one pick or player' });

    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [req.params.id]);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.status !== 'active') return res.status(400).json({ error: 'Draft is not active' });
    if (draft.format === 'auction') return res.status(400).json({ error: 'Trades not available in auction drafts' });

    const proposingTeam = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [req.params.id, team_token]);
    if (!proposingTeam) return res.status(403).json({ error: 'Invalid team token' });

    const receivingTeam = await db.get('SELECT * FROM teams WHERE id = $1 AND draft_id = $2', [receiving_team_id, req.params.id]);
    if (!receivingTeam) return res.status(400).json({ error: 'Receiving team not found' });
    if (proposingTeam.id === receivingTeam.id) return res.status(400).json({ error: 'Cannot trade with yourself' });

    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [req.params.id]);
    const pickOwnership = draft.pick_ownership || {};

    for (const pn of offered_pick_numbers) {
      if (pn < draft.current_pick) return res.status(400).json({ error: `Pick ${pn + 1} has already been made` });
      if (getPickOwner(pn, teams, draft.format, pickOwnership) !== proposingTeam.id)
        return res.status(400).json({ error: `Pick ${pn + 1} does not belong to your team` });
    }
    for (const pn of requested_pick_numbers) {
      if (pn < draft.current_pick) return res.status(400).json({ error: `Pick ${pn + 1} has already been made` });
      if (getPickOwner(pn, teams, draft.format, pickOwnership) !== receivingTeam.id)
        return res.status(400).json({ error: `Pick ${pn + 1} does not belong to ${receivingTeam.name}` });
    }
    for (const pid of offered_player_ids) {
      const p = await db.get('SELECT id FROM players WHERE id = $1 AND draft_id = $2 AND drafted_by = $3',
        [pid, req.params.id, proposingTeam.id]);
      if (!p) return res.status(400).json({ error: 'An offered player is not on your squad' });
    }
    for (const pid of requested_player_ids) {
      const p = await db.get('SELECT id FROM players WHERE id = $1 AND draft_id = $2 AND drafted_by = $3',
        [pid, req.params.id, receivingTeam.id]);
      if (!p) return res.status(400).json({ error: `A requested player is not on ${receivingTeam.name}'s squad` });
    }

    const tradeId = randomUUID();
    await db.run(`
      INSERT INTO draft_trades (id, draft_id, proposing_team_id, receiving_team_id,
        offered_pick_numbers, offered_player_ids, requested_pick_numbers, requested_player_ids, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [tradeId, req.params.id, proposingTeam.id, receivingTeam.id,
        JSON.stringify(offered_pick_numbers), JSON.stringify(offered_player_ids),
        JSON.stringify(requested_pick_numbers), JSON.stringify(requested_player_ids),
        note || null]);

    io.to(`draft:${req.params.id}`).emit('draft-trade', {
      type: 'proposed',
      trade_id: tradeId,
      proposing_team_id: proposingTeam.id,
      proposing_team_name: proposingTeam.name,
      receiving_team_id: receivingTeam.id,
      receiving_team_name: receivingTeam.name,
    });

    res.json({ trade_id: tradeId });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.put('/api/drafts/:id/trades/:tradeId', async (req, res) => {
  try {
    const { team_token, action } = req.body;
    if (!team_token || !action) return res.status(400).json({ error: 'team_token and action required' });
    if (!['accept', 'reject', 'cancel'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const trade = await db.get('SELECT * FROM draft_trades WHERE id = $1 AND draft_id = $2',
      [req.params.tradeId, req.params.id]);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    if (trade.status !== 'pending') return res.status(400).json({ error: 'Trade is no longer pending' });

    const actingTeam = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [req.params.id, team_token]);
    if (!actingTeam) return res.status(403).json({ error: 'Invalid team token' });

    if (action === 'cancel') {
      if (actingTeam.id !== trade.proposing_team_id) return res.status(403).json({ error: 'Only the proposing team can cancel' });
      await db.run("UPDATE draft_trades SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [trade.id]);
      io.to(`draft:${req.params.id}`).emit('draft-trade', { type: 'cancelled', trade_id: trade.id,
        proposing_team_id: trade.proposing_team_id, receiving_team_id: trade.receiving_team_id });
      return res.json({ success: true });
    }

    if (actingTeam.id !== trade.receiving_team_id) return res.status(403).json({ error: 'Only the receiving team can accept or reject' });

    if (action === 'reject') {
      await db.run("UPDATE draft_trades SET status = 'rejected', updated_at = NOW() WHERE id = $1", [trade.id]);
      io.to(`draft:${req.params.id}`).emit('draft-trade', { type: 'rejected', trade_id: trade.id,
        proposing_team_id: trade.proposing_team_id, receiving_team_id: trade.receiving_team_id });
      return res.json({ success: true });
    }

    // Accept — re-validate ownership then execute
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [req.params.id]);
    if (!draft || draft.status !== 'active') return res.status(400).json({ error: 'Draft is not active' });

    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [req.params.id]);
    const pickOwnership = draft.pick_ownership || {};

    for (const pn of trade.offered_pick_numbers) {
      if (pn < draft.current_pick) return res.status(400).json({ error: `Pick ${pn + 1} has already been made` });
      if (getPickOwner(pn, teams, draft.format, pickOwnership) !== trade.proposing_team_id)
        return res.status(400).json({ error: 'Pick ownership changed since trade was proposed' });
    }
    for (const pn of trade.requested_pick_numbers) {
      if (pn < draft.current_pick) return res.status(400).json({ error: `Pick ${pn + 1} has already been made` });
      if (getPickOwner(pn, teams, draft.format, pickOwnership) !== trade.receiving_team_id)
        return res.status(400).json({ error: 'Pick ownership changed since trade was proposed' });
    }
    for (const pid of trade.offered_player_ids) {
      const p = await db.get('SELECT id FROM players WHERE id = $1 AND drafted_by = $2', [pid, trade.proposing_team_id]);
      if (!p) return res.status(400).json({ error: 'A player changed squads since trade was proposed' });
    }
    for (const pid of trade.requested_player_ids) {
      const p = await db.get('SELECT id FROM players WHERE id = $1 AND drafted_by = $2', [pid, trade.receiving_team_id]);
      if (!p) return res.status(400).json({ error: 'A player changed squads since trade was proposed' });
    }

    await db.transaction(async (client) => {
      // Update pick ownership
      const newOwnership = { ...pickOwnership };
      for (const pn of trade.offered_pick_numbers) newOwnership[String(pn)] = trade.receiving_team_id;
      for (const pn of trade.requested_pick_numbers) newOwnership[String(pn)] = trade.proposing_team_id;
      if (trade.offered_pick_numbers.length + trade.requested_pick_numbers.length > 0) {
        await client.query('UPDATE drafts SET pick_ownership = $1 WHERE id = $2',
          [JSON.stringify(newOwnership), req.params.id]);
      }
      // Swap player ownership
      for (const pid of trade.offered_player_ids)
        await client.query('UPDATE players SET drafted_by = $1 WHERE id = $2', [trade.receiving_team_id, pid]);
      for (const pid of trade.requested_player_ids)
        await client.query('UPDATE players SET drafted_by = $1 WHERE id = $2', [trade.proposing_team_id, pid]);
      await client.query("UPDATE draft_trades SET status = 'accepted', updated_at = NOW() WHERE id = $1", [trade.id]);
    });

    const proposingTeam = teams.find(t => t.id === trade.proposing_team_id);
    const receivingTeam = teams.find(t => t.id === trade.receiving_team_id);

    const newState = await getDraftState(req.params.id);
    io.to(`draft:${req.params.id}`).emit('draft-state', newState);
    io.to(`draft:${req.params.id}`).emit('draft-trade', {
      type: 'accepted',
      trade_id: trade.id,
      proposing_team_id: trade.proposing_team_id,
      proposing_team_name: proposingTeam?.name,
      receiving_team_id: trade.receiving_team_id,
      receiving_team_name: receivingTeam?.name,
    });

    return res.json({ success: true });
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

    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
    if (teams.length < 2) { socket.emit('error', { message: 'Need at least 2 teams to start' }); return; }

    const countRow = await db.get('SELECT COUNT(*) as c FROM players WHERE draft_id = $1', [draftId]);
    if (parseInt(countRow.c) === 0) { socket.emit('error', { message: 'Upload a player pool before starting' }); return; }

    await db.run('UPDATE drafts SET status = $1, num_teams = $2 WHERE id = $3',
      ['active', teams.length, draftId]);

    const state = await getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
    io.to(`draft:${draftId}`).emit('draft-started', {});

    if (draft.format !== 'auction' && draft.mode === 'live') {
      await startPickTimer(draftId);
    } else if (draft.format === 'auction') {
      await autoNominateNext(draftId);
    } else if (draft.format !== 'auction' && draft.mode === 'async' && draft.pick_timer > 0) {
      // Slow draft: set first deadline and notify all teams
      const updatedTeams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
      await setSlowPickDeadlineAndNotify(draftId, 0);

      // Notify all non-first teams that draft has started (first team already got a pick notification)
      const firstIdx = getTeamIndexForPick(0, updatedTeams.length, draft.format);
      for (let i = 0; i < updatedTeams.length; i++) {
        const t = updatedTeams[i];
        if (!t.email || i === firstIdx) continue;
        sendDraftStartedNotification({
          teamName: t.name,
          email: t.email,
          draftName: draft.name,
          draftId,
          teamToken: t.token,
          deadlineHours: 0,
          isFirst: false,
        });
      }
    }
  });

  socket.on('make-pick', async ({ teamToken, commissionerToken, playerId }) => {
    const { draftId } = socket.data;
    if (!draftId) return;

    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.status !== 'active' || draft.format === 'auction') return;

    // Commissioner can pick for whoever is on the clock
    if (commissionerToken) {
      if (draft.commissioner_token !== commissionerToken) {
        socket.emit('error', { message: 'Invalid commissioner token' });
        return;
      }
      await processPick(draftId, playerId, null, false);
      return;
    }

    const team = await db.get('SELECT * FROM teams WHERE draft_id = $1 AND token = $2', [draftId, teamToken]);
    if (!team) return;

    const teams = await db.all('SELECT * FROM teams WHERE draft_id = $1 ORDER BY pick_order', [draftId]);
    const makePick_ownership = draft.pick_ownership || {};
    const expectedTeamId = getPickOwner(draft.current_pick, teams, draft.format, makePick_ownership);
    if (expectedTeamId !== team.id) {
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

    if (draft.picks_per_team > 0) {
      const teamPickCount = await db.get(
        'SELECT COUNT(*) as c FROM players WHERE draft_id = $1 AND drafted_by = $2',
        [draftId, team.id]
      );
      if (parseInt(teamPickCount.c) >= draft.picks_per_team) {
        socket.emit('error', { message: 'Your squad is full' });
        return;
      }
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

  socket.on('undo-last-pick', async ({ commissionerToken }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    if (draft.format === 'auction') return;
    if (draft.status !== 'active' && draft.status !== 'completed') return;

    const lastPick = await db.get(
      'SELECT * FROM players WHERE draft_id = $1 AND pick_number IS NOT NULL ORDER BY pick_number DESC LIMIT 1',
      [draftId]
    );
    if (!lastPick) return;

    await db.run('UPDATE players SET drafted_by = NULL, pick_number = NULL WHERE id = $1', [lastPick.id]);
    await db.run(
      "UPDATE drafts SET status = 'active', current_pick = $1, pick_deadline = NULL WHERE id = $2",
      [lastPick.pick_number, draftId]
    );

    clearPickTimer(draftId);
    if (draft.mode === 'live' && draft.pick_timer > 0) await startPickTimer(draftId);
    else if (draft.mode === 'async' && draft.pick_timer > 0) await setSlowPickDeadlineAndNotify(draftId, lastPick.pick_number);

    const state = await getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
  });

  socket.on('set-pick-timer', async ({ commissionerToken, seconds, hours }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    if (draft.status !== 'active' || draft.format === 'auction') return;

    if (draft.mode === 'live') {
      const newTimer = Math.max(1, parseInt(seconds) || 90);
      await db.run('UPDATE drafts SET pick_timer = $1 WHERE id = $2', [newTimer, draftId]);
      await startPickTimer(draftId);
    } else if (draft.mode === 'async') {
      const newTimer = Math.max(1, parseInt(hours) || 24);
      await db.run('UPDATE drafts SET pick_timer = $1 WHERE id = $2', [newTimer, draftId]);
      await setSlowPickDeadlineAndNotify(draftId, draft.current_pick);
    }
    const state = await getDraftState(draftId);
    io.to(`draft:${draftId}`).emit('draft-state', state);
  });

  socket.on('reduce-pick-time', async ({ commissionerToken, seconds, minutes }) => {
    const { draftId } = socket.data;
    if (!draftId) return;
    const draft = await db.get('SELECT * FROM drafts WHERE id = $1', [draftId]);
    if (!draft || draft.commissioner_token !== commissionerToken) return;
    if (draft.status !== 'active' || draft.pick_timer === 0 || draft.format === 'auction') return;

    if (draft.mode === 'live') {
      const entry = activeTimers.get(draftId);
      if (!entry) return;
      const reductionMs = Math.max(1, parseInt(seconds) || 30) * 1000;
      const newEndsAt = Math.max(Date.now() + 1000, entry.endsAt - reductionMs);
      await startPickTimer(draftId, newEndsAt);
    } else if (draft.mode === 'async' && draft.pick_deadline) {
      const reductionMs = Math.max(1, parseInt(minutes) || 30) * 60 * 1000;
      const currentDeadline = new Date(draft.pick_deadline).getTime();
      const newDeadline = Math.max(Date.now() + 60 * 1000, currentDeadline - reductionMs);
      await db.run('UPDATE drafts SET pick_deadline = $1 WHERE id = $2', [new Date(newDeadline).toISOString(), draftId]);
      await startSlowPickDeadline(draftId);
      const state = await getDraftState(draftId);
      io.to(`draft:${draftId}`).emit('draft-state', state);
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

const activeSlowDrafts = await db.all(
  "SELECT * FROM drafts WHERE status = 'active' AND mode = 'async' AND pick_timer > 0 AND pick_deadline IS NOT NULL"
);
for (const draft of activeSlowDrafts) {
  if (draft.format !== 'auction') await startSlowPickDeadline(draft.id);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Fantasy Draft running at http://localhost:${PORT}`);
});
