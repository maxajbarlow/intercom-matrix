// public/customers.js — Settings → Customer groups (admin) + the scoped-viewer badge.
//
// A customer group is a set of SOURCE PANELS per system. The admin ticks the
// panels a customer owns (e.g. the FIA Race Control desks); the server derives
// the conferences hosted on them live, so new channels on those panels show up
// for that customer automatically. The live preview here calls the same
// derivation (/api/customers/preview) so what you see is what they'll get.
//
// Loaded BEFORE app.js; everything here is called lazily from app.js, so the
// app.js globals it uses (state, esc, api, apiWrite, secHead, saveBar, setMsg,
// renderSettings, loadUsers) exist by the time any of it runs.

/* global state, esc, api, apiWrite, secHead, saveBar, setMsg, renderSettings, loadUsers, markSettingsDirty, DualList */

const CUST_NEW = '__new__';
const custKey = (sys, addr) => sys + '\u0000' + addr;
const PREVIEW_DEBOUNCE_MS = 250;

function custState() {
  if (!state.cust) state.cust = { list: null, sel: null, draft: null, sys: null, panels: {}, preview: null, dl: freshDl() };
  return state.cust;
}

// Picker UI state: a filter + multi-selection per pane (L = available, R = the
// group) and the shift-click anchor. Reset whenever the customer or system changes.
const freshDl = () => ({ qL: '', qR: '', selL: new Set(), selR: new Set(), anchorL: null, anchorR: null });

async function loadCustomers() {
  const c = custState();
  try { c.list = (await api('/api/customers')).customers || []; } catch { c.list = []; }
  return c.list;
}

function draftFrom(cust) {
  return {
    id: cust ? cust.id : null,
    name: cust ? cust.name : '',
    description: cust ? cust.description : '',
    sources: new Map((cust ? cust.sources : []).map((s) => [custKey(s.system, s.addr), s])),
    users: new Set(cust ? cust.users : []),
    extraUsers: '',
    dirGroups: cust ? cust.dirGroups.join('\n') : '',
  };
}

// Pull typed-but-unsaved field values into the draft before any re-render.
function syncDraftFields() {
  const c = custState(); const d = c.draft; if (!d) return;
  const W = document.getElementById('setPanel'); if (!W) return;
  const v = (sel) => { const n = W.querySelector(sel); return n ? n.value : undefined; };
  if (v('#cuName') !== undefined) d.name = v('#cuName');
  if (v('#cuDesc') !== undefined) d.description = v('#cuDesc');
  if (v('#cuExtraUsers') !== undefined) d.extraUsers = v('#cuExtraUsers');
  if (v('#cuDirGroups') !== undefined) d.dirGroups = v('#cuDirGroups');
}

async function ensurePanels(sysId) {
  const c = custState();
  if (!sysId || c.panels[sysId]) return;
  try { c.panels[sysId] = ((await api('/api/panels?system=' + encodeURIComponent(sysId))).panels || []); }
  catch { c.panels[sysId] = []; }
}

