const params = new URLSearchParams(location.search);
const LEAGUE_ID = params.get('league');
const ROUND_ID = params.get('round');
if (!LEAGUE_ID || !ROUND_ID) location.href = '/';

let state = null;
let COMMISSIONER_TOKEN = null;
let statFields = [];
let editingPlayerId = null;
let currentStats = {};
let filterTeam = '';
let searchStr = '';

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
  });
});

// ── Load ───────────────────────────────────────────────────────────────────────

async function load() {
  const res = await fetch(`/api/leagues/${LEAGUE_ID}/rounds/${ROUND_ID}`);
  if (!res.ok) { document.getElementById('round-name').textContent = 'Round not found'; return; }
  state = await res.json();

  COMMISSIONER_TOKEN = localStorage.getItem(`commissioner_${state.league.draft_id}`);

  const back = document.getElementById('back-link');
  back.href = `/league.html?id=${LEAGUE_ID}`;

  document.getElementById('round-name').textContent = state.round.name;
  document.title = state.round.name;

  const statusCls = { upcoming:'badge-muted', active:'badge-warning', completed:'badge-success' }[state.round.status] || 'badge-muted';
  const badge = document.getElementById('round-status-badge');
  badge.textContent = state.round.status;
  badge.className = `badge ${statusCls}`;

  const entered = state.player_stats.filter(p => p.points !== null).length;
  document.getElementById('round-pts-summary').textContent = `${entered} / ${state.player_stats.length} players entered`;

  statFields = state.league.scoring_rules?.stats || [];

  if (COMMISSIONER_TOKEN) {
    document.getElementById('commissioner-bar').style.display = '';
    const teamSet = [...new Set(state.player_stats.map(p => p.fantasy_team_name).filter(Boolean))].sort();
    const sel = document.getElementById('team-filter-select');
    sel.innerHTML = '<option value="">All Teams</option>' + teamSet.map(t => `<option value="${t}">${escHtml(t)}</option>`).join('');
    sel.addEventListener('change', () => { filterTeam = sel.value; renderPlayerStats(); });
    document.getElementById('player-search').addEventListener('input', e => { searchStr = e.target.value.toLowerCase(); renderPlayerStats(); });
  }

  renderPlayerStats();
  renderTeamBreakdown();
}

// ── Player Stats ───────────────────────────────────────────────────────────────

function renderPlayerStats() {
  const el = document.getElementById('stats-container');
  let players = state.player_stats;

  if (filterTeam) players = players.filter(p => p.fantasy_team_name === filterTeam);
  if (searchStr) players = players.filter(p => p.player_name.toLowerCase().includes(searchStr));

  if (!players.length) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:24px;text-align:center">No players found</div>';
    return;
  }

  el.innerHTML = `
    <div style="overflow-x:auto">
      <table class="league-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Fantasy Team</th>
            <th class="pts-col">Points</th>
            <th style="color:var(--text-muted);font-size:12px">Breakdown</th>
            ${COMMISSIONER_TOKEN ? '<th></th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${players.map((p, i) => {
            const hasStats = p.points !== null;
            const breakdown = p.points_breakdown ? Object.entries(p.points_breakdown).map(([k,v])=>`${k}: ${v}`).join(' · ') : '';
            const starterBadge = p.is_starter === true
              ? '<span class="badge badge-success" style="font-size:10px;margin-left:6px">▲ S</span>'
              : p.is_starter === false
              ? '<span class="badge badge-muted" style="font-size:10px;margin-left:6px">▼ B</span>'
              : '';
            const isBench = p.is_starter === false;
            return `
              <tr style="${isBench ? 'opacity:0.55' : ''}">
                <td style="color:var(--text-muted)">${hasStats && !isBench ? i+1 : '—'}</td>
                <td>
                  <strong>${escHtml(p.player_name)}</strong>
                  ${p.position ? `<span style="color:var(--text-muted);margin-left:6px;font-size:12px">${escHtml(p.position)}</span>` : ''}
                  ${starterBadge}
                  ${p.real_team ? `<br><small style="color:var(--text-muted)">${escHtml(p.real_team)}</small>` : ''}
                </td>
                <td style="color:var(--text-muted)">${escHtml(p.fantasy_team_name || '—')}</td>
                <td class="pts-col ${hasStats && !isBench ? 'total-pts' : ''}">${hasStats ? p.points : '<span style="color:var(--text-dim)">—</span>'}</td>
                <td style="color:var(--text-muted);font-size:12px;max-width:260px">${escHtml(breakdown)}</td>
                ${COMMISSIONER_TOKEN ? `<td><button class="btn btn-sm" onclick="openStatEntry('${p.player_id}')">${hasStats ? 'Edit' : 'Enter'}</button></td>` : ''}
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Team Breakdown ─────────────────────────────────────────────────────────────

