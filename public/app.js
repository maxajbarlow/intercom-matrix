'use strict';
// Live intercom-matrix viewer. Pulls a shared, cached RRCS snapshot from the
// server and renders three views: Matrix (panel × conference), Conferences
// (members of a conference), Panels (every conference a panel belongs to).

const els = {
  tabs: document.getElementById('tabs'),
  system: document.getElementById('systemSelect'),
  auto: document.getElementById('autoSelect'),
  refresh: document.getElementById('refreshBtn'),
  statusText: document.getElementById('statusText'),
  countText: document.getElementById('countText'),
  updatedText: document.getElementById('updatedText'),
  subtitle: document.getElementById('subtitle'),
  // matrix
  mxRowSearch: document.getElementById('mxRowSearch'),
  mxColSearch: document.getElementById('mxColSearch'),
  mxPanelsOnly: document.getElementById('mxPanelsOnly'),
  mxKeyAccess: document.getElementById('mxKeyAccess'),
  mxGrid: document.getElementById('mxGrid'),
  mxHint: document.getElementById('mxHint'),
  mxNode: document.getElementById('mxNode'),
  mxCard: document.getElementById('mxCard'),
  cfgFile: document.getElementById('cfgFile'),
  topoFile: document.getElementById('topoFile'),
  printFile: document.getElementById('printFile'),
  // conferences
  confSearch: document.getElementById('confSearch'),
  confSort: document.getElementById('confSort'),
  confList: document.getElementById('confList'),
  confDetail: document.getElementById('confDetail'),
  // panels
  panelSearch: document.getElementById('panelSearch'),
  panelList: document.getElementById('panelList'),
  panelDetail: document.getElementById('panelDetail'),
  pnNode: document.getElementById('pnNode'),
  pnCard: document.getElementById('pnCard'),
  // source els (srcDrop, srcPrint*) live inside the dynamically-rendered Systems
  // detail — re-cached by cacheSourceEls() after each render, not held here.
  // settings
  settingsWrap: document.getElementById('settingsWrap'),
  logoFile: document.getElementById('logoFile'),
};

const state = {
  data: null,            // /api/snapshot
  systems: [],           // /api/systems list
  system: null,          // active system id
  view: 'matrix',
  autoTimer: null,
  selConf: null,         // index into conferences+groups
  selPanel: null,        // panel addr
  rrcsEnabled: true,     // /api/systems → false disables live RRCS controls
  cmp: { from: null, to: null },  // print version diff selection (version ids)
  // --- change-request platform ---
  requests: [], reqStats: { byStatus: {}, total: 0 },
  selReq: null, reqCurrent: null, reqStatusFilter: 'active',
  pending: { changes: [], newConferences: [] }, pendingIdx: null, showPending: false,
  composer: null,        // { mode, changes:[], confName, confLabel }
  settings: null,        // /api/settings — shared deployment config
  setSection: 'systems', // active Settings sub-section
  auth: null,            // /api/auth/me — session/login state
  authGated: false,      // require-login wall active
  users: null,           // /api/users — local accounts (admin only)
  authConfig: null,      // /api/auth-config — redacted LDAP/SAML config (admin)
  authCfgEdit: null,     // 'ldap' | 'saml' when editing a connection
  sysSel: null,          // system selected in the Systems master/detail ('__new__' = add form)
};

const COL_W = 26, ROW_H = 22, ROWHEAD_W = 260, COLHEAD_H = 156, MAX_GRID = 1500;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cls = (t, l) => (t && l ? 'both' : t ? 'talk' : l ? 'listen' : '');
const sym = (t, l) => (t && l ? '⊗' : t ? '●' : l ? '○' : '');
function fmtDateTime(t) {
  if (!t) return '—';
  const fmt = (state.settings && state.settings.display && state.settings.display.dateFormat) || 'medium';
  const opts = fmt === 'short'
    ? { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : fmt === 'long'
      ? { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Date(t).toLocaleString(undefined, opts);
}
function relTime(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago');
}

// Strip a leading slash so requests are RELATIVE to the document base. This
// lets the app be served under a reverse-proxy sub-path (e.g. a Tailscale
// /<unique>/ mount) as well as at the root.
const rel = (p) => p.replace(/^\//, '');
async function api(path, opts) {
  const r = await fetch(rel(path), opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// Append the active system id to an API path (returned relative).
function url(p) { return rel(p) + (p.includes('?') ? '&' : '?') + 'system=' + encodeURIComponent(state.system || ''); }

// ---------- status ----------
function setStatus(s) {
  const ok = s && s.ok;
  const when = (t) => (t ? new Date(t).toLocaleTimeString() : '');
  if (ok && s.source === 'vsp') {
    els.statusText.innerHTML = `<span class="dotind" style="background:var(--both)"></span>Offline source: <b>Virtual system export</b>`;
  } else if (ok && s.source === 'print') {
    els.statusText.innerHTML = '';
  } else if (!state.rrcsEnabled && !ok) {
    els.statusText.innerHTML = `<span class="dotind" style="background:var(--text-dim)"></span>RRCS disabled — <b>load a config print</b> for this system (Settings → Sources)`;
  } else if (!state.rrcsEnabled) {
    els.statusText.innerHTML = `<span class="dotind" style="background:var(--both)"></span>Offline source: <b>config print</b>`;
  } else if (ok && s.stale) {
    els.statusText.innerHTML = `<span class="dotind" style="background:var(--listen)"></span>Showing cached data — last refresh failed${s.lastError ? ' (' + esc(s.lastError) + ')' : ''}`;
  } else if (ok) {
    els.statusText.innerHTML = `<span class="dotind" style="background:var(--ok)"></span>Connected to <b>${esc(s.host)}:${s.port}</b>`;
  } else {
    els.statusText.innerHTML = `<span class="dotind" style="background:var(--bad)"></span>${esc((s && (s.lastError || s.error)) || 'no data')}`;
  }
  if (ok && s.counts) {
    const k = s.counts.keyEdges ? ` · +${s.counts.keyEdges} via key` : '';
    els.countText.textContent = `${s.counts.panels} panels · ${s.counts.conferences} conferences · ${s.counts.memberEdges} memberships${k}`;
    els.updatedText.innerHTML = (s.stale ? `<span style="color:var(--listen)">cached from ${when(s.fetchedAt)}` + (s.lastErrorAt ? ` · retry failed ${when(s.lastErrorAt)}` : '') + '</span>' : 'updated ' + when(s.fetchedAt));
  } else { els.countText.textContent = ''; els.updatedText.textContent = ''; }
  populateTopoFilters();
}

// Source uploads/clears target the system SELECTED in the Systems detail (which
// is independent of the header-active one). After a change, refresh the
// per-system status (reloadSystems) and the active matrix if it's the same one.
function sysUrl(p) {
  const id = (state.sysSel && state.sysSel !== '__new__') ? state.sysSel : state.system;
  return rel(p) + (p.includes('?') ? '&' : '?') + 'system=' + encodeURIComponent(id || '');
}
async function afterSourceChange() {
  await reloadSystems();
  if (state.sysSel === state.system) await loadSnapshot();
  renderSettings();
}

async function uploadConfig(file) {
  try {
    const r = await fetch(sysUrl('/api/config-file?name=' + encodeURIComponent(file.name)), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.arrayBuffer() });
    const info = await r.json(); if (!r.ok) throw new Error(info.error || 'upload failed');
    await afterSourceChange(); setMsg('Key-access config loaded.', true);
  } catch (e) { setMsg('Config upload failed: ' + e.message, false); }
}
async function clearConfig() { try { await fetch(sysUrl('/api/config-file'), { method: 'DELETE' }); await afterSourceChange(); } catch (e) { setMsg(e.message, false); } }

async function uploadTopology(file) {
  try {
    const r = await fetch(sysUrl('/api/topology-file?name=' + encodeURIComponent(file.name)), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.arrayBuffer() });
    const info = await r.json(); if (!r.ok) throw new Error(info.error || 'upload failed');
    await afterSourceChange(); setMsg('Topology loaded.', true);
  } catch (e) { setMsg('Topology upload failed: ' + e.message, false); }
}
async function clearTopologyFile() { try { await fetch(sysUrl('/api/topology-file'), { method: 'DELETE' }); await afterSourceChange(); } catch (e) { setMsg(e.message, false); } }

async function uploadPrint(file) {
  if (els.srcPrintMsg) els.srcPrintMsg.innerHTML = `<span class="muted">Parsing ${esc(file.name)}…</span>`;
  try {
    const r = await fetch(sysUrl('/api/print-file?name=' + encodeURIComponent(file.name)), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.arrayBuffer() });
    const info = await r.json();
    if (!r.ok) throw new Error(info.error || 'parse failed');
    state.selConf = null; state.selPanel = null;
    // Build the result message now; set it AFTER afterSourceChange re-renders.
    let msg;
    if (info.version && info.version.unchanged) {
      msg = `<span class="muted">No changes — identical to v${info.version.id}.</span>`;
    } else {
      const d = info.diff;
      const delta = d ? ` · <span class="ok">${[d.confAdded ? '+' + d.confAdded + ' conf' : '', d.confRemoved ? '−' + d.confRemoved + ' conf' : '', d.membersAdded ? '+' + d.membersAdded + ' members' : '', d.membersRemoved ? '−' + d.membersRemoved + ' members' : '', d.dirChanged ? '~' + d.dirChanged + ' directions' : ''].filter(Boolean).join(', ') || 'no routing changes'}</span>` : ' <span class="muted">(first version)</span>';
      msg = `<span class="ok">Loaded ${esc(file.name)} as v${info.version ? info.version.id : '?'}</span> · ${info.conferences} conf · ${info.keyAssignments} keys${delta}`;
    }
    if (info.version && !info.version.unchanged) { state.cmp.to = info.version.id; state.cmp.from = null; }
    await afterSourceChange();
    if (els.srcPrintMsg) els.srcPrintMsg.innerHTML = msg;
  } catch (e) {
    if (els.srcPrintMsg) els.srcPrintMsg.innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  }
}
async function clearPrintFile() { try { await fetch(sysUrl('/api/print-file'), { method: 'DELETE' }); await afterSourceChange(); } catch (e) { setMsg(e.message, false); } }

// ---------- Sources (in the Systems detail) ----------
// The detail embeds the print version/diff UI (dynamic ids); re-cache them and
// re-bind drag-drop after each Settings render.
function cacheSourceEls() {
  for (const id of ['srcDrop', 'srcPrintMsg', 'srcPrintVersions', 'srcPrintDiff']) els[id] = document.getElementById(id);
}
function wireSourceDrop() {
  const dz = els.srcDrop; if (!dz) return;   // only present for editors
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'dragend'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('drag')));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) uploadPrint(f); });
}

// ----- version history + GitHub-style diff -----
function renderVersions(history) {
  if (!history.length) { els.srcPrintVersions.innerHTML = ''; els.srcPrintDiff.innerHTML = ''; return; }
  // default compare selection: latest (to) vs its predecessor (from)
  const ids = history.map((h) => h.id);
  if (!ids.includes(state.cmp.to)) state.cmp.to = ids[0];
  if (!ids.includes(state.cmp.from)) state.cmp.from = ids[1] != null ? ids[1] : ids[0];

  const rows = history.map((h, i) => `
    <li class="${h.id === state.cmp.to ? 'to' : ''} ${h.id === state.cmp.from ? 'from' : ''}">
      <span class="vid">v${h.id}</span>
      ${i === 0 ? '<span class="pill both tiny">current</span> ' : ''}
      <span class="nm">${esc(h.name)}</span>
      <span class="muted">${fmtDateTime(h.loadedAt)} · ${h.conferences} conf · ${h.keyAssignments} keys${h.truncated ? ' · ' + h.truncated + ' trunc' : ''}</span>
    </li>`).join('');

  const sel = (which) => `<select class="cmp-sel" data-which="${which}">` +
    history.map((h) => `<option value="${h.id}" ${state.cmp[which] === h.id ? 'selected' : ''}>v${h.id} · ${esc(h.name)}</option>`).join('') + '</select>';

  els.srcPrintVersions.innerHTML = `
    <h4>Versions <span class="muted">(${history.length})</span></h4>
    <ul class="src-hist versions">${rows}</ul>
    ${history.length > 1 ? `<div class="cmp-bar">Compare ${sel('from')} <span class="arrow">→</span> ${sel('to')}</div>` : '<p class="muted small">Upload a new version to compare changes.</p>'}`;

  els.srcPrintVersions.querySelectorAll('.cmp-sel').forEach((s) => s.addEventListener('change', () => {
    state.cmp[s.dataset.which] = Number(s.value);
    renderVersions(history); loadDiff();
  }));
  if (history.length > 1) loadDiff();
  else els.srcPrintDiff.innerHTML = '';
}

async function loadDiff() {
  const { from, to } = state.cmp;
  if (from == null || to == null) { els.srcPrintDiff.innerHTML = ''; return; }
  if (from === to) { els.srcPrintDiff.innerHTML = '<p class="muted small">Pick two different versions to see a diff.</p>'; return; }
  els.srcPrintDiff.innerHTML = '<p class="muted small">Comparing…</p>';
  try {
    const d = await api(sysUrl(`/api/print-diff?from=${from}&to=${to}`));
    renderDiff(d);
  } catch (e) { els.srcPrintDiff.innerHTML = `<p class="bad small">${esc(e.message)}</p>`; }
}

function dirText(x) { return x ? (x.t && x.l ? 'Talk+Listen' : x.t ? 'Talk' : x.l ? 'Listen' : '—') : '—'; }
function renderDiff(d) {
  const s = d.summary || {};
  const noChange = !d.conferences || !d.conferences.length;
  const chips = [
    s.confAdded ? `<span class="dsum add">+${s.confAdded} conf</span>` : '',
    s.confRemoved ? `<span class="dsum del">−${s.confRemoved} conf</span>` : '',
    s.membersAdded ? `<span class="dsum add">+${s.membersAdded} members</span>` : '',
    s.membersRemoved ? `<span class="dsum del">−${s.membersRemoved} members</span>` : '',
    s.dirChanged ? `<span class="dsum chg">~${s.dirChanged} directions</span>` : '',
  ].filter(Boolean).join(' ');
  const head = `<div class="diff-head">${d.from ? 'v' + d.from.id : '∅'} <span class="arrow">→</span> ${d.to ? 'v' + d.to.id : '∅'} ${chips || '<span class="dsum same">no changes</span>'}</div>`;
  if (noChange) { els.srcPrintDiff.innerHTML = head; return; }

  const blocks = d.conferences.map((c) => {
    const lines = c.members.map((m) => {
      if (m.status === 'added') return `<div class="dl add">+ ${esc(m.panel)} <span class="dim">[${dirText(m.to)}]</span></div>`;
      if (m.status === 'removed') return `<div class="dl del">− ${esc(m.panel)} <span class="dim">[${dirText(m.from)}]</span></div>`;
      return `<div class="dl chg">~ ${esc(m.panel)} <span class="dim">${dirText(m.from)} → ${dirText(m.to)}</span></div>`;
    }).join('');
    const tag = c.status === 'added' ? '<span class="dsum add">added</span>' : c.status === 'removed' ? '<span class="dsum del">removed</span>' : '<span class="dsum chg">changed</span>';
    return `<div class="diff-conf ${c.status}"><div class="diff-conf-h">${esc(c.name)} ${tag}</div>${lines}</div>`;
  }).join('');
  els.srcPrintDiff.innerHTML = head + blocks;
}

