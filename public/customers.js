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

/* global state, esc, api, apiWrite, secHead, saveBar, setMsg, renderSettings, loadUsers */

const CUST_NEW = '__new__';
const custKey = (sys, addr) => sys + '\u0000' + addr;
const PREVIEW_DEBOUNCE_MS = 250;

function custState() {
  if (!state.cust) state.cust = { list: null, sel: null, draft: null, sys: null, panels: {}, preview: null, onlySel: false };
  return state.cust;
}

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
  const d = c.draft;
  // Selected sources that no longer exist in the current data (renamed/removed).
  const present = new Set(panels.flatMap((p) => [p.addr, p.name]));
  const missing = [...d.sources.values()].filter((s) => s.system === c.sys && !present.has(s.addr) && !present.has(s.name));
  const list = panels.map((p) => {
    const on = d.sources.has(custKey(c.sys, p.addr)) || [...d.sources.values()].some((s) => s.system === c.sys && s.name === p.name);
    const confs = (p.memberships || []).length;
    return `<label class="cu-panel${on ? ' on' : ''}" data-q="${esc((p.name + ' ' + p.addr).toLowerCase())}">
      <input type="checkbox" data-act="cust-src" data-addr="${esc(p.addr)}" data-name="${esc(p.name)}"${on ? ' checked' : ''} />
      <span class="cu-panel-tx"><b>${esc(p.name)}</b>${p.addr !== p.name ? `<span>${esc(p.addr)}</span>` : ''}</span>
      <span class="cu-panel-n" title="${confs} conference${confs === 1 ? '' : 's'}">${confs}</span>
    </label>`;
  }).join('');
  return `
    <div class="cu-tools">
      <input id="cuSearch" class="cu-search" type="search" placeholder="Filter panels…" aria-label="Filter panels" autocomplete="off" />
      <label class="cu-only"><input type="checkbox" id="cuOnlySel"${c.onlySel ? ' checked' : ''} /> Selected only</label>
    </div>
    ${missing.length ? `<div class="cu-warn">⚠ ${missing.length} source panel${missing.length === 1 ? '' : 's'} not in the current data: ${missing.map((s) => `<b>${esc(s.name)}</b> <button class="cu-x" data-act="cust-src-drop" data-addr="${esc(s.addr)}" title="Remove">✕</button>`).join(', ')}</div>` : ''}
    <div class="cu-panels${c.onlySel ? ' only-sel' : ''}" id="cuPanels">${list}</div>`;
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
  if (act === 'cust-sys') { c.sys = el.dataset.sys; c.preview = null; await ensurePanels(c.sys); renderSettings(); refreshPreview(); return; }
  if (!c.draft) return;
  const d = c.draft;

  if (act === 'cust-src') {
    const k = custKey(c.sys, el.dataset.addr);
    if (el.checked) d.sources.set(k, { system: c.sys, addr: el.dataset.addr, name: el.dataset.name });
    else for (const [key, s] of d.sources) if (key === k || (s.system === c.sys && s.name === el.dataset.name)) d.sources.delete(key);
    el.closest('.cu-panel').classList.toggle('on', el.checked);
    const total = document.querySelector('.cu-total'); if (total) total.textContent = `${d.sources.size} selected`;
    refreshPreview();
    return;
  }
  if (act === 'cust-src-drop') { d.sources.delete(custKey(c.sys, el.dataset.addr)); renderSettings(); refreshPreview(); return; }
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

// Panel filter + "selected only" — pure DOM toggles, no re-render (keeps focus/scroll).
document.addEventListener('input', (e) => {
  if (e.target.id !== 'cuSearch') return;
  const q = e.target.value.trim().toLowerCase();
  for (const row of document.querySelectorAll('#cuPanels .cu-panel')) row.classList.toggle('hidden-q', !!q && !row.dataset.q.includes(q));
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'cuOnlySel') return;
  custState().onlySel = e.target.checked;
  const box = document.getElementById('cuPanels'); if (box) box.classList.toggle('only-sel', e.target.checked);
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
