import { initAuth } from './auth.js';

// ── State ─────────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const DRAFT_ID = params.get('id');
if (!DRAFT_ID) { location.href = '/'; }

const COMMISSIONER_TOKEN = localStorage.getItem(`commissioner_${DRAFT_ID}`);

// Restore team credentials from URL token param (rejoin flow)
const urlToken = params.get('token');
if (urlToken && !localStorage.getItem(`team_${DRAFT_ID}_token`)) {
  // Fetch the team ID for this token from the server
  fetch(`/api/drafts/${DRAFT_ID}/team-by-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: urlToken })
  }).then(r => r.ok ? r.json() : null).then(data => {
    if (data?.team_id) {
      localStorage.setItem(`team_${DRAFT_ID}_id`, data.team_id);
      localStorage.setItem(`team_${DRAFT_ID}_token`, urlToken);
      location.replace(`/draft.html?id=${DRAFT_ID}`);
    }
  });
}

let MY_TEAM_ID = localStorage.getItem(`team_${DRAFT_ID}_id`);
let MY_TEAM_TOKEN = localStorage.getItem(`team_${DRAFT_ID}_token`);

// Auto-restore commissioner access for logged-in owners on any device
if (!COMMISSIONER_TOKEN) {
  fetch(`/api/drafts/${DRAFT_ID}/commissioner-token`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data?.commissioner_token) {
        localStorage.setItem(`commissioner_${DRAFT_ID}`, data.commissioner_token);
        location.reload();
      }
    });
}

// Auto-restore team credentials for logged-in team members on any device
if (!MY_TEAM_TOKEN) {
  fetch(`/api/drafts/${DRAFT_ID}/my-team`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data?.token) {
        localStorage.setItem(`team_${DRAFT_ID}_id`, data.team_id);
        localStorage.setItem(`team_${DRAFT_ID}_token`, data.token);
        location.reload();
      }
    });
}

initAuth('auth-container');

let state = null;
let isCommissioner = !!COMMISSIONER_TOKEN;
let boardView = 'grid'; // 'grid' | 'list'
let pendingPickId = null;
let clientTimerInterval = null;
let clientTimerEnd = null;
let slowDeadlineInterval = null;

// Trade state
let draftTrades = [];
let tradeOfferedPickNums = new Set();
let tradeRequestedPickNums = new Set();
let tradeOfferedPlayerIds = new Set();
let tradeRequestedPlayerIds = new Set();
let activePendingTradeId = null; // trade currently shown in incoming modal

// ── Socket ────────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  socket.emit('join-draft', {
    draftId: DRAFT_ID,
    commissionerToken: COMMISSIONER_TOKEN || undefined,
    teamToken: MY_TEAM_TOKEN || undefined
  });
});

socket.on('init', ({ state: s, isCommissioner: ic, teamId }) => {
  isCommissioner = ic;
  state = s;
  render();
});

socket.on('draft-state', (s) => {
  state = s;
  render();
});

socket.on('draft-started', () => {
  toast('Draft has started!', 'success');
});

socket.on('pick-made', ({ player, team, isAutoPick }) => {
  const suffix = isAutoPick ? ' (auto-pick)' : '';
  toast(`${team.name} drafted ${player.name}${suffix}`, 'info');
});

socket.on('timer-tick', ({ remaining }) => {
  clientTimerEnd = Date.now() + remaining;
  renderTimer(remaining);
});

socket.on('bid-placed', ({ teamId, teamName, amount }) => {
  toast(`${teamName} bid $${amount}`, 'info');
  // Update local bid state so the list refreshes immediately without waiting for next draft-state
  if (state && state.current_nomination) {
    const existing = state.current_bids.find(b => b.team_id === teamId);
    if (existing) {
      existing.amount = amount;
    } else {
      state.current_bids.push({ team_id: teamId, team_name: teamName, amount });
    }
    state.current_bids.sort((a, b) => b.amount - a.amount);
    renderAuctionBids();
    // Update bid input minimum
    const topBid = state.current_bids[0]?.amount || 0;
    const bidInput = document.getElementById('bid-amount');
    if (bidInput) {
      bidInput.min = topBid + 1;
      const myTeam = state.teams.find(t => t.id === MY_TEAM_ID);
      bidInput.placeholder = `Min $${topBid + 1} — Max $${myTeam?.budget || '?'}`;
    }
  }
});

socket.on('auction-closed', ({ player, team, amount }) => {
  if (team) {
    toast(`${team.name} won ${player.name} for $${amount}`, 'success');
  } else {
    toast(`${player.name} went unsold`, 'info');
  }
});

socket.on('error', ({ message }) => {
  toast(message, 'error');
});

socket.on('draft-trade', (event) => {
  if (event.type === 'proposed') {
    if (event.receiving_team_id === MY_TEAM_ID) {
      toast(`Trade offer from ${event.proposing_team_name}!`, 'info');
      fetchAndRenderTrades(event.trade_id);
    } else if (event.proposing_team_id === MY_TEAM_ID) {
      toast('Trade proposal sent', 'success');
    }
  } else if (event.type === 'accepted') {
    toast(`Trade accepted between ${event.proposing_team_name} and ${event.receiving_team_name}`, 'success');
    fetchAndRenderTrades();
  } else if (event.type === 'rejected') {
    if (event.proposing_team_id === MY_TEAM_ID) toast('Your trade offer was rejected', 'error');
    fetchAndRenderTrades();
  } else if (event.type === 'cancelled') {
    if (event.receiving_team_id === MY_TEAM_ID) toast('A trade offer was withdrawn', 'info');
    fetchAndRenderTrades();
  }
});

socket.on('draft-deleted', () => {
  alert('This draft has been deleted by the commissioner.');
  location.href = '/';
});

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  if (!state) return;

  // Header
  document.getElementById('draft-name').textContent = state.name;
  setFormatBadge();
  setModeBadge();
  setStatusBadge();
  updatePickCounter();

  if (state.status === 'waiting') {
    show('waiting-room');
    hide('draft-room');
    hide('draft-completed');
    renderWaiting();
  } else if (state.status === 'completed') {
    hide('waiting-room');
    hide('draft-room');
    show('draft-completed');
    renderCompleted();
  } else {
    hide('waiting-room');
    show('draft-room');
    hide('draft-completed');
    renderActive();
  }
}

function renderWaiting() {
  const joinUrl = `${location.origin}/?join=${DRAFT_ID}`;
  const codeEl = document.getElementById('draft-id-code');
  codeEl.innerHTML = `<a href="${joinUrl}" target="_blank" style="color:var(--primary)">${joinUrl}</a>`;
  document.getElementById('teams-count').textContent = state.teams.length;
  document.getElementById('teams-needed').textContent = state.num_teams;

  const grid = document.getElementById('teams-waiting-grid');
  grid.innerHTML = state.teams.map(t => `
    <div class="team-waiting-card ${t.id === MY_TEAM_ID ? 'me' : ''}">
      ${t.id === MY_TEAM_ID ? '★ ' : ''}${escHtml(t.name)}
    </div>
  `).join('') + Array.from({ length: Math.max(0, state.num_teams - state.teams.length) }, (_, i) =>
    `<div class="team-waiting-card" style="opacity:0.3">Empty slot</div>`
  ).join('');

  const commDiv = document.getElementById('commissioner-waiting');
  if (isCommissioner) {
    commDiv.style.display = 'block';
    const playerCount = state.players.length;
    document.getElementById('player-count-badge').textContent =
      playerCount ? `✓ ${playerCount} players loaded` : '';
  } else {
    commDiv.style.display = 'none';
  }

  // Show join-as-team section if this browser hasn't joined as a team yet
  const joinSection = document.getElementById('join-as-team-section');
  joinSection.style.display = !MY_TEAM_ID ? 'block' : 'none';

  // Show personal rejoin link if this browser has a team token
  const myLinkSection = document.getElementById('my-link-section');
  if (MY_TEAM_TOKEN) {
    myLinkSection.style.display = 'block';
    document.getElementById('my-rejoin-link').value =
      `${location.origin}/draft.html?id=${DRAFT_ID}&token=${MY_TEAM_TOKEN}`;
  } else {
    myLinkSection.style.display = 'none';
  }

  // Show email setup section for slow drafts when the user has a team
  const emailSection = document.getElementById('slow-draft-email-section');
  if (emailSection) {
    if (state.is_slow_draft && MY_TEAM_ID && MY_TEAM_TOKEN) {
      emailSection.style.display = 'block';
      const myTeam = state.teams.find(t => t.id === MY_TEAM_ID);
      const emailInput = document.getElementById('slow-draft-email-input');
      if (emailInput && myTeam?.email && !emailInput.value) {
        emailInput.value = myTeam.email;
      }
    } else {
      emailSection.style.display = 'none';
    }
  }
}

function getOnClockTeam() {
  if (!state || state.format === 'auction') return null;
  const { teams, format, current_pick, pick_ownership } = state;
  const ownership = pick_ownership || {};
  const override = ownership[String(current_pick)];
  if (override) return teams.find(t => t.id === override) || null;
  return teams[getTeamIndex(current_pick, teams.length, format)] || null;
}

function renderActive() {
  const teams = state.teams;
  const numTeams = teams.length;
  const format = state.format;

  // Current on-clock team (for non-auction) — respects pick_ownership for traded picks
  const onClockTeam = format !== 'auction' ? getOnClockTeam() : null;

  // Show Trades button for non-auction active drafts
  const tradesBtn = document.getElementById('trades-btn');
  if (format !== 'auction') {
    tradesBtn.style.display = '';
  } else {
    tradesBtn.style.display = 'none';
  }

  // Status bar
  renderStatusBar(onClockTeam);

  // Player pool
  renderPlayerPool(onClockTeam);

  // Draft board
  if (format === 'auction') {
    renderAuctionBoard();
  } else {
    renderDraftBoard(onClockTeam);
  }

  // My team
  renderMyTeam();

  // All teams
  renderAllTeams(onClockTeam);

  // Auction panel
  if (format === 'auction') {
    renderAuctionPanel();
  } else {
    hide('auction-panel');
  }

  // Commissioner controls
  const commDraftControls = document.getElementById('commissioner-draft-controls');
  commDraftControls.style.display = isCommissioner ? 'flex' : 'none';
}

function renderStatusBar(onClockTeam) {
  const info = document.getElementById('current-turn-info');
  const timerEl = document.getElementById('timer-display');

  if (state.format === 'auction') {
    if (state.auction_paused) {
      info.innerHTML = `<span style="color:var(--warning)">⏸ Auction Paused</span>`;
    } else if (state.current_nomination) {
      const nominatedPlayer = state.players.find(p => p.id === state.current_nomination);
      info.innerHTML = `<span class="other-turn">Auction: <strong>${escHtml(nominatedPlayer?.name || '?')}</strong></span>`;
    } else {
      info.innerHTML = `<span class="other-turn">Loading next player…</span>`;
    }
    timerEl.style.display = 'none';
  } else if (onClockTeam) {
    const isMyTurn = onClockTeam.id === MY_TEAM_ID;
    const round = Math.floor(state.current_pick / state.teams.length) + 1;
    const pickInRound = (state.teams.length > 0)
      ? (state.current_pick % state.teams.length) + 1
      : 1;
    if (isMyTurn) {
      info.innerHTML = `<span class="my-turn">🟢 Your turn to pick! — Round ${round}, Pick ${pickInRound}</span>`;
    } else {
      info.innerHTML = `<span class="other-turn">Round ${round}, Pick ${pickInRound} — <strong>${escHtml(onClockTeam.name)}</strong>'s turn</span>`;
    }

    if (state.mode === 'live' && state.pick_timer > 0) {
      timerEl.style.display = 'block';
    } else if (state.is_slow_draft && state.pick_deadline) {
      timerEl.style.display = 'block';
      if (isCurrentlyQuietHours(state)) {
        stopSlowDeadlineCountdown();
        timerEl.textContent = '⏸ Quiet hrs';
        timerEl.className = 'timer ok';
      } else {
        startSlowDeadlineCountdown(state.pick_deadline, timerEl);
      }
    } else {
      timerEl.style.display = 'none';
      stopSlowDeadlineCountdown();
    }
  }
}