// Populate the node/card selects from the snapshot topology. Used by both views.
function populateTopoFilters() {
  const topo = state.data && state.data.topology;
  const have = topo && topo.loaded && topo.nodes && topo.nodes.length;
  for (const [nodeSel, cardSel] of [[els.mxNode, els.mxCard], [els.pnNode, els.pnCard]]) {
    nodeSel.hidden = !have; cardSel.hidden = !have;
    if (!have) continue;
    const prevNode = nodeSel.value, prevCard = cardSel.value;
    nodeSel.replaceChildren(opt('', 'All nodes'));
    for (const n of topo.nodes) nodeSel.appendChild(opt(n.id, n.name));
    nodeSel.value = topo.nodes.some((n) => n.id === prevNode) ? prevNode : '';
    fillCards(nodeSel, cardSel, prevCard);
  }
}
function opt(v, label) { const o = document.createElement('option'); o.value = v; o.textContent = label; return o; }
function fillCards(nodeSel, cardSel, keep) {
  const topo = state.data.topology;
  const node = topo.nodes.find((n) => n.id === nodeSel.value);
  cardSel.replaceChildren(opt('', 'All cards'));
  if (node) for (const c of node.cards) cardSel.appendChild(opt(c, c));
  cardSel.disabled = !node;
  cardSel.value = (node && node.cards.includes(keep)) ? keep : '';
}
// Does a matrix row / panel pass the node+card filter for a given pair of selects?
function topoPass(row, nodeSel, cardSel) {
  if (nodeSel.hidden) return true;
  if (nodeSel.value && String(row.nodeId) !== nodeSel.value) return false;
  if (cardSel.value && (row.bay + ' · ' + (row.card || '')) !== cardSel.value) return false;
  return true;
}

// ---------- load / refresh ----------
async function loadSnapshot() {
  const s = await api(url('/api/snapshot'));
  state.data = s;
  setStatus(s);
  await Promise.all([loadRequests().catch(() => {}), loadPending().catch(() => {})]);
  render();
}
async function refreshNow() {
  els.refresh.disabled = true;
  els.refresh.textContent = 'Refreshing…';
  try {
    await api('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: state.system }) });
    await loadSnapshot();
  } catch (e) {
    els.statusText.innerHTML = `<span class="dotind" style="background:var(--bad)"></span>Refresh failed: ${esc(e.message)}`;
  } finally {
    els.refresh.disabled = false;
    els.refresh.textContent = 'Refresh';
  }
}
// Download the current system as a 3-sheet .xlsx (Matrix / Conferences / Panels).
// Export the active system to a .xlsx. Triggered from Settings → Systems; `btn`
// is the clicked element (so we can show progress) — guarded since the Settings
// panel can re-render.
async function exportXlsx(btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await fetch(sysUrl('/api/export.xlsx'));
    if (!r.ok) { let msg = 'HTTP ' + r.status; try { msg = (await r.json()).error || msg; } catch {} throw new Error(msg); }
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || '';
    const m = /filename="?([^"]+)"?/.exec(cd);
    const name = m ? m[1] : 'intercom-matrix.xlsx';
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  } catch (e) {
    els.statusText.innerHTML = `<span class="dotind" style="background:var(--bad)"></span>Export failed: ${esc(e.message)}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
async function switchSystem(id) {
  state.system = id;
  state.selConf = null; state.selPanel = null; state.data = null;
  state.cmp = { from: null, to: null };
  els.statusText.innerHTML = `<span class="dotind" style="background:var(--text-dim)"></span>Loading ${esc(id)}…`;
  els.mxGrid.replaceChildren(); els.confDetail.innerHTML = ''; els.panelDetail.innerHTML = '';
  try { await loadSnapshot(); if (state.rrcsEnabled && (!state.data || !state.data.ok)) await refreshNow(); } catch { /* status shows error */ }
}
function setAuto(sec) {
  if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
  sec = Number(sec);
  if (sec > 0) state.autoTimer = setInterval(refreshNow, sec * 1000);
}

// ---------- view switching ----------
// Views only editors/admins may open (the consolidated work order).
const EDITOR_VIEWS = new Set(['workorder']);
function showView(v) {
  if (EDITOR_VIEWS.has(v) && !isEditor()) v = 'matrix';   // gate; UI also hides the tab
  state.view = v;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  render();
}
// Show/hide tabs that require a role (called whenever auth state changes).
function applyTabAccess() {
  const wo = document.querySelector('.tab[data-view="workorder"]');
  if (wo) wo.style.display = isEditor() ? '' : 'none';
}
function render() {
  if (state.view === 'settings') { renderSettings(); return; }
  if (state.view === 'requests') { renderRequests(); return; }
  if (state.view === 'workorder') { renderWorkOrder(); return; }
  if (!state.data || !state.data.ok) return;
  if (state.view === 'matrix') renderMatrix();
  else if (state.view === 'conferences') renderConferences();
  else if (state.view === 'panels') renderPanels();
}

// ---------- MATRIX ----------
function renderMatrix() {
  const m = state.data.matrix;
  const rq = els.mxRowSearch.value.trim().toLowerCase();
  const cq = els.mxColSearch.value.trim().toLowerCase();
  const panelsOnly = els.mxPanelsOnly.checked;

  const rowKeep = [], rowPos = new Map();
  m.rows.forEach((r, i) => {
    if (panelsOnly && !r.isPanel) return;
    if (rq && !r.name.toLowerCase().includes(rq)) return;
    if (!topoPass(r, els.mxNode, els.mxCard)) return;
    rowPos.set(i, rowKeep.length); rowKeep.push({ i, r });
  });
  const colKeep = [], colPos = new Map();
  m.cols.forEach((c, i) => {
    if (cq && !(c.name.toLowerCase().includes(cq) || (c.label || '').toLowerCase().includes(cq))) return;
    colPos.set(i, colKeep.length); colKeep.push({ i, c });
  });

  const grid = els.mxGrid;
  if (rowKeep.length > MAX_GRID || colKeep.length > MAX_GRID) {
    els.mxHint.textContent = `${rowKeep.length}×${colKeep.length} too large — narrow the filters`;
    grid.replaceChildren(); return;
  }
  els.mxHint.textContent = `${rowKeep.length} panels × ${colKeep.length} conferences`;

  grid.style.gridTemplateColumns = `${ROWHEAD_W}px repeat(${colKeep.length}, ${COL_W}px)`;
  grid.style.gridTemplateRows = `${COLHEAD_H}px repeat(${rowKeep.length}, ${ROW_H}px)`;

  const frag = document.createDocumentFragment();
  const corner = document.createElement('div');
  corner.className = 'corner'; corner.style.gridArea = '1 / 1';
  frag.appendChild(corner);

  colKeep.forEach((ck, p) => {
    const h = document.createElement('div');
    h.className = 'colhead' + (ck.c.kind === 'group' ? ' group' : '');
    h.style.gridArea = `1 / ${p + 2}`;
    h.title = `${ck.c.name}${ck.c.label ? ' (' + ck.c.label + ')' : ''} — ${ck.c.memberCount} members`;
    h.textContent = ck.c.name;
    frag.appendChild(h);
  });
  rowKeep.forEach((rk, p) => {
    const h = document.createElement('div');
    h.className = 'rowhead'; h.style.gridArea = `${p + 2} / 1`;
    h.title = `${rk.r.name} — ${rk.r.addr}${rk.r.type ? ' · ' + rk.r.type : ''}`;
    h.innerHTML = `<span class="nm">${esc(rk.r.name)}</span>${rk.r.isPanel ? '' : '<span class="pin">port</span>'}`;
    frag.appendChild(h);
  });
  const showKey = els.mxKeyAccess.checked;
  for (const cell of m.cells) {
    if (cell.k && !showKey) continue;
    const rp = rowPos.get(cell.r), cp = colPos.get(cell.c);
    if (rp == null || cp == null) continue;
    const d = document.createElement('div');
    if (cell.k) { d.className = 'cell key'; d.textContent = '·'; d.title = 'reachable via a panel key'; }
    else { d.className = 'cell ' + cls(cell.t, cell.l); d.textContent = sym(cell.t, cell.l); }
    d.style.gridArea = `${rp + 2} / ${cp + 2}`;
    frag.appendChild(d);
  }
  // pending-change overlay (toggle) — markers on top of the live cells
  if (state.showPending && state.pendingIdx) {
    const rowByName = new Map();
    rowKeep.forEach((rk, p) => { rowByName.set(rk.r.name, p); if (rk.r.addr) rowByName.set(rk.r.addr, p); });
    const colByName = new Map();
    colKeep.forEach((ck, p) => colByName.set(ck.c.name, p));
    for (const [conf, panels] of state.pendingIdx.byConf) {
      const cp = colByName.get(conf); if (cp == null) continue;
      for (const [panel, rec] of panels) {
        const rp = rowByName.get(panel); if (rp == null) continue;
        const d = document.createElement('div');
        d.className = 'cell ' + (rec.op === 'add' ? 'pending-add' : 'pending-remove');
        d.textContent = rec.op === 'add' ? '＋' : '－';
        d.title = `${rec.op === 'add' ? 'pending add' : 'pending remove'} · request #${rec.requestId}`;
        d.style.gridArea = `${rp + 2} / ${cp + 2}`;
        frag.appendChild(d);
      }
    }
  }
  grid.replaceChildren(frag);
}

// ---------- CONFERENCES ----------
function allDests() { return [...(state.data.conferences || []), ...(state.data.groups || [])]; }
function sortConfs(list) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const arr = list.slice();
  switch (els.confSort.value) {
    case 'name-desc': return arr.sort((a, b) => b.name.localeCompare(a.name));
    case 'alias': return arr.sort((a, b) => (a.label || '').localeCompare(b.label || '') || byName(a, b));
    case 'members-desc': return arr.sort((a, b) => b.memberCount - a.memberCount || byName(a, b));
    case 'members-asc': return arr.sort((a, b) => a.memberCount - b.memberCount || byName(a, b));
    default: return arr.sort(byName);
  }
}
function renderConferences() {
  const q = els.confSearch.value.trim().toLowerCase();
  const list = sortConfs(allDests().filter((d) => !q || d.name.toLowerCase().includes(q) || (d.label || '').toLowerCase().includes(q)));
  const ul = document.createDocumentFragment();
  list.forEach((d, i) => {
    const li = document.createElement('li');
    const realIdx = allDests().indexOf(d);
    li.className = state.selConf === realIdx ? 'active' : '';
    li.innerHTML = `<span class="nm">${esc(d.name)}</span><span class="badge${d.kind === 'group' ? ' group' : ''}">${d.memberCount}</span>`;
    li.onclick = () => { state.selConf = realIdx; renderConferences(); renderConfDetail(d); };
    ul.appendChild(li);
  });
  els.confList.replaceChildren(ul);
  if (state.selConf != null && allDests()[state.selConf]) renderConfDetail(allDests()[state.selConf]);
}
function renderConfDetail(d) {
  const rows = d.members.map((m) => `
    <tr><td><a href="#" class="xlink" data-addr="${esc(m.addr)}" title="Open this panel">${esc(m.name)}</a></td><td class="type-chip">${esc(m.type)}</td>
    <td>${dirPill(m.talk, m.listen)}</td><td class="type-chip">${esc(m.addr)}</td></tr>`).join('');
  els.confDetail.innerHTML = `
    <div class="detail-head"><h2>${esc(d.name)}</h2><button class="btn small" data-reqconf="${esc(d.name)}">⇄ Request change</button></div>
    <div class="meta"><span class="tag">${d.kind}</span>${d.label ? '<span class="tag">' + esc(d.label) + '</span>' : ''}${d.memberCount} members</div>
    <table class="members"><thead><tr><th>Member</th><th>Type</th><th>Direction</th><th>Port</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No members.</td></tr>'}</tbody></table>
    ${pendingPanelHtml('conf', d.name)}`;
}
function dirPill(t, l) {
  if (t && l) return '<span class="pill both">Talk + Listen</span>';
  if (t) return '<span class="pill talk">Talk</span>';
  if (l) return '<span class="pill listen">Listen</span>';
  return '<span class="pill muted">—</span>';
}

// ---------- cross-linking (Conferences ⇄ Panels) ----------
// "kind name" -> index into allDests(), so a panel membership can jump to its
// conference/group. Same ordering renderConferences uses for state.selConf.
function destIndexByKindName() {
  const m = new Map();
  allDests().forEach((d, i) => m.set(d.kind + '\u0000' + d.name, i));
  return m;
}
function scrollListToSelected(ul) { const el = ul.querySelector('li.active'); if (el) el.scrollIntoView({ block: 'nearest' }); }
// Jump to the Panels view with a panel selected (clear filters so it shows).
function gotoPanel(addr) {
  if (!(state.data.panels || []).some((p) => p.addr === addr)) return;
  state.selPanel = addr;
  els.panelSearch.value = '';
  if (!els.pnNode.hidden) { els.pnNode.value = ''; fillCards(els.pnNode, els.pnCard, ''); }
  showView('panels');
  scrollListToSelected(els.panelList);
}
// Jump to the Conferences view with a conference/group selected.
function gotoConference(idx) {
  if (!Number.isInteger(idx) || !allDests()[idx]) return;
  state.selConf = idx;
  els.confSearch.value = '';
  showView('conferences');
  scrollListToSelected(els.confList);
}

// ---------- PANELS ----------
function renderPanels() {
  const q = els.panelSearch.value.trim().toLowerCase();
  const list = (state.data.panels || []).filter((p) => (!q || p.name.toLowerCase().includes(q) || p.addr.includes(q)) && topoPass(p, els.pnNode, els.pnCard));
  const ul = document.createDocumentFragment();
  list.forEach((p) => {
    const li = document.createElement('li');
    li.className = state.selPanel === p.addr ? 'active' : '';
    li.innerHTML = `<span class="nm">${esc(p.name)}</span><span class="badge">${p.memberships.length}</span>`;
    li.onclick = () => { state.selPanel = p.addr; renderPanels(); renderPanelDetail(p); };
    ul.appendChild(li);
  });
  els.panelList.replaceChildren(ul);
  const sel = (state.data.panels || []).find((p) => p.addr === state.selPanel);
  if (sel) renderPanelDetail(sel);
}
function renderPanelDetail(p) {
  const members = p.memberships.filter((m) => m.access === 'member');
  const keys = p.memberships.filter((m) => m.access === 'key');
  const destIdx = destIndexByKindName();
  const rows = p.memberships.map((m) => {
    const di = destIdx.get(m.kind + '\u0000' + m.name);
    const nameCell = di != null ? `<a href="#" class="xlink" data-conf="${di}" title="Open this ${m.kind}">${esc(m.name)}</a>` : esc(m.name);
    return `
    <tr><td>${nameCell}</td><td class="type-chip">${m.kind}</td>
    <td>${m.access === 'key' ? '<span class="pill key">Via key</span>' : '<span class="pill muted-2">Member</span>'}</td>
    <td>${m.access === 'key' ? '<span class="type-chip">—</span>' : dirPill(m.talk, m.listen)}</td></tr>`;
  }).join('');
  const keyNote = keys.length ? ` · <span class="key-note">+${keys.length} via key</span>` : '';
  els.panelDetail.innerHTML = `
    <div class="detail-head"><h2>${esc(p.name)}</h2><button class="btn small" data-reqpanel="${esc(p.name)}">⇄ Request change</button></div>
    <div class="meta"><span class="tag">${p.isPanel ? 'panel' : 'port'}</span>${p.type ? '<span class="tag">' + esc(p.type) + '</span>' : ''}${p.twoWire ? '<span class="tag">2-wire (in+out)</span>' : ''}<span class="tag">${esc(p.addr)}</span>${p.node ? '<span class="tag">' + esc(p.node) + ' · ' + esc(p.bay || '') + '</span>' : ''}${members.length} member${keyNote}</div>
    <table class="members"><thead><tr><th>Conference / Group</th><th>Kind</th><th>Access</th><th>Direction</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">Not a member of any conference.</td></tr>'}</tbody></table>
    ${pendingPanelHtml('panel', p.name)}`;
}