// ---------- render ----------
function secCustomers(eng) {
  const lead = 'Confine a customer to the channels that matter to them. Pick the <b>source panels</b> they own — every conference hosted on those panels is shown to them, including new ones as they’re added. Admins and editors always see everything.';
  if (!eng) return `${secHead('Customer groups', lead)}<div class="sec-empty">Sign in as an <b>admin</b> to manage customer groups.</div>`;
  const c = custState();
  if (c.list === null) { loadCustomers().then(renderSettings); return `${secHead('Customer groups', lead)}<div class="sec-empty">Loading…</div>`; }
  if (state.users === null) loadUsers().then(renderSettings);

  if (c.sel !== CUST_NEW && c.sel != null && !c.list.some((x) => x.id === c.sel)) { c.sel = null; c.draft = null; }
  if (c.sel == null && c.list.length) selectCustomer(c.list[0].id);

  const rows = c.list.map((x) => {
    const systems = new Set(x.sources.map((s) => s.system)).size;
    return `<button class="sysrow${x.id === c.sel ? ' active' : ''}" data-act="cust-select" data-cust="${x.id}">
      <span class="cu-ic">${esc((x.name[0] || '?').toUpperCase())}</span>
      <span class="sysrow-tx"><b>${esc(x.name)}</b><span class="cu-meta">${x.sources.length} panel${x.sources.length === 1 ? '' : 's'} · ${systems} system${systems === 1 ? '' : 's'} · ${x.users.length + x.dirGroups.length} member${x.users.length + x.dirGroups.length === 1 ? '' : 's'}</span></span>
    </button>`;
  }).join('');

  const detail = c.draft ? custDetail(c) : `<div class="sec-empty">${c.list.length ? 'Select a customer group on the left.' : 'No customer groups yet — everyone who can sign in sees every channel. Create one to start scoping.'}</div>`;
  if (c.draft && c.sys && !c.panels[c.sys]) ensurePanels(c.sys).then(() => { renderSettings(); refreshPreview(); });

  return `${secHead('Customer groups', lead)}
    <div class="sysmd">
      <aside class="sysmd-list">
        <div class="sysmd-rows">${rows}</div>
        <button class="btn small sysmd-add${c.sel === CUST_NEW ? ' active' : ''}" data-act="cust-new">+ New customer group</button>
      </aside>
      <div class="sysmd-detail">${detail}</div>
    </div>`;
}

function custDetail(c) {
  const d = c.draft;
  const systems = state.systems || [];
  if (!c.sys || !systems.some((s) => s.id === c.sys)) c.sys = (systems[0] || {}).id || null;

  const perSys = (sid) => [...d.sources.values()].filter((s) => s.system === sid).length;
  const sysTabs = systems.map((s) => `
    <button class="cu-systab${s.id === c.sys ? ' active' : ''}" data-act="cust-sys" data-sys="${esc(s.id)}">
      ${esc(s.name)}${perSys(s.id) ? `<span class="cu-count">${perSys(s.id)}</span>` : ''}
    </button>`).join('');

  const head = `
    <div class="sysd-head">
      <input id="cuName" class="sysd-name" value="${esc(d.name)}" placeholder="Customer name — e.g. FIA Race Control" aria-label="Customer group name" />
      <span class="grow"></span>
      ${d.id ? '<button class="btn small danger" data-act="cust-del">Delete</button>' : ''}
    </div>`;

  return `${head}
    <div class="sysd-body">
      <label class="fl"><span>Description <span class="muted">(optional)</span></span><input id="cuDesc" value="${esc(d.description)}" placeholder="Who this is for" /></label>

      <section class="sysd-sec">
        <div class="sysd-sec-h"><h4>Source panels</h4><span class="muted cu-total">${d.sources.size} selected</span></div>
        <p class="sysd-note">The panels this customer owns. Their conferences — and anyone else on those conferences — become visible to the group.</p>
        ${systems.length ? `<div class="cu-systabs" role="tablist">${sysTabs}</div>` : '<div class="sec-empty">No systems defined.</div>'}
        ${c.sys ? custPanelPicker(c) : ''}
      </section>

      <section class="sysd-sec">
        <div class="sysd-sec-h"><h4>Resolves to</h4><span class="muted" id="cuPreviewCount"></span></div>
        <div class="cu-preview" id="cuPreview" aria-live="polite">${custPreviewHtml(c)}</div>
      </section>

      <section class="sysd-sec">
        <div class="sysd-sec-h"><h4>Members</h4></div>
        <p class="sysd-note">Who is confined to this group. Only <b>viewer</b> accounts are scoped; a viewer in no group sees nothing once any group exists.</p>
        ${custUserPicker(d)}
        <label class="fl"><span>Other usernames <span class="muted">(LDAP / SAML users, comma-separated)</span></span><input id="cuExtraUsers" value="${esc(d.extraUsers)}" placeholder="jsmith, fia.steward" spellcheck="false" autocapitalize="none" /></label>
        <label class="fl"><span>Directory groups <span class="muted">(one per line — LDAP group DN or SAML group claim)</span></span><textarea id="cuDirGroups" rows="3" spellcheck="false" placeholder="CN=FIA-RaceControl,OU=Groups,DC=corp,DC=com">${esc(d.dirGroups)}</textarea></label>
        <p class="sec-note">⚠ A directory group listed here also <b>grants sign-in</b>: every member of it can log in as a viewer, even if they're in no role group. Use a dedicated group, never a broad one like <i>Domain Users</i>.</p>
      </section>
    </div>
    ${saveBar('cust-save', d.id ? 'Save customer group' : 'Create customer group')}`;
}

