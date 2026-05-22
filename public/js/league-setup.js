const params = new URLSearchParams(location.search);
const DRAFT_ID = params.get('draft_id');
const EDIT_LEAGUE_ID = params.get('edit'); // present when editing existing league
if (!DRAFT_ID) location.href = '/';

const COMMISSIONER_TOKEN = localStorage.getItem(`commissioner_${DRAFT_ID}`);
if (!COMMISSIONER_TOKEN) { alert('Commissioner access required.'); location.href = '/'; }

let PRESETS = {};
let scoringRules = { stats: [], rules: [] };
let editingRuleId = null;

// ── Toast ──────────────────────────────────────────────────────────────────────

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  const fetches = [fetch(`/api/drafts/${DRAFT_ID}`), fetch('/api/scoring-presets')];
  if (EDIT_LEAGUE_ID) fetches.push(fetch(`/api/leagues/${EDIT_LEAGUE_ID}`));

  const [draftRes, presetsRes, leagueRes] = await Promise.all(fetches);

  if (!draftRes.ok) { toast('Draft not found', 'error'); return; }
  const draft = await draftRes.json();
  PRESETS = await presetsRes.json();

  if (draft.status !== 'completed') {
    document.getElementById('loading-msg').textContent = 'Draft must be completed before creating a league.';
    return;
  }

  document.getElementById('league-name').value = `${draft.name} — League`;
  document.getElementById('draft-summary').innerHTML =
    `<strong>${draft.name}</strong> &nbsp;·&nbsp; ${draft.teams.length} teams &nbsp;·&nbsp; ${draft.players.filter(p => p.drafted_by).length} players drafted`;

  if (EDIT_LEAGUE_ID && leagueRes?.ok) {
    const league = await leagueRes.json();
    document.getElementById('league-name').value = league.name;
    document.getElementById('league-sport').value = league.sport || '';
    document.querySelector('h1.app-title').textContent = 'Edit Scoring Rules';
    document.getElementById('create-league-btn').textContent = 'Save Changes →';
    scoringRules = league.scoring_rules || { stats: [], rules: [] };
    renderStats();
    renderRules();
  } else {
    applyPreset('cricket');
  }

  document.getElementById('loading-msg').style.display = 'none';
  document.getElementById('setup-form').style.display = '';
}

// ── Preset ─────────────────────────────────────────────────────────────────────

function applyPreset(name) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('btn-primary', b.dataset.preset === name));
  if (name === 'custom') {
    scoringRules = { stats: [], rules: [] };
  } else {
    scoringRules = JSON.parse(JSON.stringify(PRESETS[name] || { stats: [], rules: [] }));
  }
  renderStats();
  renderRules();
}

document.querySelectorAll('.preset-btn').forEach(b => {
  b.addEventListener('click', () => applyPreset(b.dataset.preset));
});

// ── Stats ──────────────────────────────────────────────────────────────────────

function renderStats() {
  const el = document.getElementById('stats-list');
  if (!scoringRules.stats.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No stats defined yet</div>';
    return;
  }
  el.innerHTML = scoringRules.stats.map((s, i) => `
    <div class="rule-row">
      <span class="rule-key">${s.key}</span>
      <span style="color:var(--text-muted)">${s.label}</span>
      <button class="btn btn-sm btn-danger" data-stat-idx="${i}" onclick="removeStat(${i})">×</button>
    </div>
  `).join('');
}

window.removeStat = (i) => {
  const key = scoringRules.stats[i].key;
  scoringRules.stats.splice(i, 1);
  scoringRules.rules = scoringRules.rules.filter(r => r.stat !== key && r.numerator !== key && r.denominator !== key);
  renderStats();
  renderRules();
};

document.getElementById('add-stat-btn').addEventListener('click', () => {
  document.getElementById('stat-key-input').value = '';
  document.getElementById('stat-label-input').value = '';
  document.getElementById('stat-modal').style.display = 'flex';
  document.getElementById('stat-key-input').focus();
});

document.getElementById('stat-cancel-btn').addEventListener('click', () => {
  document.getElementById('stat-modal').style.display = 'none';
});

document.getElementById('stat-confirm-btn').addEventListener('click', () => {
  const key = document.getElementById('stat-key-input').value.trim().replace(/\s+/g, '_');
  const label = document.getElementById('stat-label-input').value.trim();
  if (!key || !label) { toast('Key and label required', 'error'); return; }
  if (scoringRules.stats.find(s => s.key === key)) { toast('Stat key already exists', 'error'); return; }
  scoringRules.stats.push({ key, label });
  document.getElementById('stat-modal').style.display = 'none';
  renderStats();
});

// ── Rules ──────────────────────────────────────────────────────────────────────

