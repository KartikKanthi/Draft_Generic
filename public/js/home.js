import { initAuth } from './auth.js';
initAuth('auth-container');

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Format → show/hide budget + timer label ───────────────────────────────────
const formatSelect = document.getElementById('format-select');
const modeSelect = document.getElementById('mode-select');
const budgetGroup = document.getElementById('budget-group');
const timerGroup = document.getElementById('timer-group');

formatSelect.addEventListener('change', () => {
  budgetGroup.style.display = formatSelect.value === 'auction' ? 'block' : 'none';
});

modeSelect.addEventListener('change', () => {
  const label = document.getElementById('timer-label');
  if (modeSelect.value === 'async') {
    label.textContent = 'Pick Deadline (hours, 0 = no limit)';
    document.querySelector('[name=pick_timer]').value = 24;
  } else {
    label.textContent = 'Pick Timer (seconds, 0 = no limit)';
    document.querySelector('[name=pick_timer]').value = 90;
  }
});

// ── Position Requirements ─────────────────────────────────────────────────────
document.getElementById('add-pos-req-btn').addEventListener('click', () => {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center';
  row.innerHTML = `
    <input type="text" placeholder="e.g. GK or CDM/MF" style="width:150px" class="pos-req-name">
    <input type="number" placeholder="Min" min="1" style="width:70px" class="pos-req-min">
    <button type="button" class="btn btn-sm btn-danger" style="padding:5px 8px">✕</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  document.getElementById('pos-reqs-list').appendChild(row);
});

function getPositionRequirements() {
  const reqs = [];
  document.querySelectorAll('#pos-reqs-list > div').forEach(row => {
    const posInput = row.querySelector('.pos-req-name').value.trim().toUpperCase();
    const min = parseInt(row.querySelector('.pos-req-min').value);
    if (!posInput || isNaN(min) || min < 1) return;
    // Split on comma, slash, or pipe to support grouped positions e.g. "CDM/MF"
    const positions = posInput.split(/[,\/|]/).map(p => p.trim()).filter(Boolean);
    if (positions.length > 0) reqs.push({ positions, min });
  });
  return reqs.length ? JSON.stringify(reqs) : null;
}

// ── CSV file preview ──────────────────────────────────────────────────────────
document.getElementById('csv-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  document.getElementById('file-name-display').textContent = f ? `✓ ${f.name}` : '';
});

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Create Draft ──────────────────────────────────────────────────────────────
document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const fd = new FormData(form);
  const posReqs = getPositionRequirements();
  if (posReqs) fd.append('position_requirements', posReqs);

  try {
    const res = await fetch('/api/drafts', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Save commissioner token
    localStorage.setItem(`commissioner_${data.draft_id}`, data.commissioner_token);
    if (data.player_count > 0) toast(`Loaded ${data.player_count} players`, 'success');

    window.location.href = `/draft.html?id=${data.draft_id}`;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Create Draft';
  }
});

// ── Join Draft ────────────────────────────────────────────────────────────────
document.getElementById('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Joining…';

  const draftId = form.draft_id.value.trim();
  const teamName = form.team_name.value.trim();

  try {
    const res = await fetch(`/api/drafts/${draftId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_name: teamName })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    localStorage.setItem(`team_${draftId}_id`, data.team_id);
    localStorage.setItem(`team_${draftId}_token`, data.token);

    window.location.href = `/draft.html?id=${draftId}&token=${data.token}`;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Join Draft';
  }
});

// Pre-fill draft ID from query param (if coming from a shared link)
const params = new URLSearchParams(location.search);
if (params.get('join')) {
  document.querySelector('[data-tab=join]').click();
  document.querySelector('[name=draft_id]').value = params.get('join');
}