function custPanelPicker(c) {
  const panels = c.panels[c.sys];
  if (!panels) return '<div class="sec-empty">Loading panels…</div>';
  if (!panels.length) return '<div class="sec-empty">This system has no panel data yet — upload a config print first.</div>';
  const dl = c.dl;
  const pane = (side, title, sub, q, ph) => `
    <div class="dl-pane dl-${side}">
      <div class="dl-head">
        <input type="checkbox" class="dl-all" data-dl-all="${side}" aria-label="Select all shown in ${title}" title="Select all shown" />
        <div class="dl-title"><b>${title}</b><span>${sub}</span></div>
        <span class="dl-count" id="dlCount${side}"></span>
      </div>
      <input class="dl-filter" type="search" data-dl-filter="${side}" value="${esc(q)}" placeholder="${ph}" aria-label="${ph}" autocomplete="off" spellcheck="false" />
      <ul class="dl-list" id="dlList${side}" role="listbox" aria-multiselectable="true" aria-label="${title}"></ul>
    </div>`;
  return `
    <div class="xfer" id="cuDual">
      ${pane('L', 'Available', 'Panels on this system', dl.qL, 'Filter available…')}
      <div class="dl-mid" role="group" aria-label="Move panels">
        <button class="btn dl-btn primary" data-act="cust-dl-add" id="dlAdd"></button>
        <button class="btn dl-btn" data-act="cust-dl-addall" id="dlAddAll"></button>
        <span class="dl-sep" aria-hidden="true"></span>
        <button class="btn dl-btn" data-act="cust-dl-rm" id="dlRm"></button>
        <button class="btn dl-btn" data-act="cust-dl-rmall" id="dlRmAll"></button>
      </div>
      ${pane('R', 'Active group', 'Source panels for this customer', dl.qR, 'Filter group…')}
    </div>
    <p class="dl-hint">Click to select · <kbd>Shift</kbd>-click for a range · double-click, <kbd>Enter</kbd> or a row's arrow moves it across.</p>`;
}