function ruleTypeLabel(type) {
  return { per_unit: 'per unit', flat: 'flat ≥', flat_exact: 'flat =', banded_computed: 'banded', multiplier: 'multiplier' }[type] || type;
}

function ruleDescription(rule) {
  if (rule.type === 'per_unit') return `${rule.points} pts × [${rule.stat}]`;
  if (rule.type === 'flat') return `${rule.points} pts if [${rule.stat}] ≥ ${rule.min}`;
  if (rule.type === 'flat_exact') return `${rule.points} pts if [${rule.stat}] = ${rule.value}`;
  if (rule.type === 'banded_computed') return `Bands on ${rule.numerator}/${rule.denominator}×${rule.scale ?? 1}`;
  if (rule.type === 'multiplier') {
    const target = scoringRules.rules.find(r => r.id === rule.target_rule);
    return `×${rule.multiplier} "${target?.label || rule.target_rule}" if [${rule.stat}] ≥ ${rule.min}`;
  }
  return '';
}

function renderRules() {
  const el = document.getElementById('rules-list');
  if (!scoringRules.rules.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No rules defined yet</div>';
    return;
  }
  el.innerHTML = scoringRules.rules.map((r, i) => `
    <div class="rule-row">
      <span class="rule-key" style="font-size:11px;background:var(--surface3)">${ruleTypeLabel(r.type)}</span>
      <span style="flex:1"><strong>${r.label}</strong> <span style="color:var(--text-muted);font-size:12px">— ${ruleDescription(r)}</span></span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-sm" onclick="editRule(${i})">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="removeRule(${i})">×</button>
      </div>
    </div>
  `).join('');
}

window.removeRule = (i) => { scoringRules.rules.splice(i, 1); renderRules(); };

window.editRule = (i) => {
  editingRuleId = i;
  const rule = scoringRules.rules[i];
  openRuleModal(rule);
};

// ── Rule Modal ─────────────────────────────────────────────────────────────────

function populateStatSelects() {
  const opts = scoringRules.stats.map(s => `<option value="${s.key}">${s.label} (${s.key})</option>`).join('');
  document.getElementById('rule-stat-select').innerHTML = opts;
  document.getElementById('rule-numerator-select').innerHTML = opts;
  document.getElementById('rule-denominator-select').innerHTML = opts;

  const ruleOpts = scoringRules.rules.map(r => `<option value="${r.id}">${r.label}</option>`).join('');
  document.getElementById('rule-target-select').innerHTML = ruleOpts || '<option value="">— no rules yet —</option>';
}

function openRuleModal(existing = null) {
  document.getElementById('rule-modal-title').textContent = existing ? 'Edit Rule' : 'Add Rule';
  populateStatSelects();

  document.getElementById('rule-label-input').value = existing?.label || '';
  document.getElementById('rule-type-select').value = existing?.type || 'per_unit';
  document.getElementById('rule-stat-select').value = existing?.stat || scoringRules.stats[0]?.key || '';
  document.getElementById('rule-points-input').value = existing?.points ?? '';
  document.getElementById('rule-min-input').value = existing?.min ?? '';
  document.getElementById('rule-value-input').value = existing?.value ?? '';
  document.getElementById('rule-multiplier-input').value = existing?.multiplier ?? '';
  document.getElementById('rule-mult-min-input').value = existing?.min ?? '';
  document.getElementById('rule-target-select').value = existing?.target_rule || '';
  document.getElementById('rule-scale-input').value = existing?.scale ?? 100;
  document.getElementById('rule-min-denom-input').value = existing?.min_denominator ?? 10;
  document.getElementById('rule-numerator-select').value = existing?.numerator || '';
  document.getElementById('rule-denominator-select').value = existing?.denominator || '';

  renderBands(existing?.bands || []);
  updateRuleFormVisibility();
  document.getElementById('rule-modal').style.display = 'flex';
}

function renderBands(bands) {
  document.getElementById('bands-list').innerHTML = bands.map((b, i) => `
    <div class="rule-row" style="gap:6px;align-items:center">
      <input type="number" placeholder="Min" value="${b.min ?? ''}" step="0.01" style="width:80px" onchange="updateBand(${i},'min',this.value)">
      <span style="color:var(--text-muted)">–</span>
      <input type="number" placeholder="Max" value="${b.max ?? ''}" step="0.01" style="width:80px" onchange="updateBand(${i},'max',this.value)">
      <span style="color:var(--text-muted)">→</span>
      <input type="number" placeholder="Pts" value="${b.points}" step="0.1" style="width:70px" onchange="updateBand(${i},'points',this.value)">
      <button class="btn btn-sm btn-danger" onclick="removeBand(${i})">×</button>
    </div>
  `).join('');
}

