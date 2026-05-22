const params = new URLSearchParams(location.search);
const LEAGUE_ID = params.get('id');
if (!LEAGUE_ID) location.href = '/';

let state = null;
let COMMISSIONER_TOKEN = null;
let selectedTeamId = params.get('team') || null;

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Tab Nav ────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'my-team') renderMyTeam();
  });
});

// ── Load ───────────────────────────────────────────────────────────────────────

async function load() {
  const res = await fetch(`/api/leagues/${LEAGUE_ID}`);
  if (!res.ok) { document.getElementById('league-name').textContent = 'League not found'; return; }
  state = await res.json();

  COMMISSIONER_TOKEN = localStorage.getItem(`commissioner_${state.draft_id}`);

  document.getElementById('league-name').textContent = state.name;
  document.title = state.name;
  if (state.sport) {
    const b = document.getElementById('sport-badge');
    b.textContent = state.sport;
    b.style.display = '';
  }

  if (COMMISSIONER_TOKEN) {
    document.getElementById('settings-btn').style.display = '';
    document.getElementById('add-round-btn').style.display = '';
  }

  renderStandings();
  renderRounds();
}

// ── Standings ──────────────────────────────────────────────────────────────────

function renderStandings() {
  const el = document.getElementById('standings-container');
  const { standings, rounds } = state;

  if (!standings.length) { el.innerHTML = '<div style="color:var(--text-muted);padding:24px;text-align:center">No teams in this league yet.</div>'; return; }

  const completedRounds = rounds.filter(r => r.status === 'completed');

  el.innerHTML = `
    <div style="overflow-x:auto;margin-top:8px">
      <table class="league-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Team</th>
            <th class="pts-col">Total Pts</th>
            ${completedRounds.map(r => `<th class="pts-col" title="${escHtml(r.name)}">${escHtml(r.name)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${standings.map((team, i) => {
            const roundCells = completedRounds.map(r => {
              const rPts = team.rounds.find(x => x.round_id === r.id)?.points ?? '—';
              return `<td class="pts-col">${rPts}</td>`;
            }).join('');
            return `
              <tr class="standing-row" data-team="${team.team_id}" style="cursor:pointer">
                <td class="rank-cell">${i + 1}</td>
                <td><strong>${escHtml(team.team_name)}</strong></td>
                <td class="pts-col total-pts">${team.total_points}</td>
                ${roundCells}
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p style="color:var(--text-muted);font-size:12px;margin-top:8px">Click a team row to view their roster</p>
  `;

  el.querySelectorAll('.standing-row').forEach(row => {
    row.addEventListener('click', () => {
      selectedTeamId = row.dataset.team;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'my-team'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-my-team'));
      renderMyTeam();
    });
  });
}

// ── Rounds ─────────────────────────────────────────────────────────────────────

function statusBadge(s) {
  const cls = { upcoming: 'badge-muted', active: 'badge-warning', completed: 'badge-success' }[s] || 'badge-muted';
  return `<span class="badge ${cls}">${s}</span>`;
}

function renderRounds() {
  const el = document.getElementById('rounds-container');
  const { rounds } = state;

  if (!rounds.length) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:24px;text-align:center">No rounds yet.' +
      (COMMISSIONER_TOKEN ? ' Click <strong>+ New Round</strong> to add one.' : '') + '</div>';
    return;
  }

  el.innerHTML = rounds.map(r => `
    <div class="round-card">
      <div style="display:flex;align-items:center;gap:10px;flex:1">
        <span style="color:var(--text-muted);font-size:13px">Rnd ${r.round_number}</span>
        <strong>${escHtml(r.name)}</strong>
        ${statusBadge(r.status)}
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        ${COMMISSIONER_TOKEN ? `
          <select class="round-status-select btn btn-sm" data-round="${r.id}" style="width:auto;padding:4px 8px">
            <option value="upcoming" ${r.status==='upcoming'?'selected':''}>Upcoming</option>
            <option value="active" ${r.status==='active'?'selected':''}>Active</option>
            <option value="completed" ${r.status==='completed'?'selected':''}>Completed</option>
          </select>
        ` : ''}
        <a href="/round.html?league=${LEAGUE_ID}&round=${r.id}" class="btn btn-sm btn-primary">
          ${COMMISSIONER_TOKEN ? 'Enter Stats →' : 'View →'}
        </a>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('.round-status-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const roundId = sel.dataset.round;
      const res = await fetch(`/api/leagues/${LEAGUE_ID}/rounds/${roundId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-commissioner-token': COMMISSIONER_TOKEN },
        body: JSON.stringify({ status: sel.value })
      });
      if (res.ok) { await load(); } else toast('Failed to update status', 'error');
    });
  });
}

