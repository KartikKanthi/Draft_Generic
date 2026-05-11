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

// Gather all draft IDs this browser created
function getMyDraftIds() {
  const ids = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('commissioner_')) {
      ids.push(key.replace('commissioner_', ''));
    }
  }
  return ids;
}

async function loadLeagues() {
  const container = document.getElementById('leagues-list');
  const ids = getMyDraftIds();

  if (ids.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:60px 0;color:var(--text-muted)">
        <p style="font-size:18px;margin-bottom:12px">No leagues yet</p>
        <a href="/" class="btn btn-primary">Create your first draft</a>
      </div>`;
    return;
  }

  container.innerHTML = `<div style="color:var(--text-muted);margin-bottom:16px">Loading your leagues…</div>`;

  const results = await Promise.all(ids.map(async id => {
    try {
      const res = await fetch(`/api/drafts/${id}`);
      if (res.status === 404) {
        // Draft was deleted — clean up localStorage
        localStorage.removeItem(`commissioner_${id}`);
        return null;
      }
      const data = await res.json();
      return { ...data, commissionerToken: localStorage.getItem(`commissioner_${id}`) };
    } catch {
      return null;
    }
  }));

  const drafts = results.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (drafts.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:60px 0;color:var(--text-muted)">
        <p style="font-size:18px;margin-bottom:12px">No leagues found</p>
        <a href="/" class="btn btn-primary">Create your first draft</a>
      </div>`;
    return;
  }

  const formatLabel = { snake: 'Snake', linear: 'Linear', auction: 'Auction' };
  const statusColor = { waiting: 'var(--text-muted)', active: 'var(--success)', completed: 'var(--text-muted)' };

  container.innerHTML = drafts.map(draft => {
    const drafted = draft.players.filter(p => p.drafted_by).length;
    const total = draft.players.length;

    return `
    <div class="panel" style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <span style="font-size:16px;font-weight:700">${escHtml(draft.name)}</span>
          <span class="badge badge-${draft.format}">${formatLabel[draft.format]}</span>
          <span class="badge badge-${draft.mode}">${draft.mode === 'live' ? 'Live' : 'Async'}</span>
          <span class="badge badge-${draft.status}" style="color:${statusColor[draft.status]}">${draft.status}</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);display:flex;gap:16px;flex-wrap:wrap">
          <span>👥 ${draft.teams.length} / ${draft.num_teams} teams</span>
          ${total > 0 ? `<span>🎯 ${drafted} / ${total} players drafted</span>` : '<span>No players loaded</span>'}
          <span>📅 ${new Date(draft.created_at).toLocaleDateString()}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <a href="/draft.html?id=${escHtml(draft.id)}" class="btn btn-primary btn-sm">Enter Draft</a>
        <button class="btn btn-danger btn-sm" data-id="${escHtml(draft.id)}" data-token="${escHtml(draft.commissionerToken)}">Delete</button>
      </div>
    </div>`;
  }).join('');

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