let currentBands = [];
window.updateBand = (i, field, val) => {
  if (!currentBands[i]) return;
  if (val === '' || val === null) delete currentBands[i][field];
  else currentBands[i][field] = parseFloat(val);
};
window.removeBand = (i) => { currentBands.splice(i, 1); renderBands(currentBands); };
document.getElementById('add-band-btn').addEventListener('click', () => {
  currentBands.push({ points: 0 });
  renderBands(currentBands);
});

function updateRuleFormVisibility() {
  const type = document.getElementById('rule-type-select').value;
  document.getElementById('rule-stat-row').style.display = ['per_unit','flat','flat_exact','multiplier'].includes(type) ? '' : 'none';
  document.getElementById('rule-points-row').style.display = ['per_unit','flat','flat_exact'].includes(type) ? '' : 'none';
  document.getElementById('rule-min-row').style.display = type === 'flat' ? '' : 'none';
  document.getElementById('rule-value-row').style.display = type === 'flat_exact' ? '' : 'none';
  document.getElementById('rule-banded-section').style.display = type === 'banded_computed' ? '' : 'none';
  document.getElementById('rule-multiplier-section').style.display = type === 'multiplier' ? '' : 'none';

  const ptLabel = { per_unit: 'Points per unit', flat: 'Points awarded', flat_exact: 'Points awarded' };
  document.getElementById('rule-points-label').textContent = ptLabel[type] || 'Points';
}

document.getElementById('rule-type-select').addEventListener('change', updateRuleFormVisibility);

document.getElementById('add-rule-btn').addEventListener('click', () => {
  editingRuleId = null;
  currentBands = [];
  openRuleModal(null);
});

document.getElementById('rule-cancel-btn').addEventListener('click', () => {
  document.getElementById('rule-modal').style.display = 'none';
  editingRuleId = null;
});

document.getElementById('rule-confirm-btn').addEventListener('click', () => {
  const type = document.getElementById('rule-type-select').value;
  const label = document.getElementById('rule-label-input').value.trim();
  if (!label) { toast('Label required', 'error'); return; }

  const id = editingRuleId !== null ? scoringRules.rules[editingRuleId].id : `r_${Date.now()}`;
  let rule = { id, label, type };

  if (['per_unit','flat','flat_exact','multiplier'].includes(type)) {
    rule.stat = document.getElementById('rule-stat-select').value;
  }
  if (['per_unit','flat','flat_exact'].includes(type)) {
    rule.points = parseFloat(document.getElementById('rule-points-input').value) || 0;
  }
  if (type === 'flat') {
    rule.min = parseFloat(document.getElementById('rule-min-input').value) || 1;
  }
  if (type === 'flat_exact') {
    rule.value = parseFloat(document.getElementById('rule-value-input').value) || 0;
  }
  if (type === 'banded_computed') {
    rule.numerator = document.getElementById('rule-numerator-select').value;
    rule.denominator = document.getElementById('rule-denominator-select').value;
    rule.scale = parseFloat(document.getElementById('rule-scale-input').value) || 1;
    rule.min_denominator = parseFloat(document.getElementById('rule-min-denom-input').value) || 0;
    rule.bands = currentBands.filter(b => b.points !== undefined);
  }
  if (type === 'multiplier') {
    rule.target_rule = document.getElementById('rule-target-select').value;
    rule.multiplier = parseFloat(document.getElementById('rule-multiplier-input').value) || 1;
    rule.min = parseFloat(document.getElementById('rule-mult-min-input').value) || 1;
  }

  if (editingRuleId !== null) {
    scoringRules.rules[editingRuleId] = rule;
  } else {
    scoringRules.rules.push(rule);
  }

  document.getElementById('rule-modal').style.display = 'none';
  editingRuleId = null;
  renderRules();
});

// ── Create League ─────────────────────────────────────────────────────────────

document.getElementById('create-league-btn').addEventListener('click', async () => {
  const name = document.getElementById('league-name').value.trim();
  const sport = document.getElementById('league-sport').value.trim();
  if (!name) { toast('League name required', 'error'); return; }

  const btn = document.getElementById('create-league-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    let leagueId;
    if (EDIT_LEAGUE_ID) {
      const res = await fetch(`/api/leagues/${EDIT_LEAGUE_ID}/scoring-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-commissioner-token': COMMISSIONER_TOKEN },
        body: JSON.stringify({ scoring_rules: scoringRules })
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      leagueId = EDIT_LEAGUE_ID;
    } else {
      const res = await fetch('/api/leagues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-commissioner-token': COMMISSIONER_TOKEN },
        body: JSON.stringify({ draft_id: DRAFT_ID, name, sport, scoring_rules: scoringRules })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      leagueId = data.league_id;
      localStorage.setItem(`league_${DRAFT_ID}`, leagueId);
    }
    location.href = `/league.html?id=${leagueId}`;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Create League →';
  }
});

init();