// ---------- dual-list paint (no full re-render: keeps filter focus + scroll) ----------
function dlModel(c) {
  const sources = [...c.draft.sources.values()].filter((s) => s.system === c.sys);
  return DualList.splitSources(c.panels[c.sys] || [], sources);
}
function dlRow(item, side, selected) {
  const n = (item.memberships || []).length;
  const sub = item.missing ? '<span class="dl-warn">not in the current print</span>' : (item.addr !== item.name ? `<span>${esc(item.addr)}</span>` : '');
  const verb = side === 'L' ? 'Add' : 'Remove';
  return `<li class="dl-item${selected ? ' sel' : ''}${item.missing ? ' missing' : ''}" role="option" aria-selected="${selected}" tabindex="0" data-side="${side}" data-key="${esc(item.key)}">
    <span class="dl-check" aria-hidden="true"></span>
    <span class="dl-tx"><b>${esc(item.name)}</b>${sub}</span>
    ${item.missing ? '' : `<span class="dl-n" title="${n} conference${n === 1 ? '' : 's'}">${n}</span>`}
    <button class="dl-move" data-act="cust-dl-one" data-side="${side}" data-key="${esc(item.key)}" tabindex="-1" title="${verb} ${esc(item.name)}" aria-label="${verb} ${esc(item.name)}">${side === 'L' ? '→' : '←'}</button>
  </li>`;
}
function paintList(side, items, q, sel) {
  const ul = document.getElementById('dlList' + side); if (!ul) return;
  const shown = items.filter((i) => DualList.matches(i, q));
  const empty = items.length
    ? 'Nothing matches the filter.'
    : (side === 'L' ? 'Every panel is in the group.' : 'No source panels yet — add some from the left.');
  ul.innerHTML = shown.length ? shown.map((i) => dlRow(i, side, sel.has(i.key))).join('') : `<li class="dl-empty">${empty}</li>`;
}
// Counts + select-all state for one pane (touches no rows).
function paintPaneControls(side, items, q, sel) {
  const shown = items.filter((i) => DualList.matches(i, q));
  const count = document.getElementById('dlCount' + side);
  if (count) count.textContent = q ? `${shown.length} of ${items.length}` : String(items.length);
  const all = document.querySelector(`[data-dl-all="${side}"]`);
  if (all) {
    const nSel = shown.filter((i) => sel.has(i.key)).length;
    all.checked = shown.length > 0 && nSel === shown.length;
    all.indeterminate = nSel > 0 && nSel < shown.length;
    all.disabled = !shown.length;
  }
  return shown;
}
function setBtn(id, label, n) {
  const b = document.getElementById(id); if (!b) return;
  b.textContent = label; b.disabled = !n;
}
// Full paint: rebuild both lists (after a move or a filter change), then controls.
function paintDual() {
  if (!document.getElementById('cuDual')) return;
  const c = custState(); const dl = c.dl;
  const { available, chosen } = dlModel(c);
  paintList('L', available, dl.qL, dl.selL);
  paintList('R', chosen, dl.qR, dl.selR);
  paintControls();
}
// Light paint: selection changed — flip row state in place (the row elements
// survive, so double-click and keyboard focus keep working), then controls.
function paintSelection(side) {
  const sel = custState().dl['sel' + side];
  for (const row of document.querySelectorAll(`#dlList${side} .dl-item`)) {
    const on = sel.has(row.dataset.key);
    row.classList.toggle('sel', on);
    row.setAttribute('aria-selected', String(on));
  }
  paintControls();
}
function paintControls() {
  const c = custState(); const dl = c.dl;
  const { available, chosen } = dlModel(c);
  const shownL = paintPaneControls('L', available, dl.qL, dl.selL);
  const shownR = paintPaneControls('R', chosen, dl.qR, dl.selR);
  const nAdd = DualList.visibleSelected(available, dl.selL, dl.qL).length;
  const nRm = DualList.visibleSelected(chosen, dl.selR, dl.qR).length;
  setBtn('dlAdd', nAdd ? `Add ${nAdd} selected →` : 'Add selected →', nAdd);
  setBtn('dlAddAll', dl.qL ? `Add all ${shownL.length} matching ⇉` : `Add all ${shownL.length} ⇉`, shownL.length);
  setBtn('dlRm', nRm ? `← Remove ${nRm} selected` : '← Remove selected', nRm);
  setBtn('dlRmAll', dl.qR ? `⇇ Remove all ${shownR.length} matching` : `⇇ Remove all ${shownR.length}`, shownR.length);
  // keep the per-system tab badges + total in step with the draft
  const total = document.querySelector('.cu-total'); if (total) total.textContent = `${c.draft.sources.size} selected`;
  for (const tab of document.querySelectorAll('.cu-systab')) {
    const n = [...c.draft.sources.values()].filter((x) => x.system === tab.dataset.sys).length;
    let badge = tab.querySelector('.cu-count');
    if (n && !badge) { badge = document.createElement('span'); badge.className = 'cu-count'; tab.appendChild(badge); }
    if (badge) { if (n) badge.textContent = String(n); else badge.remove(); }
  }
}