// ── My Team ────────────────────────────────────────────────────────────────────

async function renderMyTeam() {
  const el = document.getElementById('team-detail');
  const selectorEl = document.getElementById('team-selector');

  selectorEl.innerHTML = state.standings.map(t => `
    <button class="btn btn-sm ${t.team_id === selectedTeamId ? 'btn-primary' : ''}" data-tid="${t.team_id}">
      ${escHtml(t.team_name)}
    </button>
  `).join('');

  selectorEl.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => { selectedTeamId = b.dataset.tid; renderMyTeam(); });
  });

  if (!selectedTeamId) { el.innerHTML = ''; return; }

  el.innerHTML = '<div style="color:var(--text-muted);padding:16px;text-align:center">Loading…</div>';

  const res = await fetch(`/api/leagues/${LEAGUE_ID}/team/${selectedTeamId}`);
  if (!res.ok) { el.innerHTML = '<div style="color:var(--danger)">Failed to load team</div>'; return; }
  const data = await res.json();

  const completedRounds = data.rounds.filter(r => r.status === 'completed');

  el.innerHTML = `
    <div style="margin-bottom:16px">
      <h3>${escHtml(data.team.name)} <span style="color:var(--text-muted);font-weight:400;font-size:14px">— ${data.players.reduce((s,p)=>s+p.total_points,0)} total pts</span></h3>
    </div>
    <div style="overflow-x:auto">
      <table class="league-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Pos</th>
            <th class="pts-col">Total</th>
            ${completedRounds.map(r => `<th class="pts-col">${escHtml(r.name)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${data.players.map(p => {
            const roundCells = completedRounds.map(r => {
              const entry = p.round_stats.find(e => e.round_id === r.id);
              const pts = entry ? entry.points : '—';
              const breakdown = entry?.points_breakdown;
              const tip = breakdown ? Object.entries(breakdown).map(([k,v])=>`${k}: ${v}`).join(', ') : '';
              return `<td class="pts-col" title="${escHtml(tip)}">${pts}</td>`;
            }).join('');
            return `
              <tr>
                <td><strong>${escHtml(p.name)}</strong>${p.team_affiliation ? `<br><small style="color:var(--text-muted)">${escHtml(p.team_affiliation)}</small>` : ''}</td>
                <td style="color:var(--text-muted)">${escHtml(p.position || '—')}</td>
                <td class="pts-col total-pts">${p.total_points}</td>
                ${roundCells}
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Add Round ──────────────────────────────────────────────────────────────────

document.getElementById('add-round-btn').addEventListener('click', () => {
  document.getElementById('round-name-input').value = `Week ${(state.rounds.length + 1)}`;
  document.getElementById('round-modal').style.display = 'flex';
  document.getElementById('round-name-input').focus();
});

document.getElementById('round-cancel-btn').addEventListener('click', () => {
  document.getElementById('round-modal').style.display = 'none';
});

document.getElementById('round-confirm-btn').addEventListener('click', async () => {
  const name = document.getElementById('round-name-input').value.trim();
  if (!name) { toast('Round name required', 'error'); return; }

  const res = await fetch(`/api/leagues/${LEAGUE_ID}/rounds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-commissioner-token': COMMISSIONER_TOKEN },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error, 'error'); return; }

  document.getElementById('round-modal').style.display = 'none';
  toast('Round created', 'success');
  await load();
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'rounds'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-rounds'));
});

// ── Scoring Rules link ─────────────────────────────────────────────────────────

document.getElementById('settings-btn').addEventListener('click', () => {
  location.href = `/league-setup.html?draft_id=${state.draft_id}&edit=${LEAGUE_ID}`;
});

load();
