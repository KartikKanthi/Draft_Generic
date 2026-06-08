import { initAuth } from './auth.js';
initAuth('auth-container');

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Draft IDs this browser has commissioner tokens for (localStorage fallback)
function getLocalCommissionerIds() {
  const ids = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('commissioner_')) ids.push(key.replace('commissioner_', ''));
  }
  return ids;
}

const formatLabel = { snake: 'Snake', linear: 'Linear', auction: 'Auction' };
const statusColor = { waiting: 'var(--text-muted)', active: 'var(--success)', completed: 'var(--text-muted)' };

function modeBadgeLabel(draft) {
  if (draft.is_slow_draft) return 'Slow';
  return draft.mode === 'live' ? 'Live' : 'Async';
}

function modeBadgeClass(draft) {
  if (draft.is_slow_draft) return 'badge-slow';
  return `badge-${draft.mode}`;
}

function draftCard(draft, { role, teamToken, teamName, commToken } = {}) {
  const drafted = draft.players.filter(p => p.drafted_by).length;
  const total = draft.players.length;
  const enterUrl = teamToken
    ? `/draft.html?id=${escHtml(draft.id)}&token=${escHtml(teamToken)}`
    : `/draft.html?id=${escHtml(draft.id)}`;

  const roleBadge = role === 'commissioner'
    ? `<span class="badge badge-warning" style="font-size:10px">Commissioner</span>`
    : teamName
      ? `<span class="badge badge-blue" style="font-size:10px">Team: ${escHtml(teamName)}</span>`
      : '';

  const deleteBtn = role === 'commissioner' && commToken
    ? `<button class="btn btn-danger btn-sm" data-id="${escHtml(draft.id)}" data-token="${escHtml(commToken)}">Delete</button>`
    : '';

  return `
    <div class="panel" style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <span style="font-size:16px;font-weight:700">${escHtml(draft.name)}</span>
          <span class="badge badge-${draft.format}">${formatLabel[draft.format] || draft.format}</span>
          <span class="badge ${modeBadgeClass(draft)}">${modeBadgeLabel(draft)}</span>
          <span class="badge badge-${draft.status}" style="color:${statusColor[draft.status]}">${draft.status}</span>
          ${roleBadge}
        </div>
        <div style="font-size:12px;color:var(--text-muted);display:flex;gap:16px;flex-wrap:wrap">
          <span>👥 ${draft.teams.length} / ${draft.num_teams} teams</span>
          ${total > 0 ? `<span>🎯 ${drafted} / ${total} players drafted</span>` : '<span>No players loaded</span>'}
          <span>📅 ${new Date(draft.created_at).toLocaleDateString()}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <a href="${enterUrl}" class="btn btn-primary btn-sm">Enter Draft</a>
        ${deleteBtn}
      </div>
    </div>`;
}

async function loadLeagues() {
  const container = document.getElementById('leagues-list');
  container.innerHTML = `<div style="color:var(--text-muted);margin-bottom:16px">Loading your drafts…</div>`;

  // Fetch server-side drafts (requires login) and local commissioner tokens in parallel
  const [serverData, localIds] = await Promise.all([
    fetch('/api/my-drafts').then(r => r.ok ? r.json() : { commissioner_drafts: [], team_drafts: [] }).catch(() => ({ commissioner_drafts: [], team_drafts: [] })),
    Promise.resolve(getLocalCommissionerIds())
  ]);

  // IDs already covered by server response
  const serverCommIds = new Set(serverData.commissioner_drafts.map(d => d.id));

  // Fetch any local commissioner drafts not covered by the server (not logged in, or joined before linking)
  const extraLocalIds = localIds.filter(id => !serverCommIds.has(id));
  const extraResults = await Promise.all(extraLocalIds.map(async id => {
    try {
      const res = await fetch(`/api/drafts/${id}`);
      if (res.status === 404) { localStorage.removeItem(`commissioner_${id}`); return null; }
      const data = await res.json();
      return { ...data, _localCommToken: localStorage.getItem(`commissioner_${id}`) };
    } catch { return null; }
  }));
  const extraDrafts = extraResults.filter(Boolean);

  // Build final lists
  const commDrafts = [
    ...serverData.commissioner_drafts.map(d => ({ draft: d, role: 'commissioner', commToken: localStorage.getItem(`commissioner_${d.id}`) })),
    ...extraDrafts.map(d => ({ draft: d, role: 'commissioner', commToken: d._localCommToken }))
  ].sort((a, b) => b.draft.created_at.localeCompare(a.draft.created_at));

  const teamDrafts = serverData.team_drafts
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(d => ({ draft: d, role: 'team', teamToken: d.my_team_token, teamName: d.my_team_name }));

  if (commDrafts.length === 0 && teamDrafts.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:60px 0;color:var(--text-muted)">
        <p style="font-size:18px;margin-bottom:12px">No drafts yet</p>
        <a href="/" class="btn btn-primary">Create your first draft</a>
      </div>`;
    return;
  }

  let html = '';

  if (commDrafts.length > 0) {
    html += `<h3 style="margin-bottom:12px;color:var(--text-muted);font-size:13px;text-transform:uppercase;letter-spacing:0.5px">Your Drafts (Commissioner)</h3>`;
    html += commDrafts.map(({ draft, role, commToken }) => draftCard(draft, { role, commToken })).join('');
  }

  if (teamDrafts.length > 0) {
    if (commDrafts.length > 0) html += `<div style="margin:24px 0 12px;border-top:1px solid var(--border)"></div>`;
    html += `<h3 style="margin-bottom:12px;color:var(--text-muted);font-size:13px;text-transform:uppercase;letter-spacing:0.5px">Drafts You're In</h3>`;
    html += teamDrafts.map(({ draft, teamToken, teamName }) => draftCard(draft, { role: 'team', teamToken, teamName })).join('');
  }

  container.innerHTML = html;

  // Delete handlers
  container.querySelectorAll('button[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Permanently delete this draft? This cannot be undone.')) return;
      const id = btn.dataset.id;
      const token = btn.dataset.token;
      try {
        const res = await fetch(`/api/drafts/${id}`, {
          method: 'DELETE',
          headers: { 'x-commissioner-token': token }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        localStorage.removeItem(`commissioner_${id}`);
        toast('Draft deleted', 'success');
        loadLeagues();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

loadLeagues();