// Move the given keys across. side 'L' = add to the group, 'R' = remove from it.
function dlMove(side, keys) {
  const c = custState(); const d = c.draft; if (!d || !keys.length) return;
  const dl = c.dl; const move = new Set(keys);
  const { available, chosen } = dlModel(c);
  if (side === 'L') {
    for (const p of available) if (move.has(p.key)) d.sources.set(custKey(c.sys, p.addr), { system: c.sys, addr: p.addr, name: p.name });
    dl.selL = new Set([...dl.selL].filter((k) => !move.has(k)));
  } else {
    for (const it of chosen) if (move.has(it.key)) d.sources.delete(custKey(c.sys, it.source.addr));
    dl.selR = new Set([...dl.selR].filter((k) => !move.has(k)));
  }
  paintDual(); refreshPreview(); markSettingsDirty();
}
function dlShownKeys(side) {
  const c = custState(); const { available, chosen } = dlModel(c);
  return (side === 'L' ? available : chosen).filter((i) => DualList.matches(i, side === 'L' ? c.dl.qL : c.dl.qR)).map((i) => i.key);
}
function dlSelect(side, key, extendRange) {
  const dl = custState().dl;
  const selKey = 'sel' + side, anchorKey = 'anchor' + side;
  if (extendRange && dl[anchorKey]) dl[selKey] = new Set([...dl[selKey], ...DualList.range(dlShownKeys(side), dl[anchorKey], key)]);
  else { dl[selKey] = DualList.toggle(dl[selKey], key); dl[anchorKey] = key; }
  paintSelection(side);
}

function custUserPicker(d) {
  const locals = state.users || [];
  const localNames = new Set(locals.map((u) => u.username.toLowerCase()));
  // Usernames in the group that aren't local accounts live in the free-text box
  // (split once the local roster has loaded, so none land in both places).
  if (!d._split && state.users) {
    const extra = [...d.users].filter((u) => !localNames.has(u.toLowerCase()));
    if (extra.length && !d.extraUsers) d.extraUsers = extra.join(', ');
    d._split = true;
  }
  if (!locals.length) return '';
  const has = (u) => [...d.users].some((x) => x.toLowerCase() === u.toLowerCase());
  return `<div class="cu-users">${locals.map((u) => {
    const scopable = u.role === 'viewer';
    return `<label class="cu-user${scopable ? '' : ' na'}" title="${scopable ? '' : 'Admins and editors always see everything'}">
      <input type="checkbox" data-act="cust-user" data-user="${esc(u.username)}"${has(u.username) ? ' checked' : ''} />
      <span class="person-av role-${esc(u.role)}">${esc(((u.display_name || u.username)[0] || '?').toUpperCase())}</span>
      <span class="cu-user-tx"><b>${esc(u.display_name || u.username)}</b><span>${esc(u.username)} · ${esc(u.role)}</span></span>
    </label>`;
  }).join('')}</div>`;
}

function custPreviewHtml(c) {
  const p = c.preview;
  const sysName = ((state.systems || []).find((s) => s.id === c.sys) || {}).name || c.sys || '';
  if (!c.sys) return '';
  const selected = [...c.draft.sources.values()].filter((s) => s.system === c.sys).length;
  if (!selected) return `<div class="cu-empty">Tick source panels on <b>${esc(sysName)}</b> to see which conferences this group will see.</div>`;
  if (!p || p.sys !== c.sys) return '<div class="cu-empty">Resolving…</div>';
  if (!p.conferences.length) return `<div class="cu-empty">These panels host no conferences on <b>${esc(sysName)}</b>.</div>`;
  const chips = p.conferences.map((x) => `<span class="cu-chip${x.kind === 'group' ? ' grp' : ''}" title="${esc(x.label || '')}">${esc(x.name)}</span>`).join('');
  return `<div class="cu-summary"><b>${p.conferences.length}</b> conference${p.conferences.length === 1 ? '' : 's'} · <b>${p.panelCount}</b> panel${p.panelCount === 1 ? '' : 's'} visible on ${esc(sysName)}</div><div class="cu-chips">${chips}</div>`;
}