function renderTeamBreakdown() {
  const el = document.getElementById('teams-container');
  const { team_breakdown } = state;

  if (!team_breakdown.length) { el.innerHTML = '<div style="color:var(--text-muted);padding:24px;text-align:center">No data yet</div>'; return; }

  el.innerHTML = team_breakdown.map((team, rank) => `
    <div class="round-card" style="flex-direction:column;align-items:stretch;gap:0;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="rank-cell">${rank+1}</span>
          <strong>${escHtml(team.team_name)}</strong>
          ${team.lineup_submitted
            ? '<span class="badge badge-success" style="font-size:10px">Lineup set</span>'
            : '<span class="badge badge-muted" style="font-size:10px">No lineup — all count</span>'}
        </div>
        <span class="total-pts" style="font-size:18px">${team.round_points} pts</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${team.players.map(p => {
          const isBench = p.is_starter === false;
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-top:1px solid var(--border);${isBench ? 'opacity:0.5' : ''}">
              <span style="font-size:13px">
                ${p.is_starter === true ? '▲ ' : p.is_starter === false ? '▼ ' : ''}
                ${escHtml(p.player_name)} ${p.position ? `<span style="color:var(--text-muted)">(${escHtml(p.position)})</span>` : ''}
              </span>
              <span style="font-size:13px;${p.points !== null && !isBench ? 'color:var(--primary)' : 'color:var(--text-dim)'}">${p.points ?? '—'}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');
}

// ── Stat Entry Modal ───────────────────────────────────────────────────────────

window.openStatEntry = (playerId) => {
  const player = state.player_stats.find(p => p.player_id === playerId);
  if (!player) return;
  editingPlayerId = playerId;
  currentStats = player.stats ? { ...player.stats } : {};

  document.getElementById('stat-entry-title').textContent = `Stats: ${player.player_name}`;

  if (!statFields.length) {
    document.getElementById('stat-entry-fields').innerHTML =
      '<div style="color:var(--text-muted)">No stats defined. Configure scoring rules in the league settings.</div>';
    document.getElementById('stat-entry-preview').style.display = 'none';
  } else {
    document.getElementById('stat-entry-fields').innerHTML = statFields.map(s => `
      <div class="form-group" style="margin:0">
        <label style="margin-bottom:4px;font-size:13px">${escHtml(s.label)}</label>
        <input type="number" step="0.1" min="0" data-stat-key="${s.key}"
          value="${currentStats[s.key] ?? ''}" placeholder="0">
      </div>
    `).join('');
    document.getElementById('stat-entry-preview').style.display = '';

    document.getElementById('stat-entry-fields').querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        currentStats[inp.dataset.statKey] = inp.value === '' ? undefined : parseFloat(inp.value);
        previewPoints();
      });
    });
    previewPoints();
  }

  document.getElementById('stat-entry-modal').style.display = 'flex';
};

async function previewPoints() {
  const cleanStats = Object.fromEntries(Object.entries(currentStats).filter(([,v]) => v !== undefined && v !== ''));
  try {
    const res = await fetch(`/api/leagues/${LEAGUE_ID}/rounds/${ROUND_ID}/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-commissioner-token': COMMISSIONER_TOKEN },
      body: JSON.stringify({ player_id: editingPlayerId, stats: cleanStats, preview_only: true })
    });
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('preview-pts').textContent = data.points;
    const bd = Object.entries(data.breakdown || {}).map(([k,v]) => `${k}: ${v}`).join(' · ');
    document.getElementById('preview-breakdown').textContent = bd;
  } catch {}
}

document.getElementById('stat-cancel-btn').addEventListener('click', () => {
  document.getElementById('stat-entry-modal').style.display = 'none';
  editingPlayerId = null;
});

document.getElementById('stat-save-btn').addEventListener('click', async () => {
  const cleanStats = Object.fromEntries(
    Object.entries(currentStats).filter(([,v]) => v !== undefined && v !== '' && !isNaN(v))
  );

  const res = await fetch(`/api/leagues/${LEAGUE_ID}/rounds/${ROUND_ID}/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-commissioner-token': COMMISSIONER_TOKEN },
    body: JSON.stringify({ player_id: editingPlayerId, stats: cleanStats })
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error, 'error'); return; }

  toast(`Saved — ${data.points} pts`, 'success');
  document.getElementById('stat-entry-modal').style.display = 'none';
  editingPlayerId = null;
  await load();
});

load();