function renderTimer(remaining) {
  const secs = Math.ceil(remaining / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  const text = mins > 0 ? `${mins}:${String(s).padStart(2, '0')}` : `${secs}`;
  const cls = 'timer ' + (secs <= 10 ? 'urgent' : secs <= 20 ? 'warning' : 'ok');

  // Status bar timer (snake/linear)
  const statusTimer = document.getElementById('timer-display');
  if (statusTimer && statusTimer.style.display !== 'none') {
    statusTimer.textContent = text;
    statusTimer.className = cls;
  }

  // Auction panel timer
  const auctionTimer = document.getElementById('auction-timer');
  if (auctionTimer && state?.format === 'auction' && state?.current_nomination) {
    auctionTimer.style.display = 'block';
    auctionTimer.textContent = text;
    auctionTimer.className = cls;
  } else if (auctionTimer) {
    auctionTimer.style.display = 'none';
  }
}

function renderPlayerPool(onClockTeam) {
  const available = state.players.filter(p => !p.drafted_by && !p.unsold);
  document.getElementById('available-count').textContent = available.length;

  const search = document.getElementById('player-search').value.toLowerCase();
  const posFilter = document.getElementById('pos-filter').value;

  // Update position filter options
  const positions = [...new Set(state.players.map(p => p.position).filter(Boolean))].sort();
  const posSelect = document.getElementById('pos-filter');
  const currentPos = posSelect.value;
  posSelect.innerHTML = '<option value="">All Pos</option>' +
    positions.map(p => `<option value="${p}" ${p === currentPos ? 'selected' : ''}>${p}</option>`).join('');

  // Update team filter options
  const teamAffils = [...new Set(state.players.map(p => p.team_affiliation).filter(Boolean))].sort();
  const teamSelect = document.getElementById('team-filter');
  const currentTeam = teamSelect.value;
  teamSelect.innerHTML = '<option value="">All Teams</option>' +
    teamAffils.map(t => `<option value="${t}" ${t === currentTeam ? 'selected' : ''}>${t}</option>`).join('');

  const teamFilter = teamSelect.value;

  const filtered = available.filter(p => {
    if (search && !p.name.toLowerCase().includes(search) &&
        !(p.position || '').toLowerCase().includes(search) &&
        !(p.team_affiliation || '').toLowerCase().includes(search)) return false;
    if (posFilter && p.position !== posFilter) return false;
    if (teamFilter && p.team_affiliation !== teamFilter) return false;
    return true;
  });

  const myTeamPickCount = state.players.filter(p => p.drafted_by === MY_TEAM_ID).length;
  const pptPool = state.picks_per_team || 0;
  const mySquadFull = pptPool > 0 && myTeamPickCount >= pptPool;
  const isMyTurn = onClockTeam?.id === MY_TEAM_ID && !mySquadFull;

  const list = document.getElementById('player-list');
  list.innerHTML = filtered.map(p => {
    let cls = 'player-item';
    if (state.format === 'auction') {
      if (p.id === state.current_nomination) cls += ' on-clock';
      else cls += ' disabled';
    } else if (isMyTurn) {
      cls += ' my-turn-active';
    } else {
      cls += ' disabled';
    }

    const extras = Object.entries(p.metadata || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');

    const subtitle = [p.country, p.team_affiliation].filter(Boolean).join(' · ');
    return `<div class="${cls}" data-id="${p.id}" title="${escHtml(extras)}">
      <span class="pos-badge">${escHtml(p.position || '—')}</span>
      <div class="player-info">
        <div class="player-name">${escHtml(p.name)}</div>
        ${subtitle ? `<div class="player-team">${escHtml(subtitle)}</div>` : ''}
      </div>
    </div>`;
  }).join('') || `<div style="padding:20px;text-align:center;color:var(--text-muted)">No players found</div>`;

  // Click handlers (non-auction only)
  list.querySelectorAll('.player-item:not(.disabled)').forEach(el => {
    el.addEventListener('click', () => {
      const playerId = el.dataset.id;
      if (isMyTurn && state.format !== 'auction') {
        showPickModal(playerId);
      }
    });
  });
}

function renderDraftBoard(onClockTeam) {
  const teams = state.teams;
  const players = state.players;
  const numTeams = teams.length;
  if (numTeams === 0) return;

  const picks = players.filter(p => p.drafted_by !== null && p.drafted_by !== undefined);
  const maxRound = picks.length > 0
    ? Math.floor(Math.max(...picks.map(p => p.pick_number)) / numTeams) + 1
    : 1;
  const pptBoard = state.picks_per_team || 0;
  const totalRounds = pptBoard > 0
    ? pptBoard
    : Math.max(maxRound, Math.ceil(players.length / numTeams));

  if (boardView === 'list') {
    renderBoardList(picks, teams);
    return;
  }

  // Grid view
  const board = document.getElementById('draft-board');
  const cols = numTeams + 1; // +1 for round label

  // Build pick lookup: pick_number -> player
  const pickMap = {};
  for (const p of picks) pickMap[p.pick_number] = p;

  // Team name row
  let html = `<div class="board-grid" style="grid-template-columns: 32px repeat(${numTeams}, minmax(90px, 1fr))">`;

  // Header row
  html += `<div class="round-label"></div>`;
  for (const team of teams) {
    const isMe = team.id === MY_TEAM_ID;
    const isClock = team.id === onClockTeam?.id;
    let cls = 'board-col-header';
    if (isMe) cls += ' me';
    if (isClock) cls += ' on-clock';
    html += `<div class="${cls}" title="${escHtml(team.name)}">${escHtml(team.name)}</div>`;
  }

  // Round rows — iterate by team column so each column always shows the same team
  for (let round = 0; round < totalRounds; round++) {
    html += `<div class="round-label">${round + 1}</div>`;
    for (let teamIdx = 0; teamIdx < numTeams; teamIdx++) {
      // For snake, reverse the pick order in odd rounds
      const pickNum = state.format === 'snake' && round % 2 !== 0
        ? round * numTeams + (numTeams - 1 - teamIdx)
        : round * numTeams + teamIdx;
      const team = teams[teamIdx];
      const isMe = team?.id === MY_TEAM_ID;
      const isClock = pickNum === state.current_pick;
      const pick = pickMap[pickNum];

      // Trade ownership
      const boardOwnership = state.pick_ownership || {};
      const naturalOwnerId = team?.id;
      const currentOwnerId = boardOwnership[String(pickNum)] || naturalOwnerId;
      const isTradedAway = !pick && currentOwnerId !== naturalOwnerId;
      const tradedToTeam = isTradedAway ? teams.find(t => t.id === currentOwnerId) : null;
      const isDraftedByOther = pick && pick.drafted_by !== naturalOwnerId;
      const draftedByTeam = isDraftedByOther ? teams.find(t => t.id === pick.drafted_by) : null;

      let cls = 'board-cell';
      if (!pick) cls += ' empty';
      if (isMe) cls += ' me';
      if (isClock && !pick) cls += ' on-clock';
      if (isTradedAway) cls += ' traded-away';

      html += `<div class="${cls}">`;
      if (pick) {
        html += `<div class="cell-player">${escHtml(pick.name)}</div>`;
        if (pick.position) html += `<div class="cell-pos">${escHtml(pick.position)}</div>`;
        if (pick.bid_amount) html += `<div class="cell-pos">$${pick.bid_amount}</div>`;
        if (isDraftedByOther) html += `<div class="cell-traded-tag" title="Pick traded to ${escHtml(draftedByTeam?.name || '?')}">⇄ ${escHtml(draftedByTeam?.name || '?')}</div>`;
      } else if (isTradedAway) {
        // Traded pick: show new owner regardless of whether it's the current pick
        html += `<div class="cell-traded-tag">⇄ ${escHtml(tradedToTeam?.name || '?')}</div>`;
      } else if (isClock) {
        html += `<div class="cell-pos" style="color:var(--primary)">On the clock…</div>`;
      }
      html += `</div>`;
    }
  }

  html += '</div>';
  board.innerHTML = html;
}

function renderBoardList(picks, teams) {
  const teamMap = Object.fromEntries(teams.map(t => [t.id, t]));
  const sorted = [...picks].sort((a, b) => a.pick_number - b.pick_number);
  const numTeams = teams.length;
  document.getElementById('draft-board').innerHTML = sorted.map(p => {
    const team = teamMap[p.drafted_by];
    const round = Math.floor(p.pick_number / numTeams) + 1;
    const pickInRound = (p.pick_number % numTeams) + 1;
    return `<div class="pick-list-item">
      <span class="pick-num">${p.pick_number + 1}</span>
      <span>${escHtml(p.name)}${p.position ? ` <span style="color:var(--text-muted)">(${escHtml(p.position)})</span>` : ''}</span>
      <span class="pick-team">${escHtml(team?.name || '?')}</span>
    </div>`;
  }).join('') || `<div style="padding:20px;text-align:center;color:var(--text-muted)">No picks yet</div>`;
}

function renderAuctionBoard() {
  const sold = state.players.filter(p => p.drafted_by);
  const unsold = state.players.filter(p => p.unsold);
  const teamMap = Object.fromEntries(state.teams.map(t => [t.id, t]));
  const sortedSold = [...sold].sort((a, b) => a.pick_number - b.pick_number);
  const soldHtml = sortedSold.map(p => {
    const team = teamMap[p.drafted_by];
    return `<div class="auction-result">
      <span>${escHtml(p.name)}${p.position ? ` <span style="color:var(--text-muted)">(${escHtml(p.position)})</span>` : ''}</span>
      <span class="bid-amount">$${p.bid_amount}</span>
      <span style="color:var(--text-muted);font-size:12px">${escHtml(team?.name || '?')}</span>
    </div>`;
  }).join('');
  const unsoldHtml = unsold.map(p =>
    `<div class="auction-result" style="opacity:0.5">
      <span>${escHtml(p.name)}${p.position ? ` <span style="color:var(--text-muted)">(${escHtml(p.position)})</span>` : ''}</span>
      <span style="color:var(--danger);font-size:12px">Unsold</span>
      <span></span>
    </div>`
  ).join('');
  document.getElementById('draft-board').innerHTML =
    soldHtml + unsoldHtml ||
    `<div style="padding:20px;text-align:center;color:var(--text-muted)">No picks yet</div>`;
}

function renderAuctionPanel() {
  const panel = document.getElementById('auction-panel');
  const nominatedCard = document.getElementById('nominated-player-card');
  const bidInputRow = document.getElementById('bid-input-row');
  const nominateHint = document.getElementById('nominate-hint');
  const commAuctionBtns = document.getElementById('commissioner-auction-btns');
  const pauseBtn = document.getElementById('pause-auction-btn');
  const resumeBtn = document.getElementById('resume-auction-btn');
  const closeBidBtn = document.getElementById('close-auction-btn');
  const skipBtn = document.getElementById('skip-nomination-btn');

  if (!state.current_nomination) {
    nominatedCard.innerHTML = `<div style="color:var(--text-muted);font-size:13px">${state.auction_paused ? '⏸ Auction paused' : 'Loading next player…'}</div>`;
    document.getElementById('bids-list').innerHTML = '';
    document.getElementById('auction-timer').style.display = 'none';
    bidInputRow.style.display = 'none';
    nominateHint.style.display = 'none';
    if (isCommissioner && state.auction_paused) {
      commAuctionBtns.style.display = 'flex';
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = '';
      closeBidBtn.style.display = 'none';
      skipBtn.style.display = 'none';
    } else {
      commAuctionBtns.style.display = 'none';
    }
    panel.style.display = state.status === 'active' ? 'grid' : 'none';
    return;
  }

  panel.style.display = 'grid';
  nominateHint.style.display = 'none';
  if (isCommissioner) {
    commAuctionBtns.style.display = 'flex';
    closeBidBtn.style.display = '';
    skipBtn.style.display = '';
    if (state.auction_paused) {
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = '';
    } else {
      pauseBtn.style.display = '';
      resumeBtn.style.display = 'none';
    }
  } else {
    commAuctionBtns.style.display = 'none';
  }

  const player = state.players.find(p => p.id === state.current_nomination);
  if (player) {
    nominatedCard.innerHTML = `
      <div class="player-name-big">${escHtml(player.name)}</div>
      <div class="player-details">
        ${player.position ? `Position: ${escHtml(player.position)}` : ''}
        ${player.country ? ` · ${escHtml(player.country)}` : ''}
        ${player.team_affiliation ? ` · ${escHtml(player.team_affiliation)}` : ''}
        ${state.auction_paused ? '<span style="color:var(--warning);margin-left:8px">⏸ Paused</span>' : ''}
      </div>`;
  }

  renderAuctionBids();

  // Show bid input if team member, has budget, and squad isn't full
  if (MY_TEAM_TOKEN) {
    const myTeam = state.teams.find(t => t.id === MY_TEAM_ID);
    const myPicksCount = state.players.filter(p => p.drafted_by === MY_TEAM_ID).length;
    const pptAuction = state.picks_per_team || 0;
    const squadFull = pptAuction > 0 && myPicksCount >= pptAuction;
    bidInputRow.style.display = myTeam && myTeam.budget > 0 && !squadFull ? 'flex' : 'none';
    const bidInput = document.getElementById('bid-amount');
    const topBid = (state.current_bids || []).length > 0 ? state.current_bids[0].amount : 0;
    const minBid = topBid + 1;
    bidInput.min = minBid;
    bidInput.max = myTeam?.budget || 1;
    bidInput.placeholder = `Min $${minBid} — Max $${myTeam?.budget || '?'}`;
  } else {
    bidInputRow.style.display = 'none';
  }
}

function renderAuctionBids() {
  const list = document.getElementById('bids-list');
  if (!list) return;
  const bids = state.current_bids || [];
  if (bids.length === 0) {
    list.innerHTML = `<div style="color:var(--text-muted);font-size:12px">No bids yet</div>`;
    return;
  }
  list.innerHTML = bids.map((b, i) => {
    const isTop = i === 0;
    const isMe = b.team_id === MY_TEAM_ID;
    return `<div class="bid-item" style="${isTop ? 'border:1px solid var(--warning)' : ''}${isMe ? ';background:var(--primary-dim)' : ''}">
      <span>${isTop ? '👑 ' : ''}${escHtml(b.team_name)}${isMe ? ' (you)' : ''}</span>
      <span class="bid-val">$${b.amount}</span>
    </div>`;
  }).join('');
}

function renderMyTeam() {
  const myTeamNameEl = document.getElementById('my-team-name');
  const myPicksEl = document.getElementById('my-picks');
  const myBudgetEl = document.getElementById('my-budget');
  const myBudgetAmount = document.getElementById('my-budget-amount');

  if (!MY_TEAM_ID) {
    myTeamNameEl.textContent = isCommissioner ? '(Commissioner)' : '(Spectator)';
    myPicksEl.innerHTML = '';
    return;
  }

  const myTeam = state.teams.find(t => t.id === MY_TEAM_ID);
  if (!myTeam) return;

  const myPicks = state.players
    .filter(p => p.drafted_by === MY_TEAM_ID)
    .sort((a, b) => a.pick_number - b.pick_number);
  const ppt = state.picks_per_team || 0;
  const squadLabel = ppt > 0 ? ` (${myPicks.length}/${ppt})` : '';
  myTeamNameEl.textContent = myTeam.name + squadLabel;

  if (state.format === 'auction') {
    myBudgetEl.style.display = 'block';
    myBudgetAmount.textContent = `$${myTeam.budget}`;
  } else {
    myBudgetEl.style.display = 'none';
  }

  // Position requirements tracker

  const reqs = parseRequirements(state.position_requirements);
  if (reqs.length > 0) {
    const counts = {};
    myPicks.forEach(p => {
      const pos = (p.position || '').toUpperCase();
      counts[pos] = (counts[pos] || 0) + 1;
    });
    const trackerHtml = reqs.map(({ positions, min }) => {
      const have = positions.reduce((sum, pos) => sum + (counts[pos] || 0), 0);
      const met = have >= min;
      const color = met ? 'var(--success)' : have > 0 ? 'var(--warning)' : 'var(--danger)';
      const label = positions.join(' / ');
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px">
        <span style="color:var(--text-muted)">${escHtml(label)}</span>
        <span style="color:${color};font-weight:600">${have}/${min}${met ? ' ✓' : ''}</span>
      </div>`;
    }).join('');
    myPicksEl.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Requirements</div>
        ${trackerHtml}
      </div>`;
  } else {
    myPicksEl.innerHTML = '';
  }

  const numTeams = state.teams.length;
  myPicksEl.innerHTML += myPicks.map(p => {
    const round = Math.floor(p.pick_number / numTeams) + 1;
    return `<div class="my-pick-item">
      <span class="pick-round">R${round}</span>
      <span class="pos-badge">${escHtml(p.position || '—')}</span>
      <span class="player-name" style="flex:1">${escHtml(p.name)}</span>
      ${p.bid_amount ? `<span style="color:var(--warning);font-size:11px">$${p.bid_amount}</span>` : ''}
    </div>`;
  }).join('') || `<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No picks yet</div>`;
}

function renderAllTeams(onClockTeam) {
  const list = document.getElementById('all-teams-list');
  list.innerHTML = state.teams.map(team => {
    const picks = state.players.filter(p => p.drafted_by === team.id).length;
    const isClock = team.id === onClockTeam?.id;
    const isMe = team.id === MY_TEAM_ID;
    const ppt2 = state.picks_per_team || 0;
    const isFull = ppt2 > 0 && picks >= ppt2;
    let cls = 'team-summary-item';
    if (isClock) cls += ' on-clock';
    if (isMe) cls += ' me';

    const picksLabel = ppt2 > 0 ? `${picks}/${ppt2}` : `${picks} pick${picks !== 1 ? 's' : ''}`;
    const canTrade = MY_TEAM_TOKEN && !isMe && state.status === 'active' && state.format !== 'auction';
    return `<div class="${cls}">
      <div>
        <div style="font-weight:${isMe ? '700' : '400'}">${escHtml(team.name)}</div>
        ${isClock ? `<div class="on-clock-label">ON THE CLOCK</div>` : ''}
        ${isFull ? `<div style="font-size:10px;color:var(--success);font-weight:600">FULL</div>` : ''}
        ${canTrade ? `<button class="btn btn-sm" style="font-size:10px;padding:2px 8px;margin-top:4px" data-trade-with="${escHtml(team.id)}">Trade</button>` : ''}
      </div>
      <div style="text-align:right">
        <div class="team-picks-count">${picksLabel}</div>
        ${state.format === 'auction' ? `<div class="team-budget">$${team.budget}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-trade-with]').forEach(btn => {
    btn.addEventListener('click', () => openTradeModal(btn.dataset.tradeWith));
  });
}

async function renderCompleted() {
  // Show league buttons for commissioner
  const startBtn = document.getElementById('start-league-btn');
  const viewBtn = document.getElementById('view-league-btn');
  if (isCommissioner) {
    const existingLeagueId = localStorage.getItem(`league_${DRAFT_ID}`);
    if (existingLeagueId) {
      viewBtn.href = `/league.html?id=${existingLeagueId}`;
      viewBtn.style.display = '';
      startBtn.style.display = 'none';
    } else {
      startBtn.style.display = '';
      viewBtn.style.display = 'none';
    }
  }

  const teamMap = Object.fromEntries(state.teams.map(t => [t.id, t]));
  const sortedTeams = [...state.teams].sort((a, b) => a.pick_order - b.pick_order);
  const numTeams = state.teams.length;

  document.getElementById('final-rosters').innerHTML = sortedTeams.map(team => {
    const picks = state.players
      .filter(p => p.drafted_by === team.id)
      .sort((a, b) => a.pick_number - b.pick_number);
    const isMe = team.id === MY_TEAM_ID;
    const round = (n) => Math.floor(n / numTeams) + 1;

    return `<div class="roster-card ${isMe ? 'me' : ''}">
      <h3>${isMe ? '★ ' : ''}${escHtml(team.name)}</h3>
      ${picks.map(p => `<div class="roster-pick">
        <span>R${round(p.pick_number)} · ${escHtml(p.name)}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="r-pos">${escHtml(p.position || '')}</span>
          ${p.bid_amount ? `<span class="r-bid">$${p.bid_amount}</span>` : ''}
        </div>
      </div>`).join('')}
      ${picks.length === 0 ? '<div style="color:var(--text-muted);font-size:12px">No picks</div>' : ''}
      ${state.format === 'auction' ? `<div style="margin-top:8px;font-size:12px;color:var(--warning)">Budget remaining: $${team.budget}</div>` : ''}
    </div>`;
  }).join('');
}

// ── Pick Modal ────────────────────────────────────────────────────────────────
function showPickModal(playerId) {
  const player = state.players.find(p => p.id === playerId);
  if (!player) return;
  pendingPickId = playerId;
  document.getElementById('pick-modal-text').textContent =
    `Draft ${player.name}${player.position ? ` (${player.position})` : ''}?`;
  document.getElementById('pick-modal').style.display = 'flex';
}

document.getElementById('pick-confirm-btn').addEventListener('click', () => {
  if (!pendingPickId) return;
  socket.emit('make-pick', { teamToken: MY_TEAM_TOKEN, playerId: pendingPickId });
  pendingPickId = null;
  document.getElementById('pick-modal').style.display = 'none';
});

document.getElementById('pick-cancel-btn').addEventListener('click', () => {
  pendingPickId = null;
  document.getElementById('pick-modal').style.display = 'none';
});

document.getElementById('pick-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    pendingPickId = null;
    e.currentTarget.style.display = 'none';
  }
});

// ── Auction Buttons ───────────────────────────────────────────────────────────
document.getElementById('place-bid-btn')?.addEventListener('click', () => {
  const amount = parseInt(document.getElementById('bid-amount').value);
  if (!amount || amount < 1) { toast('Enter a valid bid amount', 'error'); return; }
  socket.emit('place-bid', { teamToken: MY_TEAM_TOKEN, amount });
  document.getElementById('bid-amount').value = '';
  toast(`Bid $${amount} placed`, 'success');
});

document.getElementById('close-auction-btn')?.addEventListener('click', () => {
  socket.emit('close-auction', { commissionerToken: COMMISSIONER_TOKEN });
});

document.getElementById('pause-auction-btn')?.addEventListener('click', () => {
  socket.emit('pause-auction', { commissionerToken: COMMISSIONER_TOKEN });
});

document.getElementById('resume-auction-btn')?.addEventListener('click', () => {
  socket.emit('resume-auction', { commissionerToken: COMMISSIONER_TOKEN });
});

document.getElementById('skip-nomination-btn')?.addEventListener('click', () => {
  socket.emit('skip-nomination', { commissionerToken: COMMISSIONER_TOKEN });
});

// ── Commissioner Controls ─────────────────────────────────────────────────────
document.getElementById('copy-my-link-btn')?.addEventListener('click', () => {
  const link = `${location.origin}/draft.html?id=${DRAFT_ID}&token=${MY_TEAM_TOKEN}`;
  navigator.clipboard.writeText(link).then(() => toast('Personal link copied!', 'success'));
});

document.getElementById('join-as-team-btn')?.addEventListener('click', async () => {
  const name = document.getElementById('join-team-name').value.trim();
  if (!name) { toast('Enter a team name', 'error'); return; }
  const email = document.getElementById('join-team-email')?.value?.trim() || null;
  try {
    const res = await fetch(`/api/drafts/${DRAFT_ID}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_name: name, email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    MY_TEAM_ID = data.team_id;
    MY_TEAM_TOKEN = data.token;
    localStorage.setItem(`team_${DRAFT_ID}_id`, data.team_id);
    localStorage.setItem(`team_${DRAFT_ID}_token`, data.token);
    document.getElementById('join-as-team-section').style.display = 'none';
    toast(`Joined as "${name}"`, 'success');
    // Re-join socket with team token so server knows this socket is now a team
    socket.emit('join-draft', {
      draftId: DRAFT_ID,
      commissionerToken: COMMISSIONER_TOKEN || undefined,
      teamToken: data.token
    });
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('start-draft-btn')?.addEventListener('click', () => {
  socket.emit('start-draft', { commissionerToken: COMMISSIONER_TOKEN });
});

document.getElementById('end-draft-btn')?.addEventListener('click', () => {
  if (!confirm('End the draft early? This will mark it as completed.')) return;
  socket.emit('complete-draft', { commissionerToken: COMMISSIONER_TOKEN });
});

async function deleteDraft() {
  if (!confirm('Permanently delete this draft? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/drafts/${DRAFT_ID}`, {
      method: 'DELETE',
      headers: { 'x-commissioner-token': COMMISSIONER_TOKEN }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    location.href = '/';
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('delete-draft-btn')?.addEventListener('click', deleteDraft);
document.getElementById('delete-draft-btn-waiting')?.addEventListener('click', deleteDraft);

document.getElementById('start-league-btn')?.addEventListener('click', () => {
  location.href = `/league-setup.html?draft_id=${DRAFT_ID}`;
});

document.getElementById('upload-csv-btn')?.addEventListener('click', async () => {
  const file = document.getElementById('upload-csv').files[0];
  if (!file) { toast('Select a CSV file first', 'error'); return; }
  const fd = new FormData();
  fd.append('players_csv', file);
  try {
    const res = await fetch(`/api/drafts/${DRAFT_ID}/players`, {
      method: 'POST',
      headers: { 'x-commissioner-token': COMMISSIONER_TOKEN },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`${data.player_count} players loaded`, 'success');
    document.getElementById('player-count-badge').textContent = `✓ ${data.player_count} players`;
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Mobile Tab Switching ──────────────────────────────────────────────────────
const mobileTabBar = document.querySelector('.mobile-tab-bar');
const mobileTabPanels = {
  pool: document.querySelector('.player-pool'),
  board: document.querySelector('.draft-board-container'),
  team: document.querySelector('.my-team-panel'),
};

function setMobileTab(tab) {
  mobileTabBar.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  Object.entries(mobileTabPanels).forEach(([key, el]) => {
    el.classList.toggle('mobile-active', key === tab);
  });
}

setMobileTab('pool');

mobileTabBar.querySelectorAll('.mobile-tab').forEach(btn => {
  btn.addEventListener('click', () => setMobileTab(btn.dataset.tab));
});

// ── Board view toggle ─────────────────────────────────────────────────────────
document.getElementById('toggle-view-btn')?.addEventListener('click', () => {
  boardView = boardView === 'grid' ? 'list' : 'grid';
  document.getElementById('toggle-view-btn').textContent = boardView === 'grid' ? 'List View' : 'Grid View';
  if (state) render();
});

// ── Copy Draft ID ─────────────────────────────────────────────────────────────
function copyDraftId() {
  const joinUrl = `${location.origin}/?join=${DRAFT_ID}`;
  navigator.clipboard.writeText(joinUrl).then(() => toast('Join link copied!', 'success'));
}
document.getElementById('copy-id-btn')?.addEventListener('click', copyDraftId);
document.getElementById('copy-id-btn-waiting')?.addEventListener('click', copyDraftId);

// ── Search & filter ───────────────────────────────────────────────────────────
document.getElementById('player-search')?.addEventListener('input', () => { if (state) render(); });
document.getElementById('pos-filter')?.addEventListener('change', () => { if (state) render(); });
document.getElementById('team-filter')?.addEventListener('change', () => { if (state) render(); });

// ── Draft Trades ──────────────────────────────────────────────────────────────

function getTeamFuturePicks(teamId) {
  if (!state) return [];
  const { teams, format, current_pick, picks_per_team, players, pick_ownership } = state;
  const numTeams = teams.length;
  const ppt = picks_per_team > 0 ? picks_per_team : Math.ceil(players.length / numTeams);
  const totalPicks = numTeams * ppt;
  const ownership = pick_ownership || {};
  const result = [];
  for (let p = current_pick; p < totalPicks; p++) {
    const ownerId = ownership[String(p)] || teams[getTeamIndex(p, numTeams, format)]?.id;
    if (ownerId === teamId) {
      const round = Math.floor(p / numTeams) + 1;
      const pickInRound = (p % numTeams) + 1;
      result.push({ pickNum: p, label: `Round ${round}, Pick ${pickInRound}` });
    }
  }
  return result;
}

async function fetchAndRenderTrades(autoOpenTradeId = null) {
  try {
    const res = await fetch(`/api/drafts/${DRAFT_ID}/trades`);
    if (!res.ok) return;
    draftTrades = await res.json();
    updateTradesBadge();
    if (autoOpenTradeId) {
      const trade = draftTrades.find(t => t.id === autoOpenTradeId);
      if (trade && trade.status === 'pending' && trade.receiving_team_id === MY_TEAM_ID) {
        showIncomingTradeModal(trade);
      }
    }
  } catch { /* ignore */ }
}

function updateTradesBadge() {
  const badge = document.getElementById('trades-badge');
  if (!badge) return;
  const pending = draftTrades.filter(t =>
    t.status === 'pending' && t.receiving_team_id === MY_TEAM_ID
  ).length;
  if (pending > 0) {
    badge.textContent = pending;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

function openTradeModal(opponentId) {
  if (!MY_TEAM_TOKEN) return;
  tradeOfferedPickNums = new Set();
  tradeRequestedPickNums = new Set();
  tradeOfferedPlayerIds = new Set();
  tradeRequestedPlayerIds = new Set();

  const select = document.getElementById('trade-opponent-id');
  select.innerHTML = state.teams
    .filter(t => t.id !== MY_TEAM_ID)
    .map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`)
    .join('');
  if (opponentId) select.value = opponentId;

  document.getElementById('trade-note').value = '';
  renderTradeColumns();
  document.getElementById('trade-modal').style.display = 'flex';
}

function renderTradeColumns() {
  const opponentId = document.getElementById('trade-opponent-id').value;
  if (!opponentId) {
    document.getElementById('trade-columns').style.display = 'none';
    document.getElementById('trade-submit-btn').style.display = 'none';
    return;
  }

  document.getElementById('trade-columns').style.display = '';
  document.getElementById('trade-submit-btn').style.display = '';

  const myPicks = getTeamFuturePicks(MY_TEAM_ID);
  const theirPicks = getTeamFuturePicks(opponentId);
  const myPlayers = state.players.filter(p => p.drafted_by === MY_TEAM_ID);
  const theirPlayers = state.players.filter(p => p.drafted_by === opponentId);

  const renderPickList = (picks, selectedSet, containerId) => {
    const el = document.getElementById(containerId);
    el.innerHTML = picks.length
      ? picks.map(p => `<div class="trade-item${selectedSet.has(p.pickNum) ? ' selected' : ''}" data-pick="${p.pickNum}">${escHtml(p.label)}</div>`).join('')
      : '<div style="color:var(--text-muted);font-size:12px;padding:4px 0">No future picks</div>';
  };

  const renderPlayerList = (players, selectedSet, containerId) => {
    const el = document.getElementById(containerId);
    el.innerHTML = players.length
      ? players.map(p => `<div class="trade-item${selectedSet.has(p.id) ? ' selected' : ''}" data-player="${escHtml(p.id)}"><span class="pos-badge">${escHtml(p.position || '—')}</span>${escHtml(p.name)}</div>`).join('')
      : '<div style="color:var(--text-muted);font-size:12px;padding:4px 0">No players drafted yet</div>';
  };

  renderPickList(myPicks, tradeOfferedPickNums, 'trade-offer-picks');
  renderPickList(theirPicks, tradeRequestedPickNums, 'trade-request-picks');
  renderPlayerList(myPlayers, tradeOfferedPlayerIds, 'trade-offer-players');
  renderPlayerList(theirPlayers, tradeRequestedPlayerIds, 'trade-request-players');

  document.querySelectorAll('#trade-offer-picks .trade-item[data-pick]').forEach(el => {
    el.addEventListener('click', () => {
      const pn = parseInt(el.dataset.pick);
      if (tradeOfferedPickNums.has(pn)) tradeOfferedPickNums.delete(pn); else tradeOfferedPickNums.add(pn);
      renderTradeColumns();
    });
  });
  document.querySelectorAll('#trade-request-picks .trade-item[data-pick]').forEach(el => {
    el.addEventListener('click', () => {
      const pn = parseInt(el.dataset.pick);
      if (tradeRequestedPickNums.has(pn)) tradeRequestedPickNums.delete(pn); else tradeRequestedPickNums.add(pn);
      renderTradeColumns();
    });
  });
  document.querySelectorAll('#trade-offer-players .trade-item[data-player]').forEach(el => {
    el.addEventListener('click', () => {
      if (tradeOfferedPlayerIds.has(el.dataset.player)) tradeOfferedPlayerIds.delete(el.dataset.player);
      else tradeOfferedPlayerIds.add(el.dataset.player);
      renderTradeColumns();
    });
  });
  document.querySelectorAll('#trade-request-players .trade-item[data-player]').forEach(el => {
    el.addEventListener('click', () => {
      if (tradeRequestedPlayerIds.has(el.dataset.player)) tradeRequestedPlayerIds.delete(el.dataset.player);
      else tradeRequestedPlayerIds.add(el.dataset.player);
      renderTradeColumns();
    });
  });
}

function tradeItemLabel(trade, state) {
  const numTeams = state.teams.length;
  const pickLabel = pns => (pns || []).map(pn => {
    const r = Math.floor(pn / numTeams) + 1;
    const p = (pn % numTeams) + 1;
    return `R${r}P${p}`;
  });
  const playerLabel = ids => (ids || []).map(id => {
    const pl = state.players.find(p => p.id === id);
    return pl ? `${pl.name}${pl.position ? ` (${pl.position})` : ''}` : id;
  });
  const offered = [...pickLabel(trade.offered_pick_numbers), ...playerLabel(trade.offered_player_ids)];
  const requested = [...pickLabel(trade.requested_pick_numbers), ...playerLabel(trade.requested_player_ids)];
  return { offered, requested };
}

function showIncomingTradeModal(trade) {
  activePendingTradeId = trade.id;
  document.getElementById('trade-incoming-title').textContent = `Trade offer from ${trade.proposing_team_name}`;

  let body = '';
  if (state) {
    const { offered, requested } = tradeItemLabel(trade, state);
    body += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">They offer</div>
        ${offered.map(s => `<div style="font-size:13px;padding:4px 0;border-bottom:1px solid var(--border)">${escHtml(s)}</div>`).join('') || '<div style="color:var(--text-muted);font-size:12px">Nothing</div>'}
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">You give</div>
        ${requested.map(s => `<div style="font-size:13px;padding:4px 0;border-bottom:1px solid var(--border)">${escHtml(s)}</div>`).join('') || '<div style="color:var(--text-muted);font-size:12px">Nothing</div>'}
      </div>
    </div>`;
  }
  if (trade.note) body += `<div style="margin-top:10px;padding:8px;background:var(--surface2);border-radius:var(--radius-sm);font-size:12px;color:var(--text-muted)">"${escHtml(trade.note)}"</div>`;

  document.getElementById('trade-incoming-body').innerHTML = body;
  document.getElementById('trade-incoming-modal').style.display = 'flex';
}

function renderTradesList() {
  const body = document.getElementById('trades-list-body');
  if (draftTrades.length === 0) {
    body.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">No trades yet</div>';
    return;
  }

  body.innerHTML = draftTrades.map(trade => {
    const statusColor = { pending: 'var(--warning)', accepted: 'var(--success)', rejected: 'var(--danger)', cancelled: 'var(--text-muted)' }[trade.status] || 'var(--text-muted)';
    let actions = '';
    if (trade.status === 'pending') {
      if (trade.receiving_team_id === MY_TEAM_ID) {
        actions = `<button class="btn btn-sm btn-success" style="font-size:11px;padding:3px 8px" data-trade-respond="${escHtml(trade.id)}" data-action="accept">Accept</button>
          <button class="btn btn-sm btn-danger" style="font-size:11px;padding:3px 8px" data-trade-respond="${escHtml(trade.id)}" data-action="reject">Reject</button>`;
      } else if (trade.proposing_team_id === MY_TEAM_ID) {
        actions = `<button class="btn btn-sm" style="font-size:11px;padding:3px 8px" data-trade-respond="${escHtml(trade.id)}" data-action="cancel">Cancel</button>`;
      }
    }

    let summary = '';
    if (state) {
      const { offered, requested } = tradeItemLabel(trade, state);
      summary = `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${escHtml(trade.proposing_team_name)} offers ${offered.join(', ') || '—'} for ${requested.join(', ') || '—'}</div>`;
    }

    return `<div class="trade-list-item ${trade.status}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div>
          <span style="font-weight:600;font-size:13px">${escHtml(trade.proposing_team_name)} → ${escHtml(trade.receiving_team_name)}</span>
          ${summary}
          ${trade.note ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-style:italic">"${escHtml(trade.note)}"</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <span style="font-size:11px;font-weight:600;color:${statusColor};text-transform:uppercase">${trade.status}</span>
          <div style="display:flex;gap:4px">${actions}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  body.querySelectorAll('[data-trade-respond]').forEach(btn => {
    btn.addEventListener('click', () => respondTrade(btn.dataset.tradeRespond, btn.dataset.action));
  });
}

async function respondTrade(tradeId, action) {
  try {
    const res = await fetch(`/api/drafts/${DRAFT_ID}/trades/${tradeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_token: MY_TEAM_TOKEN, action })
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error, 'error'); return; }
    document.getElementById('trade-incoming-modal').style.display = 'none';
    activePendingTradeId = null;
    fetchAndRenderTrades();
    if (action === 'accept') toast('Trade accepted!', 'success');
    else if (action === 'reject') toast('Trade rejected', 'info');
    else if (action === 'cancel') toast('Trade cancelled', 'info');
  } catch (err) { toast(err.message, 'error'); }
}

// Trade modal event listeners
document.getElementById('trade-opponent-id')?.addEventListener('change', () => {
  tradeOfferedPickNums = new Set();
  tradeRequestedPickNums = new Set();
  tradeOfferedPlayerIds = new Set();
  tradeRequestedPlayerIds = new Set();
  renderTradeColumns();
});

document.getElementById('trade-modal-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('trade-modal').style.display = 'none';
});

document.getElementById('trade-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) document.getElementById('trade-modal').style.display = 'none';
});

document.getElementById('trade-submit-btn')?.addEventListener('click', async () => {
  const opponentId = document.getElementById('trade-opponent-id').value;
  const note = document.getElementById('trade-note').value.trim();
  const total = tradeOfferedPickNums.size + tradeOfferedPlayerIds.size;
  const asked = tradeRequestedPickNums.size + tradeRequestedPlayerIds.size;
  if (total === 0) { toast('Select at least one item to offer', 'error'); return; }
  if (asked === 0) { toast('Select at least one item to request', 'error'); return; }

  try {
    const res = await fetch(`/api/drafts/${DRAFT_ID}/trades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_token: MY_TEAM_TOKEN,
        receiving_team_id: opponentId,
        offered_pick_numbers: [...tradeOfferedPickNums],
        offered_player_ids: [...tradeOfferedPlayerIds],
        requested_pick_numbers: [...tradeRequestedPickNums],
        requested_player_ids: [...tradeRequestedPlayerIds],
        note: note || undefined,
      })
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error, 'error'); return; }
    document.getElementById('trade-modal').style.display = 'none';
    fetchAndRenderTrades();
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('trade-accept-btn')?.addEventListener('click', () => {
  if (activePendingTradeId) respondTrade(activePendingTradeId, 'accept');
});

document.getElementById('trade-reject-btn')?.addEventListener('click', () => {
  if (activePendingTradeId) respondTrade(activePendingTradeId, 'reject');
});

document.getElementById('trade-incoming-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) document.getElementById('trade-incoming-modal').style.display = 'none';
});

document.getElementById('trades-btn')?.addEventListener('click', async () => {
  await fetchAndRenderTrades();
  renderTradesList();
  document.getElementById('trades-list-modal').style.display = 'flex';
});

document.getElementById('trades-list-close-btn')?.addEventListener('click', () => {
  document.getElementById('trades-list-modal').style.display = 'none';
});

document.getElementById('trades-list-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) document.getElementById('trades-list-modal').style.display = 'none';
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTeamIndex(pickNumber, numTeams, format) {
  const round = Math.floor(pickNumber / numTeams);
  const pickInRound = pickNumber % numTeams;
  if (format === 'snake') return round % 2 === 0 ? pickInRound : numTeams - 1 - pickInRound;
  return pickInRound;
}

function parseRequirements(raw) {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  // Handle old format: { "GK": 1, "DEF": 4 } → convert to array format
  if (!Array.isArray(parsed)) {
    return Object.entries(parsed).map(([pos, min]) => ({ positions: [pos], min }));
  }
  return parsed;
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function show(id) { document.getElementById(id).style.display = ''; }
function hide(id) { document.getElementById(id).style.display = 'none'; }

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Badge helpers ─────────────────────────────────────────────────────────────
function setFormatBadge() {
  const el = document.getElementById('format-badge');
  const labels = { snake: 'Snake', linear: 'Linear', auction: 'Auction' };
  el.textContent = labels[state.format] || state.format;
  el.className = `badge badge-${state.format}`;
}

function setModeBadge() {
  const el = document.getElementById('mode-badge');
  if (state.is_slow_draft) {
    el.textContent = 'Slow';
    el.className = 'badge badge-slow';
  } else {
    el.textContent = state.mode === 'live' ? 'Live' : 'Async';
    el.className = `badge badge-${state.mode}`;
  }
}

function setStatusBadge() {
  const el = document.getElementById('status-badge');
  el.textContent = state.status;
  el.className = `badge badge-${state.status}`;
}

function updatePickCounter() {
  const el = document.getElementById('pick-counter');
  if (state.status === 'active' && state.format !== 'auction') {
    const ppt = state.picks_per_team || 0;
    const total = ppt > 0 ? state.teams.length * ppt : state.players.length;
    el.textContent = `Pick ${state.current_pick + 1} of ${total}`;
  } else if (state.status === 'active' && state.format === 'auction') {
    const drafted = state.players.filter(p => p.drafted_by).length;
    const unsold = state.players.filter(p => p.unsold).length;
    const ppt = state.picks_per_team || 0;
    const total = ppt > 0 ? state.teams.length * ppt : state.players.length - unsold;
    el.textContent = `${drafted} / ${total} players${unsold ? ` · ${unsold} unsold` : ''}`;
  } else {
    el.textContent = '';
  }
}

// ── Quiet Hours Check ─────────────────────────────────────────────────────────
function isCurrentlyQuietHours(s) {
  if (!s.is_slow_draft || s.quiet_hours_start === s.quiet_hours_end) return false;
  try {
    const h = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: s.quiet_timezone || 'Europe/London',
      hour: '2-digit', hour12: false
    }).format(new Date()));
    const hr = h === 24 ? 0 : h;
    return hr >= s.quiet_hours_start && hr < s.quiet_hours_end;
  } catch { return false; }
}

// ── Slow Draft Deadline Countdown ────────────────────────────────────────────
function startSlowDeadlineCountdown(deadlineIso, timerEl) {
  stopSlowDeadlineCountdown();
  function tick() {
    const remaining = Math.max(0, new Date(deadlineIso).getTime() - Date.now());
    const totalMins = Math.floor(remaining / 60000);
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    let text;
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      text = `${days}d ${remHours}h`;
    } else if (hours > 0) {
      text = `${hours}h ${mins}m`;
    } else if (totalMins > 0) {
      const secs = Math.floor((remaining % 60000) / 1000);
      text = `${mins}m ${secs}s`;
    } else {
      text = 'Time up';
    }
    timerEl.textContent = text;
    const cls = totalMins < 60 ? 'timer warning' : totalMins < 10 ? 'timer urgent' : 'timer ok';
    timerEl.className = cls;
  }
  tick();
  slowDeadlineInterval = setInterval(tick, 1000);
}

function stopSlowDeadlineCountdown() {
  if (slowDeadlineInterval) { clearInterval(slowDeadlineInterval); slowDeadlineInterval = null; }
}

// ── Slow Draft Email Save ─────────────────────────────────────────────────────
document.getElementById('save-email-btn')?.addEventListener('click', async () => {
  const email = document.getElementById('slow-draft-email-input')?.value?.trim();
  if (!email) { toast('Enter an email address', 'error'); return; }
  try {
    const res = await fetch(`/api/drafts/${DRAFT_ID}/teams/${MY_TEAM_ID}/email`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MY_TEAM_TOKEN, email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('Email saved — you\'ll be notified when it\'s your pick', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Initial load ──────────────────────────────────────────────────────────────
// If not connected via socket yet, fetch state directly for fast initial render
fetch(`/api/drafts/${DRAFT_ID}`)
  .then(r => r.ok ? r.json() : null)
  .then(s => { if (s && !state) { state = s; render(); } })
  .catch(() => {});