// ============================================================================
// CHANGE-REQUEST PLATFORM
// ============================================================================

// ----- authentication (session cookie; local · LDAP · SAML) -----
// state.auth = { authenticated, username, displayName, role, authMethod,
//                ldapEnabled, samlEnabled, requireLogin }
async function loadMe() {
  try { state.auth = await api('/api/auth/me'); }
  catch { state.auth = { authenticated: false, ldapEnabled: false, samlEnabled: false, requireLogin: false }; }
  return state.auth;
}
const isAuthed = () => !!(state.auth && state.auth.authenticated);
const isAdmin = () => !!(state.auth && state.auth.role === 'admin');
const isEditor = () => !!(state.auth && (state.auth.role === 'admin' || state.auth.role === 'editor'));
const myName = () => (state.auth && (state.auth.displayName || state.auth.username)) || '';
const myRole = () => (state.auth && state.auth.authenticated && state.auth.role) || 'anonymous';

// Top-right profile menu (avatar → dropdown). Replaces the old inline pill.
function renderWho() {
  const av = document.getElementById('profileAv');
  if (av) {
    if (isAuthed()) { av.textContent = (myName()[0] || '?').toUpperCase(); av.className = 'profile-av role-' + esc(myRole()); }
    else { av.textContent = '◐'; av.className = 'profile-av'; }
  }
  renderProfileMenu();
  applyTabAccess();   // role-gated tabs (Work order) follow the signed-in role
}
function renderProfileMenu() {
  const menu = document.getElementById('profileMenu'); if (!menu) return;
  if (isAuthed()) {
    menu.innerHTML = `
      <div class="profile-head">
        <span class="profile-av lg role-${esc(myRole())}">${esc((myName()[0] || '?').toUpperCase())}</span>
        <div class="profile-id"><b>${esc(myName())}</b><span class="role-pill role-${esc(myRole())}">${esc(myRole())}</span></div>
      </div>
      <button class="profile-item" data-pact="account">Account</button>
      <button class="profile-item" data-pact="settings">⚙ Settings</button>
      <button class="profile-item danger" data-pact="logout">Log out</button>`;
  } else {
    menu.innerHTML = `
      <div class="profile-head"><span class="profile-av">◐</span><div class="profile-id"><b>Not signed in</b><span class="muted">read-only</span></div></div>
      <button class="profile-item" data-pact="settings">⚙ Settings</button>
      <button class="profile-item primary" data-pact="signin">Sign in</button>`;
  }
}
function toggleProfileMenu(force) {
  const p = document.getElementById('profile'); const btn = document.getElementById('profileBtn');
  const open = force != null ? force : p.classList.contains('open') ? false : true;
  p.classList.toggle('open', open);
  document.getElementById('profileMenu').classList.toggle('hidden', !open);
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

// One modal, two faces: the login form (signed out) or the account panel
// (signed in). `gated` makes it non-dismissable for the require-login wall.
function openAuthModal(gated) {
  renderAuthModal(gated);
  document.getElementById('authModal').classList.remove('hidden');
  const u = document.getElementById('authUser');
  if (u) setTimeout(() => u.focus(), 0);
}
function closeAuthModal() {
  if (state.authGated) return;   // login wall — can't dismiss
  document.getElementById('authModal').classList.add('hidden');
}
function renderAuthModal(gated) {
  state.authGated = !!gated;
  const a = state.auth || {};
  document.getElementById('authTitle').textContent = isAuthed() ? 'Account' : 'Sign in';
  document.getElementById('authClose').style.display = gated ? 'none' : '';
  const body = document.getElementById('authBody');
  if (isAuthed()) {
    body.innerHTML = `
      <div class="acct">
        <span class="acct-av role-${esc(a.role)}">${esc((myName()[0] || '?').toUpperCase())}</span>
        <div class="acct-id"><b>${esc(myName())}</b><span class="role-pill role-${esc(a.role)}">${esc(a.role)}</span></div>
      </div>
      <p class="card-sub">Signed in via ${esc(a.authMethod || 'local')}. ${a.role === 'admin' ? 'You can manage deployment settings.' : 'Deployment settings are admin-only.'}</p>
      <div class="modal-foot"><button class="btn" id="authLogout">Log out</button></div>`;
    return;
  }
  // Render only the enabled methods. The password form serves both local and
  // LDAP; SAML is a redirect button. If only SSO is on, the form hides behind a
  // "use a local account" link (break-glass for the env bootstrap admin).
  const m = a.authMethods || { local: { enabled: true }, ldap: { enabled: false }, saml: { enabled: false } };
  const formMethods = m.local.enabled || m.ldap.enabled;
  const ssoBtn = m.saml.enabled ? '<button class="btn" id="authSso" type="button" style="width:100%">Sign in with SSO</button>' : '';
  const ldapHint = m.ldap.enabled ? '<p class="auth-hint">Use your LDAP / Active Directory credentials.</p>' : '';
  const form = `
    <form id="authForm" class="auth-form" autocomplete="on">
      <label class="fl"><span>Username</span><input id="authUser" autocomplete="username" autocapitalize="none" spellcheck="false" /></label>
      <label class="fl"><span>Password</span><input id="authPass" type="password" autocomplete="current-password" /></label>
      <div class="auth-err" id="authErr"></div>
      <button class="btn primary" id="authSubmit" type="submit" style="width:100%">Sign in</button>
    </form>`;
  let html;
  if (formMethods) {
    html = form + ldapHint + (ssoBtn ? `<div class="auth-or"><span>or</span></div>${ssoBtn}` : '');
  } else if (m.saml.enabled) {
    html = ssoBtn + `<div class="auth-or"><span>or</span></div>
      <button class="btn ghost" id="authReveal" type="button" style="width:100%">Use a local account</button>
      <div id="authLocalWrap" class="hidden" style="margin-top:10px">${form}</div>`;
  } else {
    html = '<p class="auth-hint">No sign-in methods are enabled. An administrator can re-enable them in Settings → Users.</p>' + form;
  }
  body.innerHTML = html;
}
async function doLogin(ev) {
  if (ev) ev.preventDefault();
  const err = document.getElementById('authErr');
  const btn = document.getElementById('authSubmit');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const r = await fetch(rel('/api/auth/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('authUser').value, password: document.getElementById('authPass').value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error || 'Login failed'; return; }
    location.reload();   // re-init fully authenticated (cookie is set)
  } catch { err.textContent = 'Connection error'; }
  finally { btn.disabled = false; btn.textContent = 'Sign in'; }
}
function startSso() {
  const next = encodeURIComponent(location.pathname + location.search + location.hash);
  location.href = rel('/api/auth/saml/login') + '?next=' + next;
}
async function doLogout() {
  try { await fetch(rel('/api/auth/logout'), { method: 'POST' }); } catch { /* ignore */ }
  location.reload();
}

async function reqPost(path, body) {
  const r = await fetch(rel(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// ----- data loading -----
async function loadRequests() {
  const d = await api(url('/api/requests'));
  state.requests = d.requests || [];
  state.reqStats = d.stats || { byStatus: {}, total: 0 };
  updateReqBadge();
}
async function loadPending() {
  state.pending = await api(url('/api/pending'));
  buildPendingIndex();
  updateWoBadge();
}
function buildPendingIndex() {
  const byConf = new Map(), byPanel = new Map();
  const newConfs = new Set(state.pending.newConferences || []);
  const delConfs = new Set(state.pending.deletedConferences || []);
  const renameConfs = new Map();  // name -> { newName, requestId }
  for (const c of state.pending.changes || []) {
    if (c.type === 'rename_conference') { renameConfs.set(c.conference, { newName: c.newName, requestId: c.requestId }); continue; }
    if (c.type === 'create_conference' || c.type === 'delete_conference') continue;
    // membership ops (add/remove/change_direction) overlay onto the matrix/detail
    const panel = c.panelName || c.panel, op = c.type === 'add_member' ? 'add' : c.type === 'remove_member' ? 'remove' : 'dir';
    const rec = { op, requestId: c.requestId, talk: c.talk, listen: c.listen, isNew: c.isNewConference };
    if (!byConf.has(c.conference)) byConf.set(c.conference, new Map());
    byConf.get(c.conference).set(panel, rec);
    if (!byPanel.has(panel)) byPanel.set(panel, new Map());
    byPanel.get(panel).set(c.conference, rec);
  }
  state.pendingIdx = { byConf, byPanel, newConfs, delConfs, renameConfs };
}
function updateReqBadge() {
  const active = (state.reqStats.byStatus.open || 0) + (state.reqStats.byStatus.implemented_pending_verify || 0) + (state.reqStats.byStatus.partially_verified || 0);
  setBadge('reqBadge', active);
}
function updateWoBadge() {
  setBadge('woBadge', state.pending && state.pending.changes ? state.pending.changes.length : 0);
}
function setBadge(id, n) { const b = document.getElementById(id); if (b) { b.textContent = n || ''; b.classList.toggle('hidden', !n); } }

// ----- status helpers -----
const STATUS_LABEL = { open: 'Open', implemented_pending_verify: 'Implemented (awaiting print)', partially_verified: 'Partially verified', verified: 'Verified', rejected: 'Rejected', cancelled: 'Cancelled' };
const STATUS_CLASS = { open: 'st-open', implemented_pending_verify: 'st-impl', partially_verified: 'st-part', verified: 'st-ok', rejected: 'st-bad', cancelled: 'st-bad' };
const VAL_CLASS = { valid: 'v-ok', depends_on: 'v-dep', noop: 'v-noop', conflict: 'v-bad', unresolved: 'v-bad', unknown: 'v-noop' };
const ACTIVE_STATUSES = ['open', 'implemented_pending_verify', 'partially_verified'];

const SHORT_STATUS = { open: 'Open', implemented_pending_verify: 'In config tool', partially_verified: 'Partial', verified: 'Verified', rejected: 'Rejected', cancelled: 'Cancelled' };

// ----- Requests view (queue table → request detail) -----
function renderRequests() {
  // master/detail: the table is the overview; selecting a row opens the detail
  const showDetail = state.selReq != null && state.reqCurrent;
  document.getElementById('reqFilters').classList.toggle('hidden', showDetail);
  document.getElementById('reqTableWrap').classList.toggle('hidden', showDetail);
  document.getElementById('reqDetail').classList.toggle('hidden', !showDetail);
  if (showDetail) { renderReqDetail(); return; }
  renderReqFilters();
  renderReqTable();
}
function renderReqFilters() {
  const by = state.reqStats.byStatus || {};
  const active = (by.open || 0) + (by.implemented_pending_verify || 0) + (by.partially_verified || 0);
  const chips = [
    ['active', 'Active', active], ['verified', 'Verified', by.verified || 0],
    ['rejected', 'Closed', (by.rejected || 0) + (by.cancelled || 0)], ['all', 'All', state.reqStats.total || 0],
  ];
  document.getElementById('reqFilters').innerHTML = chips.map(([k, lbl, n]) =>
    `<button class="req-chip ${state.reqStatusFilter === k ? 'active' : ''}" data-filter="${k}">${lbl}<span>${n}</span></button>`).join('');
}
function filteredRequests() {
  const f = state.reqStatusFilter;
  if (f === 'all') return state.requests;
  if (f === 'active') return state.requests.filter((r) => ACTIVE_STATUSES.includes(r.status));
  if (f === 'rejected') return state.requests.filter((r) => r.status === 'rejected' || r.status === 'cancelled');
  return state.requests.filter((r) => r.status === f);
}
function renderReqTable() {
  const list = filteredRequests();
  const tb = document.getElementById('reqRows');
  if (!list.length) { tb.innerHTML = '<tr><td colspan="6" class="req-empty muted">No requests here yet.</td></tr>'; return; }
  tb.innerHTML = list.map((r) => {
    const changes = `${r.itemCount}${r.verifiedCount ? ` <span class="muted">· ${r.verifiedCount}/${r.itemCount}</span>` : ''}`;
    return `
    <tr class="req-tr" data-req="${r.id}" data-status="${r.status}">
      <td class="rt-id"><span class="mono">#${r.id}</span></td>
      <td class="rt-title">${esc(r.title)}${r.validation.hasBlockers ? ' <span class="v-bad" title="some changes need review">⚠</span>' : ''}</td>
      <td class="rt-who">${esc(r.requester.name || 'anon')}</td>
      <td class="rt-changes">${changes}</td>
      <td class="rt-status"><span class="st ${STATUS_CLASS[r.status]}">${SHORT_STATUS[r.status] || r.status}</span></td>
      <td class="rt-when muted">${relTime(r.updatedAt) || '—'}</td>
    </tr>`;
  }).join('');
}
async function selectRequest(id) {
  state.selReq = id; showView('requests');
  try { state.reqCurrent = await api(url('/api/requests/' + id)); }
  catch { state.reqCurrent = null; }
  renderRequests();
}
// Lifecycle stepper — makes the request → implement → verify path visible.
function lifecycleStepper(r) {
  if (r.status === 'rejected' || r.status === 'cancelled') {
    return `<div class="stepper-term st ${STATUS_CLASS[r.status]}">${STATUS_LABEL[r.status]}</div>`;
  }
  const steps = ['Requested', 'Applied in config tool', 'Verified by print'];
  const done = r.status === 'verified' ? 3 : r.status === 'implemented_pending_verify' || r.status === 'partially_verified' ? 2 : 1;
  return `<ol class="stepper">${steps.map((s, i) => {
    const n = i + 1, cls = n <= done ? 'done' : (n === done + 1 ? 'current' : 'todo');
    return `<li class="step ${cls}"><span class="step-dot">${n <= done ? '✓' : ''}</span><span class="step-label">${s}</span></li>`;
  }).join('')}</ol>`;
}
// One change, as a colour-coded card; validation stays quiet unless there's a problem.
// Per-action status mark (so the engineer sees what's outstanding).
function itemStatus(it) {
  if (it.reconcileState === 'verified') return '<span class="gi-st ok">✓ done</span>';
  const v = it.validation.state;
  if (v === 'conflict' || v === 'unresolved') return `<span class="gi-st bad" title="${esc(it.validation.note)}">⚠ review</span>`;
  if (v === 'noop') return '<span class="gi-st muted" title="already in this state">no change</span>';
  return '';   // pending / to-do → no mark (its presence in the list is the to-do)
}
// One membership action under a conference: "＋ add  PANEL  · T+L  [status]"
function memberLine(it) {
  const dir = it.talk && it.listen ? 'T+L' : it.talk ? 'T' : it.listen ? 'L' : '';
  const op = it.type === 'add_member' ? ['add', '＋ add'] : it.type === 'remove_member' ? ['remove', '－ remove'] : ['dir', '⇄ set'];
  const showDir = (it.type === 'add_member' || it.type === 'change_direction') && dir;
  return `<li class="grp-item ${op[0]}"><span class="gi-op">${op[1]}</span><span class="gi-panel">${esc(it.panel.name)}</span>${showDir ? `<span class="gi-dir">${dir}</span>` : ''}<span class="gi-st-wrap">${itemStatus(it)}</span></li>`;
}
// Group a request's changes by conference — the way the work is done in the config tool.
function groupChanges(items) {
  const m = new Map();
  for (const it of items) {
    const k = it.conference.name;
    let g = m.get(k);
    if (!g) { g = { name: it.conference.name, label: it.conference.label, create: null, del: null, rename: null, members: [] }; m.set(k, g); }
    if (it.type === 'create_conference') { g.create = it; g.label = it.conference.label || g.label; }
    else if (it.type === 'delete_conference') g.del = it;
    else if (it.type === 'rename_conference') g.rename = it;
    else g.members.push(it);
  }
  return [...m.values()];
}
function renderChangeGroups(items) {
  return groupChanges(items).map((g) => {
    const tags = [];
    if (g.create) tags.push(`<span class="grp-tag new">＋ create new</span>${itemStatus(g.create)}`);
    if (g.del) tags.push(`<span class="grp-tag del">✕ delete conference</span>${itemStatus(g.del)}`);
    if (g.rename) tags.push(`<span class="grp-tag ren">✎ rename → “${esc(g.rename.newName)}”</span>${itemStatus(g.rename)}`);
    const gcls = g.create ? 'grp-new' : g.del ? 'grp-del' : g.rename ? 'grp-ren' : '';
    return `<div class="grp ${gcls}">
      <div class="grp-head"><span class="grp-name">${esc(g.name)}</span>${g.label ? ` <span class="muted">(${esc(g.label)})</span>` : ''}<span class="grp-tags">${tags.join('')}</span></div>
      ${g.members.length ? `<ul class="grp-items">${g.members.map(memberLine).join('')}</ul>` : ''}
    </div>`;
  }).join('');
}
function renderReqDetail() {
  const el = document.getElementById('reqDetail');
  const r = state.reqCurrent;
  if (!r || state.selReq == null) { el.innerHTML = '<div class="empty">Select a request from the queue, or create one with the buttons above.</div>'; return; }
  const kindLabel = r.kind === 'conference' ? 'Conference changes' : r.kind === 'mixed' ? 'Mixed changes' : 'Membership changes';
  el.innerHTML = `
    <div class="rd-inner">
    <button class="rd-back" id="rdBack">← All requests</button>
    <div class="rd-eyebrow"><span class="mono">#${r.id}</span> · ${kindLabel}</div>
    <h2 class="rd-title">${esc(r.title)}</h2>
    <div class="rd-meta">${esc(r.requester.name || 'anon')}${r.requester.role ? ' · ' + esc(r.requester.role) : ''} · ${fmtDateTime(r.createdAt)}${r.neededBy ? ' · needed by ' + esc(r.neededBy) : ''}</div>
    ${lifecycleStepper(r)}
    ${r.justification ? `<p class="rd-justify">${esc(r.justification)}</p>` : ''}
    ${r.validation.hasBlockers ? '<div class="rd-warn">⚠ Some changes don’t match the current system — review before implementing.</div>' : ''}
    <div class="rd-section-h">What to change in the config tool <span class="muted">(${r.items.length})</span></div>
    <div class="grp-list">${renderChangeGroups(r.items)}</div>
    <div class="rd-actions">${transitionButtons(r.status)}</div>
    <div class="rd-cols">
      <div>
        <div class="rd-section-h">Discussion</div>
        <div class="rd-comments">${(r.comments || []).map((c) => `<div class="cmt"><b>${esc(c.author)}</b> <span class="muted">${fmtDateTime(c.at)}</span><div>${esc(c.body)}</div></div>`).join('') || '<span class="muted">No comments yet.</span>'}</div>
        <div class="cmt-row"><input type="text" id="rdComment" placeholder="Add a comment…" /><button class="btn small" id="rdCommentBtn">Comment</button></div>
      </div>
      <div>
        <div class="rd-section-h">History</div>
        <ul class="rd-history">${(r.history || []).map((h) => `<li><span class="muted">${fmtDateTime(h.at)}</span> · ${esc(h.by || 'system')}${h.from ? ` · ${esc(h.from)} → <b>${esc(h.to)}</b>` : ''}${h.note ? `<div class="muted">${esc(h.note)}</div>` : ''}</li>`).join('')}</ul>
      </div>
    </div>
    </div>`;
}
function transitionButtons(status) {
  const map = {
    open: [['implemented_pending_verify', 'Mark applied in config tool', 'primary'], ['rejected', 'Reject', ''], ['cancelled', 'Cancel', '']],
    implemented_pending_verify: [['verified', 'Mark verified', 'primary'], ['open', 'Reopen', ''], ['rejected', 'Reject', '']],
    partially_verified: [['verified', 'Mark verified', 'primary'], ['rejected', 'Reject', '']],
  };
  const btns = map[status] || [];
  if (!btns.length) return '<span class="muted">This request is closed — no further actions.</span>';
  return btns.map(([to, lbl, cls]) => `<button class="btn small ${cls}" data-transition="${to}">${lbl}</button>`).join('');
}
async function transitionReq(to) {
  let note = null;
  if (to === 'rejected') { note = prompt('Reason for rejection (optional):', '') || null; }
  try { state.reqCurrent = await reqPost('/api/requests/' + state.selReq + '/transition', { to, note }); await loadRequests(); await loadPending(); renderRequests(); }
  catch (e) { alert(e.message); }
}
async function commentReq() {
  const inp = document.getElementById('rdComment'); const body = inp.value.trim(); if (!body) return;
  try { state.reqCurrent = await reqPost('/api/requests/' + state.selReq + '/comments', { body }); renderReqDetail(); }
  catch (e) { alert(e.message); }
}

// ----- work order -----
async function renderWorkOrder() {
  const el = document.getElementById('reqWorkOrder');
  let wo; try { wo = await api(url('/api/work-order')); } catch (e) { el.innerHTML = `<div class="rd-warn">${esc(e.message)}</div>`; return; }
  if (!wo.groups.length) { el.innerHTML = '<div class="empty">No pending changes. The work order is clear.</div>'; return; }
  const dTag = (x) => { const d = x.talk && x.listen ? 'T+L' : x.talk ? 'T' : x.listen ? 'L' : ''; return d ? `<span class="gi-dir">${d}</span>` : ''; };
  const req = (id) => `<span class="gi-req">#${id}</span>`;
  const groupHtml = (g) => {
    const tags = [];
    if (g.isNew) tags.push('<span class="grp-tag new">＋ create new</span>');
    if (g.del) tags.push('<span class="grp-tag del">✕ delete conference</span>');
    if (g.rename) tags.push(`<span class="grp-tag ren">✎ rename → “${esc(g.rename)}”</span>`);
    const items = [
      ...g.adds.map((a) => `<li class="grp-item add"><span class="gi-op">＋ add</span><span class="gi-panel">${esc(a.panel)}</span>${dTag(a)}${req(a.requestId)}</li>`),
      ...g.removes.map((rm) => `<li class="grp-item remove"><span class="gi-op">－ remove</span><span class="gi-panel">${esc(rm.panel)}</span>${req(rm.requestId)}</li>`),
      ...(g.dirs || []).map((d) => `<li class="grp-item dir"><span class="gi-op">⇄ set</span><span class="gi-panel">${esc(d.panel)}</span>${dTag(d)}${req(d.requestId)}</li>`),
    ].join('');
    const gcls = g.isNew ? 'grp-new' : g.del ? 'grp-del' : g.rename ? 'grp-ren' : '';
    return `<div class="grp ${gcls}">
      <div class="grp-head"><span class="grp-name">${esc(g.conference)}</span>${g.conferenceLabel ? ` <span class="muted">(${esc(g.conferenceLabel)})</span>` : ''}<span class="grp-tags">${tags.join('')}</span></div>
      ${items ? `<ul class="grp-items">${items}</ul>` : ''}
    </div>`;
  };
  el.innerHTML = `
    <div class="wo-head">
      <h3>Work order <span class="muted">— ${wo.changeCount} change(s) across ${wo.conferenceCount} conference(s), from ${wo.requestCount} request(s)</span></h3>
      <p class="muted small">Apply these in the config tool, then upload a fresh print — changes verify automatically.</p>
    </div>
    <div class="grp-list">${wo.groups.map(groupHtml).join('')}</div>`;
}

// ----- composer (unified: every conference & membership operation) -----
const cMsg = (html) => { document.getElementById('cMsg').innerHTML = html || ''; };
const bad = (s) => `<span class="v-bad">${esc(s)}</span>`;
const cVal = (id) => document.getElementById(id).value.trim();
const cSet = (id, v) => { document.getElementById(id).value = v; };
const dirOn = (d) => document.querySelector(`.dir-pill[data-dir="${d}"]`).classList.contains('active');
// staged "changes" are now BATCHES ({ op, items:[…] }); flatten to find created confs
const stagedItems = () => (state.composer ? state.composer.changes : []).flatMap((b) => b.items);
const stagedNewConfs = () => new Set(stagedItems().filter((it) => it.type === 'create_conference').map((it) => it.conference));
// is the conference combo multi-select for the current op? (single only for rename)
const confMulti = () => !!(state.composer && state.composer.op !== 'rename_conference');
// which builder fields each operation shows
const OP_FIELDS = {
  add_member: ['conf', 'panel', 'dir'], remove_member: ['conf', 'panel'], change_direction: ['conf', 'panel', 'dir'],
  create_conference: ['newconf'], rename_conference: ['conf', 'rename'], delete_conference: ['conf', 'delete'],
};
// Operations that act on a conference the panel is ALREADY in — so the panel is
// chosen first and the conference list is scoped to that panel's memberships.
const PANEL_SCOPED = new Set(['remove_member', 'change_direction']);
function panelConferences(panelName) {
  const p = (state.data && state.data.panels || []).find((x) => x.name === panelName || x.addr === panelName);
  return p ? p.memberships.filter((m) => m.kind === 'conference').map((m) => m.name) : [];
}
// selected tokens for a combo (chips); cleared/redrawn as the op changes
function renderChips(field) {
  const cont = document.getElementById(field === 'conf' ? 'cConfChips' : 'cPanelChips');
  const multi = field === 'conf' ? confMulti() : true;
  const sel = state.composer ? state.composer.sel[field] : [];
  if (!multi || !sel.length) { cont.innerHTML = ''; cont.classList.add('hidden'); return; }
  cont.classList.remove('hidden');
  cont.innerHTML = sel.map((v, i) => `<span class="tok">${esc(v)}<button class="tok-x" data-field="${field}" data-i="${i}" title="Remove">×</button></span>`).join('');
}
// how many change items the current selection will produce → live button label
function updateAddCount() {
  const c = state.composer, btn = document.getElementById('cAddBtn');
  let n = 1;
  if (c) {
    if (PANEL_SCOPED.has(c.op) || c.op === 'add_member') n = c.sel.conf.length * c.sel.panel.length;
    else if (c.op === 'delete_conference') n = c.sel.conf.length;
  }
  btn.textContent = n > 1 ? `Add ${n} changes` : 'Add change';
}
function setOperation(op) {
  const c = state.composer;
  if (c) { c.op = op; c.sel = { conf: [], panel: [] }; }
  document.querySelectorAll('#cOpPicker .op-chip').forEach((x) => x.classList.toggle('active', x.dataset.op === op));
  const show = new Set(OP_FIELDS[op] || []);
  document.querySelectorAll('#cAddRow .bf').forEach((el) => el.classList.toggle('hidden', !show.has(el.dataset.for)));
  const scoped = PANEL_SCOPED.has(op);
  const row = document.getElementById('cAddRow');
  row.classList.toggle('danger', op === 'delete_conference');
  row.classList.toggle('panel-first', scoped);  // show the panel field above the conference
  cSet('cConfInput', ''); cSet('cPanelInput', '');
  document.getElementById('cConfInput').placeholder = scoped ? 'Conference on this panel…'
    : (op === 'rename_conference' || op === 'delete_conference') ? 'Search conference to edit…' : 'Search conference…';
  renderChips('conf'); renderChips('panel'); updateAddCount();
}
function openComposer(seed) {
  state.composer = { changes: [], op: (seed && seed.op) || 'add_member', sel: { conf: [], panel: [] } };
  cSet('cTitle', (seed && seed.title) || ''); cSet('cJustify', '');
  cSet('cNewName', ''); cSet('cNewLabel', ''); cSet('cRenameName', ''); cSet('cRenameLabel', '');
  document.querySelectorAll('.dir-pill').forEach((p) => p.classList.add('active'));
  setOperation(state.composer.op);
  // apply a contextual seed (conference/panel become a selected chip, or the input for rename)
  if (seed && seed.conference) { if (confMulti()) state.composer.sel.conf = [seed.conference]; else cSet('cConfInput', seed.conference); }
  if (seed && seed.panel) state.composer.sel.panel = [seed.panel];
  renderChips('conf'); renderChips('panel'); updateAddCount();
  cMsg(''); renderComposerChanges();
  document.getElementById('composer').classList.remove('hidden');
}
function closeComposer() { document.getElementById('composer').classList.add('hidden'); document.querySelectorAll('.combo-list').forEach((l) => l.classList.add('hidden')); state.composer = null; }
// Build a BATCH ({ op, items[] }) from the current selection — fanning multi-selects
// out to the cross-product. A single selection is just a batch of one.
function composerAddChange() {
  const c = state.composer; if (!c) return;
  const op = c.op;
  let items = [];
  if (op === 'create_conference') {
    const name = cVal('cNewName'); if (!name) return cMsg(bad('Name the conference.'));
    if (stagedNewConfs().has(name)) return cMsg(bad('Already creating a conference with that name.'));
    items = [{ type: op, conference: name, label: cVal('cNewLabel') }]; cSet('cNewName', ''); cSet('cNewLabel', '');
  } else if (op === 'rename_conference') {
    const from = cVal('cConfInput'), nn = cVal('cRenameName');
    if (!from) return cMsg(bad('Pick a conference.')); if (!nn) return cMsg(bad('Enter the new name.'));
    items = [{ type: op, conference: from, newName: nn, newLabel: cVal('cRenameLabel') }]; cSet('cConfInput', ''); cSet('cRenameName', ''); cSet('cRenameLabel', '');
  } else if (op === 'delete_conference') {
    if (!c.sel.conf.length) return cMsg(bad('Pick a conference.'));
    items = c.sel.conf.map((conf) => ({ type: op, conference: conf }));
  } else { // add_member / remove_member / change_direction → cross-product
    if (!c.sel.conf.length) return cMsg(bad('Pick at least one conference.'));
    if (!c.sel.panel.length) return cMsg(bad('Pick at least one panel.'));
    const talk = dirOn('talk'), listen = dirOn('listen');
    for (const conf of c.sel.conf) for (const panel of c.sel.panel) items.push({ type: op, conference: conf, panel, talk, listen, isNew: stagedNewConfs().has(conf) });
  }
  c.changes.push({ op, items });
  c.sel = { conf: [], panel: [] };
  renderChips('conf'); renderChips('panel'); updateAddCount();
  cMsg(''); renderComposerChanges();
}
// label + colour for a staged change
function describeStaged(ch) {
  const d = ch.talk && ch.listen ? 'T+L' : ch.talk ? 'T' : ch.listen ? 'L' : '—';
  switch (ch.type) {
    case 'create_conference': return { verb: 'create', cls: 'add', label: `“${esc(ch.conference)}”${ch.label ? ` <span class="muted">(${esc(ch.label)})</span>` : ''}` };
    case 'rename_conference': return { verb: 'rename', cls: 'dir', label: `“${esc(ch.conference)}” <span class="muted">→</span> “${esc(ch.newName)}”` };
    case 'delete_conference': return { verb: 'delete', cls: 'rem', label: `“${esc(ch.conference)}”` };
    case 'add_member': return { verb: 'add', cls: 'add', label: `${esc(ch.conference)} <span class="muted">to</span> ${esc(ch.panel)} <span class="muted">· ${d}</span>` };
    case 'remove_member': return { verb: 'remove', cls: 'rem', label: `${esc(ch.conference)} <span class="muted">from</span> ${esc(ch.panel)}` };
    case 'change_direction': return { verb: 'edit', cls: 'dir', label: `${esc(ch.conference)} <span class="muted">on</span> ${esc(ch.panel)} <span class="muted">→ ${d}</span>` };
    default: return { verb: ch.type, cls: '', label: '' };
  }
}
// Collapse a batch into one summary row; a batch of one reads as a single change.
function describeBatch(batch) {
  const items = batch.items;
  if (items.length === 1) return describeStaged(items[0]);
  const op = batch.op;
  if (op === 'delete_conference') return { verb: 'delete', cls: 'rem', label: `${items.length} conferences` };
  const confs = [...new Set(items.map((it) => it.conference))];
  const panels = [...new Set(items.map((it) => it.panel))];
  const it0 = items[0], d = it0.talk && it0.listen ? 'T+L' : it0.talk ? 'T' : it0.listen ? 'L' : '—';
  const [verb, cls, prep] = op === 'add_member' ? ['add', 'add', 'to'] : op === 'remove_member' ? ['remove', 'rem', 'from'] : ['edit', 'dir', 'on'];
  const dirTag = op === 'remove_member' ? '' : ` <span class="muted">· ${d}</span>`;
  const cN = (n) => `${n} conference${n === 1 ? '' : 's'}`, pN = (n) => `${n} panel${n === 1 ? '' : 's'}`;
  let label;
  if (confs.length === 1) label = `${esc(confs[0])} <span class="muted">${prep}</span> ${pN(panels.length)}${dirTag}`;
  else if (panels.length === 1) label = `${cN(confs.length)} <span class="muted">${prep}</span> ${esc(panels[0])}${dirTag}`;
  else label = `${cN(confs.length)} <span class="muted">×</span> ${pN(panels.length)} <span class="muted">(${items.length})</span>${dirTag}`;
  return { verb, cls, label };
}
function renderComposerChanges() {
  const c = state.composer; if (!c) return;
  const el = document.getElementById('cChanges');
  if (!c.changes.length) { el.innerHTML = '<div class="muted small">No changes added yet — build one below.</div>'; return; }
  el.innerHTML = c.changes.map((batch, i) => {
    const s = describeBatch(batch);
    const n = batch.items.length;
    return `<div class="cc-row"><span class="cc-label"><span class="cc-op ${s.cls}">${s.verb}</span> ${s.label}${n > 1 ? ` <span class="cc-count">${n}</span>` : ''}</span><button class="cc-x" data-cc="${i}" title="Remove">×</button></div>`;
  }).join('');
}
// Custom searchable dropdown (keeps type-to-filter; replaces the native datalist).
// opts: { onPick(value), emptyHint() }
function attachCombo(inputId, listId, getItems, opts = {}) {
  const input = document.getElementById(inputId), list = document.getElementById(listId);
  let filtered = [], active = -1;
  // position the (fixed) list under the input so it escapes the modal's scroll
  // container and is never clipped; flip above if there's no room below.
  const place = () => {
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom, want = Math.min(232, list.scrollHeight || 232);
    list.style.left = r.left + 'px';
    list.style.width = r.width + 'px';
    if (below < want + 8 && r.top > below) { list.style.top = ''; list.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { list.style.bottom = ''; list.style.top = (r.bottom + 4) + 'px'; }
  };
  const isMulti = () => !!(opts.multi && opts.multi());
  const selected = () => (isMulti() && state.composer ? state.composer.sel[opts.field] : []);
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const all = getItems();
    const sel = selected();
    filtered = all.filter((n) => (!q || n.toLowerCase().includes(q)) && !sel.includes(n)).slice(0, 60);
    active = -1;
    if (!filtered.length) {
      const hint = !all.length && opts.emptyHint ? opts.emptyHint() : null;
      if (hint) { list.innerHTML = `<div class="combo-empty">${esc(hint)}</div>`; list.classList.remove('hidden'); place(); }
      else list.classList.add('hidden');
      return;
    }
    list.innerHTML = filtered.map((n, i) => `<div class="combo-opt" data-i="${i}">${esc(n)}</div>`).join('');
    list.classList.remove('hidden');
    place();
  };
  const close = () => { list.classList.add('hidden'); active = -1; };
  const hl = () => { [...list.children].forEach((c, i) => c.classList.toggle('active', i === active)); if (list.children[active]) list.children[active].scrollIntoView({ block: 'nearest' }); };
  const pick = (i) => {
    if (i < 0 || i >= filtered.length) return;
    const v = filtered[i];
    if (isMulti()) {
      const sel = state.composer.sel[opts.field];
      if (!sel.includes(v)) sel.push(v);
      input.value = ''; renderChips(opts.field); updateAddCount();
      draw(); input.focus();                                  // keep open for more selections
    } else {
      input.value = v; close(); input.focus(); if (opts.onPick) opts.onPick(v);
    }
  };
  input.addEventListener('focus', draw);
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) { if (e.key === 'ArrowDown') draw(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); hl(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); hl(); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(active); } }
    else if (e.key === 'Escape') { close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 140));
  list.addEventListener('mousedown', (e) => { const o = e.target.closest('.combo-opt'); if (o) { e.preventDefault(); pick(Number(o.dataset.i)); } });
}
async function submitComposer() {
  const c = state.composer; if (!c) return;
  const items = c.changes.flatMap((b) => b.items);   // flatten batches → individual change items
  if (!items.length) return cMsg(bad('Add at least one change.'));
  const changes = items.map((ch) => {
    if (ch.type === 'create_conference') return { type: ch.type, conference: { name: ch.conference, label: ch.label } };
    if (ch.type === 'rename_conference') return { type: ch.type, conference: { name: ch.conference }, newName: ch.newName, newLabel: ch.newLabel };
    if (ch.type === 'delete_conference') return { type: ch.type, conference: { name: ch.conference } };
    return { type: ch.type, conference: { name: ch.conference }, panel: { name: ch.panel, addr: ch.panel }, talk: ch.talk, listen: ch.listen, isNew: ch.isNew };
  });
  try {
    const created = await reqPost(url('/api/requests'), { title: cVal('cTitle'), justification: cVal('cJustify'), changes });
    closeComposer();
    await loadRequests(); await loadPending();
    showView('requests'); await selectRequest(created.id);
  } catch (e) { cMsg(bad(e.message)); }
}

// ----- contextual openers + pending overlay for detail views -----
function pendingPanelHtml(kind, name) {
  if (!state.pendingIdx) return '';
  const pi = state.pendingIdx;
  const m = kind === 'conf' ? pi.byConf.get(name) : pi.byPanel.get(name);
  const isNewConf = kind === 'conf' && pi.newConfs.has(name);
  const isDelConf = kind === 'conf' && pi.delConfs.has(name);
  const ren = kind === 'conf' ? pi.renameConfs.get(name) : null;
  if (!m && !isNewConf && !isDelConf && !ren) return '';
  const opTag = (rec) => rec.op === 'add' ? '<span class="padd">＋ pending add</span>' : rec.op === 'remove' ? '<span class="prem">－ pending remove</span>' : '<span class="pdir">⇄ pending direction</span>';
  const rows = m ? [...m.entries()].map(([k, rec]) => `<li>${opTag(rec)} ${esc(k)} <a href="#" class="reqlink" data-goreq="${rec.requestId}">#${rec.requestId}</a></li>`).join('') : '';
  const banners = [
    isNewConf ? '<div class="pending-new">＋ pending creation</div>' : '',
    isDelConf ? '<div class="pending-del">✕ pending deletion</div>' : '',
    ren ? `<div class="pending-new">✎ pending rename → “${esc(ren.newName)}” <a href="#" class="reqlink" data-goreq="${ren.requestId}">#${ren.requestId}</a></div>` : '',
  ].join('');
  return `<div class="pending-box">${banners}${rows ? '<div class="pending-title">Pending changes</div><ul>' + rows + '</ul>' : ''}</div>`;
}

// ---------- wire up ----------
els.tabs.addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) showView(t.dataset.view); });
els.refresh.addEventListener('click', refreshNow);
els.auto.addEventListener('change', () => setAuto(els.auto.value));
els.system.addEventListener('change', () => switchSystem(els.system.value));
// profile menu (top-right): toggle + item actions; close on outside click / Esc
document.getElementById('profileBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleProfileMenu(); });
document.getElementById('profileMenu').addEventListener('click', (e) => {
  const it = e.target.closest('[data-pact]'); if (!it) return;
  toggleProfileMenu(false);
  const a = it.dataset.pact;
  if (a === 'signin' || a === 'account') openAuthModal(false);
  else if (a === 'logout') doLogout();
  else if (a === 'settings') showView('settings');
});
document.addEventListener('click', (e) => { if (!e.target.closest('#profile')) toggleProfileMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleProfileMenu(false); });
let t1; const deb = (fn) => { clearTimeout(t1); t1 = setTimeout(fn, 150); };
els.mxRowSearch.addEventListener('input', () => deb(renderMatrix));
els.mxColSearch.addEventListener('input', () => deb(renderMatrix));
els.mxPanelsOnly.addEventListener('change', renderMatrix);
els.mxKeyAccess.addEventListener('change', renderMatrix);
els.confSearch.addEventListener('input', () => deb(renderConferences));
els.confSort.addEventListener('change', renderConferences);
els.panelSearch.addEventListener('input', () => deb(renderPanels));
// Cross-links: a member in a conference opens that panel; a conference in a
// panel opens that conference (event-delegated since details are re-rendered).
els.confDetail.addEventListener('click', (e) => { const a = e.target.closest('a.xlink'); if (!a) return; e.preventDefault(); gotoPanel(a.dataset.addr); });
els.panelDetail.addEventListener('click', (e) => { const a = e.target.closest('a.xlink'); if (!a) return; e.preventDefault(); gotoConference(Number(a.dataset.conf)); });
// Sources: persistent hidden file inputs (the upload buttons live in the
// dynamically-rendered Sources section, wired via data-act; drag-drop is
// re-bound per render by wireSourceDrop()).
els.cfgFile.addEventListener('change', () => { const f = els.cfgFile.files[0]; if (f) uploadConfig(f); els.cfgFile.value = ''; });
els.topoFile.addEventListener('change', () => { const f = els.topoFile.files[0]; if (f) uploadTopology(f); els.topoFile.value = ''; });
els.printFile.addEventListener('change', () => { const f = els.printFile.files[0]; if (f) uploadPrint(f); els.printFile.value = ''; });
els.mxNode.addEventListener('change', () => { fillCards(els.mxNode, els.mxCard, ''); renderMatrix(); });
els.mxCard.addEventListener('change', renderMatrix);
els.pnNode.addEventListener('change', () => { fillCards(els.pnNode, els.pnCard, ''); renderPanels(); });
els.pnCard.addEventListener('change', renderPanels);

// --- change-request platform wiring ---
const $ = (id) => document.getElementById(id);
$('mxPending').addEventListener('change', () => { state.showPending = $('mxPending').checked; renderMatrix(); });
$('reqNew').addEventListener('click', () => openComposer());
$('reqFilters').addEventListener('click', (e) => { const c = e.target.closest('.req-chip'); if (!c) return; state.reqStatusFilter = c.dataset.filter; renderRequests(); });
$('reqRows').addEventListener('click', (e) => { const tr = e.target.closest('.req-tr'); if (tr) selectRequest(Number(tr.dataset.req)); });
$('reqDetail').addEventListener('click', (e) => {
  if (e.target.closest('#rdBack')) { state.selReq = null; state.reqCurrent = null; renderRequests(); return; }
  const tr = e.target.closest('[data-transition]'); if (tr) { transitionReq(tr.dataset.transition); return; }
  if (e.target.id === 'rdCommentBtn') commentReq();
});
$('reqDetail').addEventListener('keydown', (e) => { if (e.target.id === 'rdComment' && e.key === 'Enter') commentReq(); });
// composer
$('composerClose').addEventListener('click', closeComposer);
$('composerCancel').addEventListener('click', closeComposer);
$('composerSubmit').addEventListener('click', submitComposer);
$('cAddBtn').addEventListener('click', composerAddChange);
$('cOpPicker').addEventListener('click', (e) => { const c = e.target.closest('.op-chip'); if (c) setOperation(c.dataset.op); });
$('cDirWrap').addEventListener('click', (e) => { const p = e.target.closest('.dir-pill'); if (p) p.classList.toggle('active'); });
$('cChanges').addEventListener('click', (e) => { const x = e.target.closest('.cc-x'); if (x) { state.composer.changes.splice(Number(x.dataset.cc), 1); renderComposerChanges(); } });
// remove a selected token (chip) from a combo
['cConfChips', 'cPanelChips'].forEach((id) => $(id).addEventListener('click', (e) => {
  const x = e.target.closest('.tok-x'); if (!x) return;
  state.composer.sel[x.dataset.field].splice(Number(x.dataset.i), 1);
  renderChips(x.dataset.field); updateAddCount();
}));
// conference combo (multi-select): scoped to the selected panels' memberships for
// remove / change-direction; otherwise all conferences (plus any created here).
attachCombo('cConfInput', 'cConfList', () => {
  const op = state.composer ? state.composer.op : 'add_member';
  if (PANEL_SCOPED.has(op)) {
    const set = new Set();
    for (const pn of state.composer.sel.panel) for (const cn of panelConferences(pn)) set.add(cn);
    return [...set];
  }
  return [...new Set([...stagedNewConfs(), ...((state.data && state.data.conferences || []).map((c) => c.name))])];
}, { field: 'conf', multi: confMulti, emptyHint: () => (state.composer && PANEL_SCOPED.has(state.composer.op) && !state.composer.sel.panel.length) ? 'Pick a panel first' : null });
attachCombo('cPanelInput', 'cPanelList', () => (state.data && state.data.panels || []).map((p) => p.name), { field: 'panel', multi: () => true });
// Close the (fixed) dropdowns when the MODAL scrolls — but not when the list
// itself is being scrolled (that would make it vanish as you scroll the options).
$('composer').addEventListener('scroll', (e) => {
  if (e.target && e.target.closest && e.target.closest('.combo-list')) return;
  document.querySelectorAll('.combo-list').forEach((l) => l.classList.add('hidden'));
}, true);
$('composer').addEventListener('click', (e) => { if (e.target.id === 'composer') closeComposer(); });
// contextual request buttons + pending-box request links in the detail views
function detailRequestClick(e) {
  const rc = e.target.closest('[data-reqconf]'); if (rc) { openComposer({ conference: rc.dataset.reqconf, op: 'add_member' }); return; }
  const rp = e.target.closest('[data-reqpanel]'); if (rp) { openComposer({ panel: rp.dataset.reqpanel, op: 'add_member' }); return; }
  const gr = e.target.closest('[data-goreq]'); if (gr) { e.preventDefault(); showView('requests'); selectRequest(Number(gr.dataset.goreq)); }
}
els.confDetail.addEventListener('click', detailRequestClick);
els.panelDetail.addEventListener('click', detailRequestClick);

// --- settings wiring ---
els.settingsWrap.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-section]');
  if (nav) { state.setSection = nav.dataset.section; applySettings(); renderSettings(); return; }  // applySettings reverts any unsaved theme preview
  const seg = e.target.closest('[data-theme-pick]');
  if (seg) { onThemePick(seg); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.tagName === 'A') e.preventDefault();
  settingsAction(b.dataset.act, b);
});
// Enable a section's Save the moment anything in the panel changes.
els.settingsWrap.addEventListener('input', markSettingsDirty);
els.settingsWrap.addEventListener('change', (e) => {
  const act = e.target.closest && e.target.closest('[data-act]');
  if (act && act === e.target) { settingsAction(act.dataset.act, act); return; }  // e.g. the user-role select
  markSettingsDirty();
});
els.logoFile.addEventListener('change', () => { const f = els.logoFile.files[0]; if (f) onLogoFile(f); els.logoFile.value = ''; });
// auth / account modal (event-delegated since the body is re-rendered)
$('authClose').addEventListener('click', closeAuthModal);
$('authModal').addEventListener('click', (e) => { if (e.target.id === 'authModal') closeAuthModal(); });
$('authBody').addEventListener('submit', (e) => { if (e.target.id === 'authForm') doLogin(e); });
$('authBody').addEventListener('click', (e) => {
  if (e.target.closest('#authSso')) startSso();
  else if (e.target.closest('#authLogout')) doLogout();
  else if (e.target.closest('#authReveal')) {
    const w = document.getElementById('authLocalWrap'); if (w) w.classList.remove('hidden');
    const u = document.getElementById('authUser'); if (u) u.focus();
  }
});
renderWho();