// ---------- live preview ----------
let previewTimer = null;
let previewSeq = 0;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const c = custState(); if (!c.draft || !c.sys) return;
    const sys = c.sys;
    const sources = [...c.draft.sources.values()].filter((s) => s.system === sys);
    const seq = ++previewSeq;
    if (!sources.length) { c.preview = null; paintPreview(); return; }
    try {
      const r = await apiWrite('/api/customers/preview?system=' + encodeURIComponent(sys), 'POST', { sources });
      if (seq !== previewSeq) return;   // a newer toggle superseded this one
      c.preview = { sys, conferences: r.conferences || [], panelCount: r.panelCount || 0 };
    } catch (e) { c.preview = { sys, conferences: [], panelCount: 0 }; setMsg('Preview failed: ' + e.message, false); }
    paintPreview();
  }, PREVIEW_DEBOUNCE_MS);
}
function paintPreview() {
  const el = document.getElementById('cuPreview'); if (el) el.innerHTML = custPreviewHtml(custState());
}

function selectCustomer(id) {
  const c = custState();
  c.sel = id;
  c.draft = draftFrom(id === CUST_NEW ? null : c.list.find((x) => x.id === id));
  c.preview = null;
  c.dl = freshDl();
  const first = c.draft.sources.size ? [...c.draft.sources.values()][0].system : null;
  if (first) c.sys = first;
  refreshPreview();
}

function draftPayload(d) {
  const extra = d.extraUsers.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    sources: [...d.sources.values()].map((s) => ({ system: s.system, addr: s.addr, name: s.name })),
    users: [...new Set([...[...d.users].filter((u) => (state.users || []).some((x) => x.username.toLowerCase() === u.toLowerCase())), ...extra])],
    dirGroups: d.dirGroups.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
  };
}

// ---------- actions (delegated from app.js settingsAction) ----------
async function customersAction(act, el) {
  const c = custState();
  syncDraftFields();
  if (act === 'cust-select') { selectCustomer(Number(el.dataset.cust)); renderSettings(); return; }
  if (act === 'cust-new') { selectCustomer(CUST_NEW); renderSettings(); return; }
  if (act === 'cust-sys') { c.sys = el.dataset.sys; c.preview = null; c.dl = freshDl(); await ensurePanels(c.sys); renderSettings(); refreshPreview(); return; }
  if (!c.draft) return;
  const d = c.draft;

  if (act === 'cust-dl-one') { dlMove(el.dataset.side, [el.dataset.key]); return; }
  if (act === 'cust-dl-add') { dlMove('L', DualList.visibleSelected(dlModel(c).available, c.dl.selL, c.dl.qL).map((i) => i.key)); return; }
  if (act === 'cust-dl-rm') { dlMove('R', DualList.visibleSelected(dlModel(c).chosen, c.dl.selR, c.dl.qR).map((i) => i.key)); return; }
  if (act === 'cust-dl-addall') { dlMove('L', dlShownKeys('L')); return; }
  if (act === 'cust-dl-rmall') { dlMove('R', dlShownKeys('R')); return; }
  if (act === 'cust-user') {
    if (el.checked) d.users.add(el.dataset.user);
    else for (const u of [...d.users]) if (u.toLowerCase() === el.dataset.user.toLowerCase()) d.users.delete(u);
    return;
  }
  if (act === 'cust-save') {
    const body = draftPayload(d);
    if (!body.name) { setMsg('Give the customer group a name.', false); return; }
    const saved = d.id
      ? await apiWrite('/api/customers/' + d.id, 'PATCH', body)
      : await apiWrite('/api/customers', 'POST', body);
    await loadCustomers();
    selectCustomer(saved.id);
    renderSettings();
    setMsg(`Saved "${saved.name}".`, true);
    return;
  }
  if (act === 'cust-del' && d.id) {
    if (!confirm(`Delete customer group "${d.name}"? Its members will see nothing (or everything, if no groups remain).`)) return;
    await apiWrite('/api/customers/' + d.id, 'DELETE');
    c.sel = null; c.draft = null;
    await loadCustomers(); renderSettings(); setMsg('Customer group deleted.', true);
  }
}