// ============================================================================
// SETTINGS — shared deployment configuration (engineer-gated writes)
// ============================================================================
const SET_AUTO_CHOICES = [[0, 'Off'], [10, '10s'], [30, '30s'], [60, '1m'], [300, '5m']];
const SET_THEMES = [['dark', 'Dark'], ['light', 'Light']];
const SET_VIEWS = [['matrix', 'Matrix'], ['conferences', 'Conferences'], ['panels', 'Panels'], ['requests', 'Requests'], ['workorder', 'Work order']];
const SET_DATEFMT = [['short', 'Short (6/12/26)'], ['medium', 'Medium (12 Jun 2026)'], ['long', 'Long (June 12, 2026)']];
const SET_ROLES = [['viewer', 'Viewer'], ['editor', 'Editor'], ['admin', 'Admin']];

let logoDraft = null;   // null = unchanged, '' = cleared, string = new data-URI
let settingsTried = false;   // guards the lazy-load against an infinite retry loop

// Authenticated write — the session cookie rides along automatically (same-origin
// fetch), so the server's can() gate sees the real signed-in role.
async function apiWrite(path, method, body) {
  const r = await fetch(rel(path), { method, headers: { 'Content-Type': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

async function loadSettings() {
  settingsTried = true;
  try { state.settings = await api('/api/settings'); } catch { state.settings = null; }
  return state.settings;
}

function setMsg(text, ok) {
  const el = document.getElementById('setMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'set-msg' + (text ? (ok ? ' ok' : ' bad') : '');
  if (text && ok) setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'set-msg'; } }, 2500);
}

// Persist a partial patch, refresh local copy, re-apply branding/theme, re-render.
async function saveSettingsPatch(patch, okMsg) {
  try {
    state.settings = await apiWrite('/api/settings', 'PATCH', patch);
    logoDraft = null;
    applySettings();
    renderSettings();
    setMsg(okMsg || 'Saved.', true);
  } catch (e) { setMsg('Could not save: ' + e.message, false); }
}

const setOpt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('');

const SET_SECTIONS = [
  { key: 'systems', icon: '⛓', label: 'Systems', sub: 'Connections & sources' },
  { key: 'branding', icon: '✦', label: 'Branding', sub: 'Identity & logo' },
  { key: 'display', icon: '◐', label: 'Display', sub: 'Defaults & theme' },
  { key: 'safety', icon: '⌁', label: 'Safety', sub: 'RRCS · login' },
  { key: 'users', icon: '⚇', label: 'Users', sub: 'Accounts & SSO' },
];

// Local accounts for the Users section (admin-only endpoint; tolerate 403/anon).
async function loadUsers() {
  if (!isAdmin()) { state.users = null; return; }
  try { state.users = (await api('/api/users')).users || []; } catch { state.users = null; }
  return state.users;
}

// A styled on/off switch (CSS-only; the checkbox stays the source of truth).
const tgl = (id, on, label, sub, dis) =>
  `<label class="tgl${dis ? ' off' : ''}"><input type="checkbox" id="${id}"${on ? ' checked' : ''}${dis} />
    <span class="tgl-track"><span class="tgl-knob"></span></span>
    <span class="tgl-text"><b>${label}</b>${sub ? `<span>${sub}</span>` : ''}</span></label>`;

// A section footer with a Save button that the dirty-tracker enables on edit.
const saveBar = (act, label) =>
  `<div class="set-savebar"><span class="set-savestate" id="setSaveState">No unsaved changes</span><button class="btn primary" data-act="${act}" data-save disabled>${label}</button></div>`;

function renderSettings() {
  const wrap = els.settingsWrap; if (!wrap) return;
  const s = state.settings;
  if (!s) {
    if (settingsTried) { wrap.innerHTML = '<div class="set-unavail">⚠ Settings unavailable — the server didn’t respond. If you just updated the app, restart <code>node server.js</code>.</div>'; return; }
    wrap.innerHTML = '<div class="set-unavail">Loading settings…</div>';
    loadSettings().then(renderSettings);   // fetch once, then re-render
    return;
  }
  const eng = isAdmin();
  const dis = eng ? '' : ' disabled';
  const sysList = state.systems || [];
  const sec = state.setSection || 'systems';

  const rolePill = eng
    ? `<button class="rolepill eng" data-act="open-who" title="Account"><span class="rp-dot"></span>${esc(myName() || 'admin')}<span class="rp-role">admin</span></button>`
    : isAuthed()
      ? `<button class="rolepill ro" data-act="open-who" title="Account"><span class="rp-ic">🔒</span>Read-only<span class="rp-cta">${esc(myRole())}</span></button>`
      : `<button class="rolepill ro" data-act="open-who" title="Sign in"><span class="rp-ic">🔒</span>Read-only<span class="rp-cta">sign in</span></button>`;

  const nav = SET_SECTIONS.map((x) => `
    <button class="setnav${x.key === sec ? ' active' : ''}" data-section="${x.key}">
      <span class="setnav-ic">${x.icon}</span>
      <span class="setnav-tx"><b>${esc(x.label)}</b><span>${esc(x.sub)}</span></span>
      ${x.key === 'systems' ? `<span class="setnav-badge">${sysList.length}</span>` : ''}
      ${x.key === 'users' && state.users ? `<span class="setnav-badge">${state.users.length}</span>` : ''}
    </button>`).join('');

  const panels = {
    systems: secSystems(s, eng, dis, sysList),
    branding: secBranding(s, eng, dis, sysList),
    display: secDisplay(s, eng, dis),
    safety: secSafety(s, eng, dis),
    users: secUsers(s, eng, dis),
  };
  if (sec === 'users' && eng && state.users === null) loadUsers().then(renderSettings);  // lazy-load accounts

  wrap.innerHTML = `
    <div class="set-top">
      <div class="set-top-l">
        <span class="set-top-ic">⚙</span>
        <div><h2>Settings</h2><p class="set-top-sub">Deployment configuration · shared across all clients</p></div>
      </div>
      <div class="set-top-r"><span class="set-msg" id="setMsg"></span>${rolePill}</div>
    </div>
    <div class="set-shell">
      <nav class="set-nav">${nav}</nav>
      <section class="set-panel" id="setPanel">${panels[sec] || ''}</section>
    </div>`;

  // The Systems detail embeds the print version/diff UI (dynamic ids) — re-cache
  // its elements, re-bind drag-drop, and render the selected system's versions.
  if (sec === 'systems' && state.sysSel && state.sysSel !== '__new__') {
    cacheSourceEls(); wireSourceDrop();
    const selSys = (state.systems || []).find((x) => x.id === state.sysSel);
    if (selSys) renderVersions((selSys.print && selSys.print.history) || []);
  }
}

// section scaffold: header (title + lead) over a body
const secHead = (title, lead) => `<header class="sec-head"><h3>${title}</h3><p>${lead}</p></header>`;

const sysStatusCls = (sy) => sy.ok ? (sy.stale ? 'warn' : 'ok') : 'off';
const srcBadge = (loaded) => loaded ? '<span class="pill both tiny">loaded</span>' : '<span class="pill muted tiny">none</span>';

// Systems — two-pane master/detail. The list (left) selects a system; the detail
// (right) manages that one system's live connection (RRCS) + offline sources,
// independent of the header's active system. All per-system status comes from
// /api/systems (state.systems), so no extra fetch is needed to browse.
function secSystems(s, eng, dis, sysList) {
  const lead = 'Each intercom system the viewer switches between — its live <b>RRCS controller</b> and its <b>offline sources</b>. Pick one to manage it.';
  if (!sysList.length && state.sysSel !== '__new__') {
    return `${secHead('Systems', lead)}<div class="sec-empty">No systems defined yet.</div>${eng ? '<button class="btn small" data-act="sys-add-open">+ Add system</button>' : ''}`;
  }
  // keep a valid selection (prefer the header-active one on first open)
  if (state.sysSel !== '__new__' && !sysList.some((x) => x.id === state.sysSel)) {
    state.sysSel = (sysList.find((x) => x.id === state.system) || sysList[0] || {}).id || null;
  }
  const rows = sysList.map((sy) => `
    <button class="sysrow${sy.id === state.sysSel ? ' active' : ''}" data-act="sys-select" data-sys="${esc(sy.id)}">
      <span class="sys-dot ${sysStatusCls(sy)}"></span>
      <span class="sysrow-tx"><b>${esc(sy.name)}</b><span>${esc(sy.id)}</span></span>
      <span class="sys-src src-${esc(sy.source || 'offline')}">${esc(sy.source || 'offline')}</span>
    </button>`).join('');

  const sel = sysList.find((x) => x.id === state.sysSel);
  const detail = state.sysSel === '__new__'
    ? secSysAddForm()
    : (sel ? secSysDetail(sel, eng) : '<div class="sec-empty">Select a system on the left.</div>');

  return `${secHead('Systems', lead)}
    <div class="sysmd">
      <aside class="sysmd-list">
        <div class="sysmd-rows">${rows}</div>
        ${eng ? `<button class="btn small sysmd-add${state.sysSel === '__new__' ? ' active' : ''}" data-act="sys-add-open">+ Add system</button>` : ''}
      </aside>
      <div class="sysmd-detail">${detail}</div>
    </div>`;
}

function secSysAddForm() {
  return `<div class="sysd-head"><h3>Add a system</h3></div>
    <div class="sysd-body">
      <label class="fl"><span>System id <span class="muted">(permanent — keys stored prints &amp; requests)</span></span><input id="ssNewId" placeholder="studio-d" spellcheck="false" /></label>
      <label class="fl"><span>Display name</span><input id="ssNewName" placeholder="Studio C" /></label>
      <label class="fl"><span>Controller IP <span class="muted">(optional — add an offline source later)</span></span><input id="ssNewHost" placeholder="10.x.x.x" spellcheck="false" /></label>
    </div>
    <div class="set-savebar"><button class="btn ghost" data-act="sys-add-cancel">Cancel</button><span class="grow"></span><button class="btn primary" data-act="sys-add">Create system</button></div>`;
}

// Detail for one system: identity + connection (RRCS) + offline sources.
function secSysDetail(sys, eng) {
  const ed = isEditor();
  const dis = eng ? '' : ' disabled';
  const statusTxt = sys.ok ? (sys.stale ? 'stale — showing cached data' : 'live') : (sys.error || 'no data yet');
  const counts = (sys.ok && sys.counts) ? ` · ${sys.counts.panels} panels · ${sys.counts.conferences} conferences` : '';

  const head = `
    <div class="sysd-head">
      <span class="sys-dot ${sysStatusCls(sys)}"></span>
      <input class="ss-name sysd-name" value="${esc(sys.name)}" aria-label="System name"${dis} />
      <span class="sys-id">${esc(sys.id)}</span>
      <span class="grow"></span>
      <button class="iconbtn" data-act="export-xlsx" title="Export this system to Excel">⬇</button>
      ${eng ? `<button class="iconbtn" data-act="sys-up" title="Move up">↑</button>
        <button class="iconbtn" data-act="sys-down" title="Move down">↓</button>
        <button class="btn small danger" data-act="sys-del">Delete</button>` : ''}
    </div>`;

  const conn = `
    <section class="sysd-sec">
      <div class="sysd-sec-h"><h4>Connection · RRCS</h4><span class="sys-src src-${esc(sys.source)}">${esc(sys.source)}</span></div>
      <p class="sysd-note">The live source — the viewer polls this controller (read-only <code>Get*</code> only).</p>
      <div class="sysd-conn">
        <label class="fl"><span>Controller IP</span><input class="ss-host" value="${esc(sys.host || '')}" placeholder="(none — offline only)" spellcheck="false"${dis} /></label>
        <label class="fl"><span>Port</span><input class="ss-port" type="number" value="${esc(sys.port || 8193)}"${dis} /></label>
      </div>
      <div class="sysd-status"><span class="sys-dot ${sysStatusCls(sys)}"></span>${esc(statusTxt)}${counts}</div>
      ${eng ? '<div class="sysd-bar"><button class="btn small primary" data-act="sys-save">Save connection</button></div>' : ''}
    </section>`;

  const print = sys.print || { loaded: false, history: [] };
  const cfg = sys.config || { loaded: false };
  const topo = sys.topology || { loaded: false };
  const vsp = sys.vsp || { loaded: false };
  const dz = ed ? `<div class="dropzone" id="srcDrop">
        <div class="dz-icon">⤓</div><p>Drop a print <b>PDF</b> / <b>.txt</b>, or</p>
        <button class="btn primary small" data-act="src-print-pick">Choose file…</button>
        <div class="src-msg" id="srcPrintMsg"></div></div>` : '';

  const printItem = `
    <div class="srcitem">
      <div class="srcitem-h"><span class="srcitem-t">config print</span>${srcBadge(print.loaded)}<span class="grow"></span>${ed && print.loaded ? '<button class="btn small ghost" data-act="src-print-clear">Clear</button>' : ''}</div>
      <div class="srcitem-meta${print.loaded ? '' : ' muted'}">${print.loaded ? `<b>${esc(print.name)}</b> · v${print.versionId} · ${print.conferences} conf · ${print.keyAssignments} keys${print.truncated ? ` · <span class="bad">${print.truncated} truncated (print A3)</span>` : ''}` : 'Offline matrix source from a “Group &amp; Conference List” print.'}</div>
      ${dz}
      <div id="srcPrintVersions"></div>
      <div id="srcPrintDiff" class="diff"></div>
    </div>`;
  const fileItem = (title, sub, info, meta, pickAct, clearAct) => `
    <div class="srcitem">
      <div class="srcitem-h"><span class="srcitem-t">${title} <span class="muted">${sub}</span></span>${srcBadge(info.loaded)}<span class="grow"></span>${ed ? `<button class="btn small" data-act="${pickAct}">${info.loaded ? 'Replace' : 'Upload'}</button>${info.loaded ? `<button class="btn small ghost" data-act="${clearAct}">Clear</button>` : ''}` : ''}</div>
      <div class="srcitem-meta${info.loaded ? '' : ' muted'}">${info.loaded ? meta : sub}</div>
    </div>`;
  const cfgItem = fileItem('Key-access', '.Art / .ash', cfg, cfg.loaded ? `${esc(cfg.name)} · ${cfg.keys || 0} keys` : 'Adds programmed-key reachability on top of RRCS membership.', 'src-cfg-pick', 'src-cfg-clear');
  const topoItem = fileItem('Topology', 'node / card tree', topo, topo.loaded ? `${esc(topo.name || '—')} · ${topo.nodes || 0} nodes · ${topo.cards || 0} cards` : 'Groups &amp; filters panels by node and card.', 'src-topo-pick', 'src-topo-clear');
  const vspItem = `
    <div class="srcitem">
      <div class="srcitem-h"><span class="srcitem-t">Virtual system export</span>${srcBadge(vsp.loaded)}</div>
      <div class="srcitem-meta${vsp.loaded ? '' : ' muted'}">${vsp.loaded ? esc(vsp.name) : 'A VSP export JSON (configured by a file path below).'}</div>
    </div>`;

  const adv = eng ? `
    <details class="sysd-adv">
      <summary>Advanced — server file paths <span class="muted">(for pre-baked deployments)</span></summary>
      <div class="sysd-adv-b">
        <label class="fl"><span>Key-access path</span><input class="ss-config" value="${esc(sys.configPath || '')}" placeholder=".Art / .ash path on the server" /></label>
        <label class="fl"><span>Topology path</span><input class="ss-topology" value="${esc(sys.topologyPath || '')}" placeholder="node-tree .txt path" /></label>
        <label class="fl"><span>VSP export path</span><input class="ss-vsp" value="${esc(sys.vspPath || '')}" placeholder="vsp-export.json path" /></label>
      </div>
      <div class="sysd-bar"><button class="btn small primary" data-act="sys-save">Save paths</button></div>
    </details>` : '';

  return `${head}
    <div class="sysd-body">
      ${conn}
      <section class="sysd-sec">
        <div class="sysd-sec-h"><h4>Offline sources</h4></div>
        <p class="sysd-note">Used when there's no live controller, or to layer key-access on top of RRCS. ${ed ? '' : 'Sign in as an <b>editor</b> to upload.'}</p>
        ${printItem}
        ${cfgItem}
        ${topoItem}
        ${vspItem}
      </section>
      ${adv}
    </div>`;
}

function secBranding(s, eng, dis, sysList) {
  const logoUri = logoDraft != null ? logoDraft : (s.branding.logoDataUri || '');
  return `${secHead('Branding', 'How this deployment presents itself to the customer.')}
    <div class="sec-body">
      <label class="fl"><span>Site name</span><input id="stSiteName" value="${esc(s.branding.siteName)}"${dis} /></label>
      <label class="fl"><span>Subtitle</span><input id="stSubtitle" value="${esc(s.branding.subtitle)}"${dis} /></label>
      <div class="fl2">
        <label class="fl"><span>Default system</span><select id="stDefaultSystem"${dis}><option value="">— first available —</option>${setOpt(sysList.map((x) => [x.id, x.name]), s.branding.defaultSystem)}</select></label>
        <label class="fl"><span>Default landing view</span><select id="stDefaultView"${dis}>${setOpt(SET_VIEWS, s.branding.defaultView)}</select></label>
      </div>
      <div class="fl"><span>Logo</span>
        <div class="logo-row">
          <div class="logo-prev ${logoUri ? '' : 'empty'}">${logoUri ? `<img src="${esc(logoUri)}" alt="logo preview" />` : '<span>no logo</span>'}</div>
          ${eng ? `<div class="logo-act">
            <button class="btn small" data-act="logo-pick">Upload…</button>
            ${logoUri ? '<button class="btn small ghost" data-act="logo-clear">Remove</button>' : ''}
            <span class="muted">PNG · SVG · JPEG, ≤ 512 KB. Replaces the brand dot.</span>
          </div>` : ''}
        </div>
      </div>
    </div>
    ${eng ? saveBar('save-branding', 'Save branding') : ''}`;
}

function secDisplay(s, eng, dis) {
  const seg = (cur) => SET_THEMES.map(([v, l]) =>
    `<button class="seg-btn${v === cur ? ' active' : ''}" data-theme-pick="${v}"${dis}>${l}</button>`).join('');
  return `${secHead('Display defaults', 'Applied to every client on first load. Each viewer can still override in-session from the header.')}
    <div class="sec-body">
      <div class="fl2">
        <label class="fl"><span>Default auto-refresh</span><select id="stAuto"${dis}>${setOpt(SET_AUTO_CHOICES, s.display.autoRefreshSec)}</select></label>
        <label class="fl"><span>Date format</span><select id="stDateFmt"${dis}>${setOpt(SET_DATEFMT, s.display.dateFormat)}</select></label>
      </div>
      <div class="fl"><span>Theme</span><div class="seg" id="stThemeSeg" data-theme="${esc(s.display.theme)}">${seg(s.display.theme)}</div></div>
      <div class="tgl-group">
        ${tgl('stPanelsOnly', s.display.matrixPanelsOnly, 'Matrix opens to panels only', 'Hide non-panel ports by default', dis)}
        ${tgl('stKeyAccess', s.display.matrixKeyAccess, 'Matrix shows key-access', 'Overlay programmed-key reachability', dis)}
      </div>
    </div>
    ${eng ? saveBar('save-display', 'Save display defaults') : ''}`;
}

function secSafety(s, eng, dis) {
  return `${secHead('Safety', 'Live-polling and access controls, shared across all clients.')}
    <div class="sec-body">
      <div class="tgl-group">
        ${tgl('stRrcs', s.safety.rrcsEnabled, 'RRCS live polling', 'Off = print / offline only — no network calls', dis)}
        ${tgl('stRequireLogin', s.safety.requireLogin, 'Require login', 'When on, nobody sees data without signing in. Off = anonymous read-only.', dis)}
      </div>
      <label class="fl fl-narrow"><span>Minimum refresh interval (seconds)</span><input id="stMinRefresh" type="number" min="3" max="3600" value="${esc(s.safety.minRefreshSec)}"${dis} /></label>
      <p class="sec-note">⚠ Lowering the interval increases controller load. RRCS is hard-locked to read-only <code>Get*</code> calls regardless of this toggle.</p>
      ${eng ? `<div class="sec-subaction"><button class="btn" data-act="rerun-setup">↻ Re-run setup wizard</button><span class="sec-note" style="margin:0">Replay the guided first-run walkthrough (won’t delete anything).</span></div>` : ''}
    </div>
    ${eng ? saveBar('save-safety', 'Save safety') : ''}`;
}

// ---- in-app LDAP/SAML connection config (admin) ----------------------------
// [key, label, type, placeholder]. type: text | bool | pem | secret | secretpem
const LDAP_FORM = [
  ['url', 'LDAP URL', 'text', 'ldaps://dc.example.com:636'],
  ['bindDn', 'Service-account bind DN', 'text', 'cn=svc,ou=svc,dc=corp,dc=com'],
  ['bindPassword', 'Bind password', 'secret', ''],
  ['baseDn', 'Base DN', 'text', 'dc=corp,dc=com'],
  ['userSearchBase', 'User search base (optional)', 'text', ''],
  ['userFilter', 'User filter', 'text', '(sAMAccountName={{username}})'],
  ['groupAdmin', 'Admin group', 'text', 'cn=it-admins,dc=corp,dc=com'],
  ['groupEditor', 'Editor group', 'text', ''],
  ['groupViewer', 'Viewer group', 'text', ''],
  ['tlsVerify', 'Verify TLS certificate', 'bool', ''],
  ['startTls', 'Use StartTLS (for ldap://)', 'bool', ''],
  ['tlsCa', 'CA certificate — PEM (optional, for private CAs)', 'pem', '-----BEGIN CERTIFICATE-----'],
  ['fingerprint', 'TLS cert SHA-256 fingerprint (optional pin)', 'text', ''],
];
const SAML_FORM = [
  ['entryPoint', 'IdP login URL (entry point)', 'text', 'https://login.microsoftonline.com/<tenant>/saml2'],
  ['issuer', 'SP entity ID (issuer)', 'text', 'intercom-matrix'],
  ['callbackUrl', 'ACS / callback URL', 'text', 'https://your-host/api/auth/saml/acs'],
  ['idpCert', 'IdP signing certificate — PEM', 'pem', '-----BEGIN CERTIFICATE-----'],
  ['groupsAttribute', 'Groups / roles claim attribute', 'text', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'],
  ['groupAdmin', 'Admin group / role value', 'text', 'admin'],
  ['groupEditor', 'Editor group / role value', 'text', 'editor'],
  ['groupViewer', 'Viewer group / role value', 'text', 'viewer'],
  ['usernameAttribute', 'Username attribute (optional)', 'text', ''],
  ['displayNameAttribute', 'Display-name attribute (optional)', 'text', ''],
  ['nameIdFormat', 'NameID format', 'text', ''],
  ['signatureAlgorithm', 'Signature algorithm', 'text', 'sha256'],
  ['wantAssertionsSigned', 'Require signed assertions', 'bool', ''],
  ['wantAuthnResponseSigned', 'Require signed responses', 'bool', ''],
  ['spCert', 'SP certificate — PEM (optional)', 'pem', ''],
  ['spPrivateKey', 'SP private key — PEM (optional, secret)', 'secretpem', ''],
  ['logoutUrl', 'IdP logout URL (optional)', 'text', ''],
];

async function loadAuthConfig() {
  try { state.authConfig = await api('/api/auth-config'); } catch { state.authConfig = null; }
  return state.authConfig;
}

// Collect form values for PATCH/test. Secrets: blank = omit (keep current).
function collectAcf(form) {
  const body = {};
  for (const [key, , type] of form) {
    const el = document.getElementById('acf_' + key);
    if (!el) continue;
    if (type === 'bool') body[key] = el.checked;
    else if (type === 'secret' || type === 'secretpem') { if (el.value !== '') body[key] = el.value; }
    else body[key] = el.value;
  }
  return body;
}

function acfField([key, label, type, ph], red) {
  const r = red[key] || {};
  const src = r.source === 'env' ? ' <span class="acf-src">from env</span>' : '';
  if (type === 'bool') return `<label class="set-chk"><input type="checkbox" id="acf_${key}"${r.value === true ? ' checked' : ''} /> ${esc(label)}${src}</label>`;
  if (type === 'pem') return `<label class="fl"><span>${esc(label)}${src}</span><textarea id="acf_${key}" class="acf-pem" placeholder="${esc(ph)}" spellcheck="false">${esc(r.value || '')}</textarea></label>`;
  if (type === 'secret') return `<label class="fl"><span>${esc(label)}${src}</span><input type="password" id="acf_${key}" autocomplete="new-password" placeholder="${r.hasValue ? '•••••• set — blank keeps it' : 'not set'}" /></label>`;
  if (type === 'secretpem') return `<label class="fl"><span>${esc(label)}${src}</span><textarea id="acf_${key}" class="acf-pem" spellcheck="false" placeholder="${r.hasValue ? '•••••• set — blank keeps it; paste PEM to replace' : 'paste PEM private key'}"></textarea></label>`;
  return `<label class="fl"><span>${esc(label)}${src}</span><input type="text" id="acf_${key}" value="${esc(r.value || '')}" placeholder="${esc(ph)}" spellcheck="false" /></label>`;
}

function secAuthCfgForm(section) {
  const form = section === 'ldap' ? LDAP_FORM : SAML_FORM;
  const red = (state.authConfig && state.authConfig[section]) || {};
  const title = section === 'ldap' ? 'LDAP / Active Directory' : 'SAML single sign-on';
  return `${secHead(title, 'Connection details, configured in-app. Secrets are <b>encrypted at rest</b> and never sent back — leave a secret field blank to keep the current value. Values inherited from env show “from env” until you override them.')}
    <div class="sec-body acf-form">${form.map((f) => acfField(f, red)).join('')}</div>
    <div class="acf-msg" id="acfMsg"></div>
    <div class="set-savebar acf-bar">
      <button class="btn ghost" data-act="cfg-back">‹ Back</button>
      <span class="grow"></span>
      ${section === 'ldap' ? '<button class="btn" data-act="test-ldap">Test connection</button>' : ''}
      <button class="btn primary" data-act="save-authcfg">Save connection</button>
    </div>`;
}

// Users section: local username/password accounts (admin-managed) + per-method
// sign-in toggles (Local / LDAP / SAML) + in-app connection config. A method can
// only be turned on once configured (in-app or env).
function secUsers(s, eng, dis) {
  if (eng && state.authCfgEdit) return secAuthCfgForm(state.authCfgEdit);
  const a = state.auth || {};
  const m = a.authMethods || { local: { configured: true, enabled: true }, ldap: { configured: false, enabled: false }, saml: { configured: false, enabled: false } };
  const initial = (n) => (String(n || '?').trim()[0] || '?').toUpperCase();

  // Read-only status (non-admin) vs editable toggles (admin).
  const statusRow = (label, on, note) =>
    `<div class="sso-row"><span class="sso-dot ${on ? 'on' : 'off'}"></span><b>${esc(label)}</b><span class="sso-state">${on ? 'enabled' : 'disabled'}</span><span class="muted">${esc(note)}</span></div>`;
  const methodToggle = (id, meth, label, sub, cfgHint) => {
    const lockedOff = !meth.configured;   // can't enable an unconfigured method
    const dattr = (lockedOff || dis) ? ' disabled' : '';   // tgl expects a disabled string
    return tgl(id, meth.enabled, label, lockedOff ? cfgHint : sub, dattr);
  };

  const ssoPanel = eng ? `
    <div class="sso-panel">
      <div class="sso-panel-h">Sign-in methods</div>
      <div class="tgl-group">
        ${methodToggle('stAuthLocal', m.local, 'Local accounts', 'Username / password, managed below', '')}
        ${methodToggle('stAuthLdap', m.ldap, 'LDAP / Active Directory', m.ldap.configured ? 'Directory credentials' : '', 'Configure a connection below to enable')}
        ${methodToggle('stAuthSaml', m.saml, 'SAML single sign-on', m.saml.configured ? 'Redirect to your IdP' : '', 'Configure a connection below to enable')}
      </div>
      <div class="acf-buttons">
        <button class="btn small" data-act="cfg-ldap">⚙ Configure LDAP…</button>
        <button class="btn small" data-act="cfg-saml">⚙ Configure SAML…</button>
      </div>
      <p class="sec-note">Configure connections in-app (secrets <b>encrypted at rest</b>) or via env — see <code>.env.example</code>. The switches decide which configured methods are <b>offered</b>; the env bootstrap admin always works as a recovery path.</p>
      ${saveBar('save-auth', 'Save sign-in methods')}
    </div>` : `
    <div class="sso-panel">
      ${statusRow('Local accounts', !!a.localEnabled, 'username / password')}
      ${statusRow('LDAP / Active Directory', !!a.ldapEnabled, a.ldapEnabled ? 'directory credentials' : 'off / not configured')}
      ${statusRow('SAML single sign-on', !!a.samlEnabled, a.samlEnabled ? 'IdP configured' : 'off / not configured')}
    </div>`;

  if (!eng) {
    return `${secHead('Users', 'Local accounts and single sign-on status.')}
      <div class="sec-body">
        <div class="sec-empty">Sign in as an <b>admin</b> to manage local accounts and sign-in methods.</div>
        ${ssoPanel}
      </div>`;
  }

  let usersBlock;
  if (state.users === null) {
    usersBlock = '<div class="sec-empty">Loading accounts…</div>';
  } else {
    const rows = state.users.map((u) => `
      <div class="usr${u.disabled_at ? ' off' : ''}" data-user="${esc(u.username)}">
        <span class="person-av role-${esc(u.role)}">${esc(initial(u.display_name || u.username))}</span>
        <span class="usr-id"><b>${esc(u.display_name || u.username)}</b><span class="muted">${esc(u.username)}${u.disabled_at ? ' · disabled' : ''}</span></span>
        <select class="usr-role" data-act="user-role" title="Role">${setOpt(SET_ROLES, u.role)}</select>
        <button class="iconbtn" data-act="user-toggle" data-disabled="${u.disabled_at ? 'true' : 'false'}" title="${u.disabled_at ? 'Enable' : 'Disable'}">${u.disabled_at ? '○' : '⏸'}</button>
        <button class="iconbtn danger" data-act="user-del" title="Remove">✕</button>
      </div>`).join('') || '<div class="sec-empty">No local accounts yet — add one below.</div>';
    usersBlock = `<div class="usrlist">${rows}</div>
      <div class="usr-add">
        <input id="nuUser" placeholder="username" autocapitalize="none" spellcheck="false" />
        <input id="nuName" placeholder="Display name" />
        <input id="nuPass" type="password" placeholder="password (≥ 6)" autocomplete="new-password" />
        <select id="nuRole">${setOpt(SET_ROLES, 'viewer')}</select>
        <button class="btn small primary" data-act="user-add">+ Add user</button>
      </div>`;
  }

  return `${secHead('Users', 'Local username/password accounts. LDAP &amp; SAML users sign in via the directory/IdP and aren’t listed here.')}
    <div class="sec-body">
      ${usersBlock}
      ${ssoPanel}
    </div>`;
}

// ---- settings actions ------------------------------------------------------
// Read the open system-detail's editable fields.
function sysDetailValues() {
  const W = els.settingsWrap;
  const g = (sel) => { const n = W.querySelector(sel); return n ? n.value.trim() : undefined; };
  const v = { name: g('.ss-name'), host: g('.ss-host'), port: Number(g('.ss-port')) || undefined };
  const cfg = g('.ss-config'); if (cfg !== undefined) v.config = cfg;
  const topo = g('.ss-topology'); if (topo !== undefined) v.topology = topo;
  const vsp = g('.ss-vsp'); if (vsp !== undefined) v.vsp = vsp;
  return v;
}

async function settingsAction(act, ctx) {
  const W = els.settingsWrap;
  try {
    if (act === 'open-who') { openAuthModal(false); return; }
    if (act === 'rerun-setup') { if (window.Onboarding) window.Onboarding.startManual(); return; }
    if (act === 'export-xlsx') { exportXlsx(ctx); return; }
    if (act === 'src-print-pick') { els.printFile.click(); return; }
    if (act === 'src-cfg-pick') { els.cfgFile.click(); return; }
    if (act === 'src-topo-pick') { els.topoFile.click(); return; }
    if (act === 'src-print-clear') { if (confirm('Clear the config print source for this system?')) await clearPrintFile(); return; }
    if (act === 'src-cfg-clear') { await clearConfig(); return; }
    if (act === 'src-topo-clear') { await clearTopologyFile(); return; }
    if (act === 'logo-pick') { els.logoFile.click(); return; }
    if (act === 'logo-clear') { logoDraft = ''; renderSettings(); return; }

    if (act === 'save-branding') {
      const b = {
        siteName: W.querySelector('#stSiteName').value, subtitle: W.querySelector('#stSubtitle').value,
        defaultSystem: W.querySelector('#stDefaultSystem').value, defaultView: W.querySelector('#stDefaultView').value,
      };
      if (logoDraft != null) b.logoDataUri = logoDraft;
      await saveSettingsPatch({ branding: b }, 'Branding saved.');
      return;
    }
    if (act === 'save-display') {
      const d = {
        autoRefreshSec: Number(W.querySelector('#stAuto').value),
        theme: (W.querySelector('#stThemeSeg') || {}).dataset?.theme || 'dark',
        dateFormat: W.querySelector('#stDateFmt').value,
        matrixPanelsOnly: W.querySelector('#stPanelsOnly').checked, matrixKeyAccess: W.querySelector('#stKeyAccess').checked,
      };
      await saveSettingsPatch({ display: d }, 'Display defaults saved.');
      // reflect new defaults in the live header/matrix controls for the saver
      els.auto.value = String(d.autoRefreshSec); setAuto(d.autoRefreshSec);
      els.mxPanelsOnly.checked = d.matrixPanelsOnly; els.mxKeyAccess.checked = d.matrixKeyAccess;
      return;
    }
    if (act === 'save-safety') {
      const wasOn = state.rrcsEnabled;
      await saveSettingsPatch({ safety: {
        rrcsEnabled: W.querySelector('#stRrcs').checked,
        minRefreshSec: Number(W.querySelector('#stMinRefresh').value),
        requireLogin: W.querySelector('#stRequireLogin').checked,
      } }, 'Safety saved.');
      await reloadSystems();
      if (!wasOn && state.rrcsEnabled) await refreshNow();   // just turned RRCS on
      renderSettings();
      return;
    }

    if (act === 'save-auth') {
      const get = (id) => { const el = W.querySelector('#' + id); return el ? el.checked : undefined; };
      const auth = {};
      // only send toggles that exist + aren't locked (disabled = unconfigured)
      for (const [id, key] of [['stAuthLocal', 'localEnabled'], ['stAuthLdap', 'ldapEnabled'], ['stAuthSaml', 'samlEnabled']]) {
        const el = W.querySelector('#' + id);
        if (el && !el.disabled) auth[key] = el.checked;
      }
      await saveSettingsPatch({ auth }, 'Sign-in methods saved.');
      await loadMe();          // login options changed — refresh capabilities
      renderWho(); renderSettings();
      const m = (state.auth && state.auth.authMethods) || {};
      if (m.local && !m.local.enabled && m.ldap && !m.ldap.enabled && m.saml && !m.saml.enabled) {
        setMsg('All methods off — only the env bootstrap admin can sign in now.', false);
      }
      return;
    }

    // in-app LDAP/SAML connection config
    if (act === 'cfg-ldap' || act === 'cfg-saml') {
      state.authCfgEdit = act === 'cfg-ldap' ? 'ldap' : 'saml';
      if (!state.authConfig) await loadAuthConfig();
      renderSettings();
      return;
    }
    if (act === 'cfg-back') { state.authCfgEdit = null; renderSettings(); return; }
    if (act === 'save-authcfg') {
      const section = state.authCfgEdit;
      const form = section === 'ldap' ? LDAP_FORM : SAML_FORM;
      const body = collectAcf(form);
      try {
        await apiWrite('/api/auth-config/' + section, 'PATCH', body);
        await loadAuthConfig(); await loadMe();
        state.authCfgEdit = null;
        renderWho(); renderSettings();
        setMsg(section.toUpperCase() + ' connection saved.', true);
      } catch (e) { const el = W.querySelector('#acfMsg'); if (el) { el.textContent = 'Save failed: ' + e.message; el.className = 'acf-msg bad'; } }
      return;
    }
    if (act === 'test-ldap') {
      const el = W.querySelector('#acfMsg');
      el.textContent = 'Testing…'; el.className = 'acf-msg';
      try {
        const r = await apiWrite('/api/auth-config/ldap/test', 'POST', collectAcf(LDAP_FORM));
        el.textContent = r.ok ? `✓ ${r.detail || 'Connection OK'}` : `✗ ${r.stage}: ${r.error}`;
        el.className = 'acf-msg ' + (r.ok ? 'ok' : 'bad');
      } catch (e) { el.textContent = '✗ ' + e.message; el.className = 'acf-msg bad'; }
      return;
    }

    // local users (admin only)
    if (act === 'user-add') {
      const body = {
        username: W.querySelector('#nuUser').value.trim(),
        password: W.querySelector('#nuPass').value,
        displayName: W.querySelector('#nuName').value.trim(),
        role: W.querySelector('#nuRole').value,
      };
      if (!body.username || !body.password) { setMsg('Username and password required.', false); return; }
      await apiWrite('/api/users', 'POST', body);
      await loadUsers(); renderSettings(); setMsg(`Added "${body.username}".`, true);
      return;
    }
    if (act === 'user-role') {
      const u = ctx.closest('.usr').dataset.user;
      await apiWrite('/api/users/' + encodeURIComponent(u), 'PATCH', { role: ctx.value });
      await loadUsers(); setMsg(`Updated "${u}".`, true);
      return;
    }
    if (act === 'user-toggle') {
      const row = ctx.closest('.usr'); const u = row.dataset.user;
      await apiWrite('/api/users/' + encodeURIComponent(u), 'PATCH', { disabled: ctx.dataset.disabled !== 'true' });
      await loadUsers(); renderSettings();
      return;
    }
    if (act === 'user-del') {
      const u = ctx.closest('.usr').dataset.user;
      if (!confirm(`Remove user "${u}"? They'll be signed out immediately.`)) return;
      await apiWrite('/api/users/' + encodeURIComponent(u), 'DELETE');
      await loadUsers(); renderSettings(); setMsg(`Removed "${u}".`, true);
      return;
    }

    // --- Systems master/detail ---
    if (act === 'sys-select') { state.sysSel = ctx.dataset.sys; state.cmp = { from: null, to: null }; renderSettings(); return; }
    if (act === 'sys-add-open') { state.sysSel = '__new__'; renderSettings(); return; }
    if (act === 'sys-add-cancel') { state.sysSel = (state.systems[0] || {}).id || null; renderSettings(); return; }
    if (act === 'sys-add') {
      const def = { id: W.querySelector('#ssNewId').value.trim(), name: W.querySelector('#ssNewName').value.trim(), host: W.querySelector('#ssNewHost').value.trim() };
      if (!def.id) { setMsg('Enter an id for the new system.', false); return; }
      await apiWrite('/api/systems', 'POST', def);
      state.sysSel = def.id;
      await reloadSystems(); renderSettings(); setMsg(`Added "${def.id}".`, true);
      return;
    }
    // ops below act on the selected system
    const id = state.sysSel;
    if (act === 'sys-save' && id) {
      await apiWrite('/api/systems/' + encodeURIComponent(id), 'PATCH', sysDetailValues());
      await reloadSystems(); renderSettings(); setMsg(`Saved "${id}".`, true);
      return;
    }
    if (act === 'sys-del' && id) {
      if (!confirm(`Remove system "${id}"? Stored prints/requests are kept, but it disappears from the switcher.`)) return;
      await apiWrite('/api/systems/' + encodeURIComponent(id), 'DELETE');
      if (state.system === id) state.system = null;
      state.sysSel = null;
      await reloadSystems();
      if (!state.system) await switchSystem(state.systems[0] ? state.systems[0].id : null);
      renderSettings(); setMsg(`Removed "${id}".`, true);
      return;
    }
    if ((act === 'sys-up' || act === 'sys-down') && id) {
      const ids = (state.systems || []).map((x) => x.id);
      const i = ids.indexOf(id), j = act === 'sys-up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await apiWrite('/api/systems/reorder', 'PATCH', { order: ids });
      await reloadSystems(); renderSettings();
      return;
    }
  } catch (e) { setMsg('Action failed: ' + e.message, false); }
}

// Re-fetch the systems list and repopulate the header switcher, preserving the
// current selection when it still exists.
async function reloadSystems() {
  const sys = await api('/api/systems');
  state.rrcsEnabled = sys.rrcsEnabled !== false;
  const keep = (state.systems || []).some((x) => x.id === state.system) ? state.system : null;
  populateSystems(sys.systems, keep || sys.default);
  applyRrcsMode();
}

function onLogoFile(file) {
  if (!file) return;
  if (file.size > 512 * 1024) { setMsg('Logo exceeds 512 KB.', false); return; }
  const reader = new FileReader();
  reader.onload = () => { logoDraft = String(reader.result || ''); renderSettings(); markSettingsDirty(); setMsg('Logo selected — Save branding to apply.', true); };
  reader.onerror = () => setMsg('Could not read that file.', false);
  reader.readAsDataURL(file);
}

// Theme segmented control: highlight the pick, live-preview the page, mark dirty.
// (Switching sections or reloading without saving reverts to the stored theme.)
function onThemePick(btn) {
  if (btn.disabled) return;
  const seg = btn.closest('.seg');
  seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  seg.dataset.theme = btn.dataset.themePick;
  document.documentElement.setAttribute('data-theme', btn.dataset.themePick);
  markSettingsDirty();
}

// Enable the active section's Save button + flag unsaved state.
function markSettingsDirty() {
  const panel = document.getElementById('setPanel'); if (!panel) return;
  const btn = panel.querySelector('[data-save]');
  if (btn) btn.disabled = false;
  const st = document.getElementById('setSaveState');
  if (st) { st.textContent = 'Unsaved changes'; st.classList.add('dirty'); }
}

function populateSystems(list, def) {
  state.systems = list;
  els.system.replaceChildren();
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name + (s.configured ? '' : ' ·');
    els.system.appendChild(o);
  }
  state.system = (list.find((s) => s.id === def) || list.find((s) => s.configured) || list[0] || {}).id || def;
  els.system.value = state.system;
}

// When RRCS is disabled server-side, the live controls are meaningless — grey
// out the auto-refresh + Refresh controls.
function applyRrcsMode() {
  const on = state.rrcsEnabled;
  els.refresh.disabled = !on;
  els.auto.disabled = !on;
  els.auto.parentElement.style.opacity = on ? '' : '.4';
  applySubtitle();
}

// Subtitle = the deployment's branding subtitle (no offline-state suffix).
function applySubtitle() {
  // Only fall back to the placeholder before settings load — an empty subtitle
  // (deliberately cleared) must show as empty, not snap back to the default.
  els.subtitle.textContent = state.settings ? (state.settings.branding.subtitle || '') : 'Live intercom matrix';
}

// Swap the brand dot for an uploaded logo (or back).
function applyLogo(uri) {
  const brand = document.querySelector('.brand'); if (!brand) return;
  const dot = brand.querySelector('.dot');
  let img = document.getElementById('brandLogo');
  if (uri) {
    if (!img) { img = document.createElement('img'); img.id = 'brandLogo'; img.alt = ''; brand.insertBefore(img, brand.firstChild); }
    img.src = uri; img.style.display = '';
    if (dot) dot.style.display = 'none';
  } else {
    if (img) img.style.display = 'none';
    if (dot) dot.style.display = '';
  }
}

// Apply shared settings to the live UI. Theme + branding are safe to re-apply
// any time; `boot` also seeds the per-session header/matrix controls and the
// landing view/system (so a later save doesn't yank the user's current view).
function applySettings(boot) {
  const s = state.settings; if (!s) return;
  document.documentElement.setAttribute('data-theme', s.display.theme || 'dark');
  document.title = s.branding.siteName || 'Intercom Matrix';
  const h1 = document.querySelector('.brand h1'); if (h1) h1.textContent = s.branding.siteName || 'Intercom Matrix';
  applyLogo(s.branding.logoDataUri);
  applySubtitle();
  if (boot) {
    if (state.rrcsEnabled) els.auto.value = String(s.display.autoRefreshSec);
    els.mxPanelsOnly.checked = s.display.matrixPanelsOnly;
    els.mxKeyAccess.checked = s.display.matrixKeyAccess;
  }
}

(async function init() {
  try {
    // Auth + branding first: /api/auth/me and /api/settings are reachable even
    // behind the login wall, so the login screen can render the right branding.
    await Promise.all([loadMe(), loadSettings()]);
    applySettings(true);
    renderWho();

    // First-run setup: on a fresh, un-configured deployment the wizard takes over
    // the screen (create admin → add a system → brand → finish) and we stop here;
    // it reloads the page when done so the app boots normally.
    if (window.Onboarding && await window.Onboarding.maybeStart()) {
      els.statusText.textContent = 'First-run setup';
      return;
    }

    // Login wall: if the deployment requires login and we're anonymous, show a
    // non-dismissable sign-in screen and stop — no data is loaded until authed.
    if (state.auth && state.auth.requireLogin && !isAuthed()) {
      els.statusText.textContent = 'Sign in to continue';
      openAuthModal(true);
      return;
    }

    const sys = await api('/api/systems');
    state.rrcsEnabled = sys.rrcsEnabled !== false;
    applyRrcsMode();
    applySettings(true);   // re-apply subtitle now that rrcs state is known
    const def = (state.settings && state.settings.branding.defaultSystem) || sys.default;
    populateSystems(sys.systems, def);
    const view = (state.settings && state.settings.branding.defaultView) || 'matrix';
    if (view !== 'matrix') showView(view);
    await loadSnapshot();
    if (state.rrcsEnabled && (!state.data || !state.data.ok)) await refreshNow();
  } catch (e) {
    els.statusText.textContent = 'Server unreachable: ' + e.message;
  }
  if (state.rrcsEnabled) setAuto(els.auto.value);
})();