// ---------- dual-list pointer + keyboard (delegated; rows re-paint freely) ----------
// Filters and select-all are handled in the CAPTURE phase and stopped there, so
// the Settings panel's own input/change listeners don't mark the form dirty for
// what is only a view filter.
document.addEventListener('input', (e) => {
  if (e.target.dataset && e.target.dataset.dlAll) { e.stopPropagation(); return; }   // handled on 'change'
  const side = e.target.dataset && e.target.dataset.dlFilter; if (!side) return;
  e.stopPropagation();
  custState().dl['q' + side] = e.target.value;
  paintDual();
}, true);
document.addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.dlFilter) { e.stopPropagation(); return; }   // a filter isn't an edit
  const side = e.target.dataset && e.target.dataset.dlAll; if (!side) return;
  e.stopPropagation();
  const dl = custState().dl; const shown = dlShownKeys(side);
  const key = 'sel' + side;
  dl[key] = e.target.checked ? new Set([...dl[key], ...shown]) : new Set([...dl[key]].filter((k) => !shown.includes(k)));
  paintSelection(side);
}, true);
document.addEventListener('click', (e) => {
  const row = e.target.closest && e.target.closest('#cuDual .dl-item');
  if (!row || e.target.closest('.dl-move')) return;
  dlSelect(row.dataset.side, row.dataset.key, e.shiftKey);
});
document.addEventListener('dblclick', (e) => {
  const row = e.target.closest && e.target.closest('#cuDual .dl-item');
  if (row && !e.target.closest('.dl-move')) dlMove(row.dataset.side, [row.dataset.key]);
});
document.addEventListener('keydown', (e) => {
  const row = e.target.closest && e.target.closest('#cuDual .dl-item'); if (!row) return;
  const { side, key } = row.dataset;
  if (e.key === ' ') { e.preventDefault(); dlSelect(side, key, e.shiftKey); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const c = custState(); const items = side === 'L' ? dlModel(c).available : dlModel(c).chosen;
    const picked = DualList.visibleSelected(items, c.dl['sel' + side], c.dl['q' + side]).map((i) => i.key);
    const idx = [...row.parentElement.children].indexOf(row);
    dlMove(side, picked.includes(key) ? picked : [key]);   // Enter on a selected row moves the whole selection
    const rows = document.querySelectorAll(`#dlList${side} .dl-item`);   // keep keyboard users in the list
    if (rows.length) rows[Math.min(idx, rows.length - 1)].focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const sib = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
    if (sib && sib.classList.contains('dl-item')) { sib.focus(); if (e.shiftKey) dlSelect(side, sib.dataset.key, true); }
  }
});

// ---------- scoped-viewer badge (header) ----------
// Shown to a viewer confined to customer group(s), so it's obvious the matrix is
// a filtered view rather than the whole system.
function renderScopeBadge() {
  const host = document.getElementById('scopeBadge'); if (!host) return;
  const list = state.auth && Array.isArray(state.auth.customers) ? state.auth.customers : null;
  if (!list) { host.classList.add('hidden'); host.textContent = ''; return; }
  host.classList.remove('hidden');
  host.title = list.length ? 'You see only the channels on these customer groups’ panels' : 'You are not in any customer group — ask an admin for access';
  host.innerHTML = list.length ? `<span class="scope-k">Viewing</span> ${esc(list.join(' + '))}` : '<span class="scope-k">No access</span> not in a customer group';
}
