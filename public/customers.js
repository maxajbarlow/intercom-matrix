// public/customers.js — Settings → Customer groups (admin) + the scoped-viewer badge.
//
// A customer group is a set of SOURCE PANELS (any system) plus its members. The
// server derives the conferences hosted on those panels live, so new channels on
// them show up for the customer automatically.
//
// Editing is direct: every add/remove/rename is saved immediately (with Undo),
// so there is no Save button to forget. Panels are added by searching across
// every system at once; members by picking viewer accounts (or, with LDAP/SAML
// on, a directory user or group). The pure logic lives in cust-model.js.
//
// Loaded BEFORE app.js; everything here is called lazily from app.js.

/* global state, esc, api, apiWrite, secHead, setMsg, renderSettings, loadUsers, CustModel */

const SEARCH_LIMIT = 150;          // result rows rendered (Add all still acts on every match)
const PREVIEW_DEBOUNCE_MS = 250;
const PANELS_TTL_MS = 30000;       // refetch panel lists when revisiting after this long
const STATUS_MS = 8000;            // how long "Added 21 panels · Undo" stays up

function custState() {
  if (!state.cust) state.cust = { list: null, sel: null, adding: false, panels: {}, panelsAt: 0, channels: null, q: '', qi: 0, mq: '', mi: 0, mOpen: false, status: null };
  return state.cust;
}
const current = () => { const c = custState(); return (c.list || []).find((x) => x.id === c.sel) || null; };
const directoryOn = () => !!(state.auth && (state.auth.ldapEnabled || state.auth.samlEnabled));
// Eye: "view as" (preview what a viewer / group sees).
const VIEW_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>';
// Directory-group avatar: two heads (inherits the avatar's colour).
const GROUP_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13c.5-2.3 2.2-3.5 4.2-3.5s3.7 1.2 4.2 3.5"/><path d="M10.5 3.4a2.3 2.3 0 0 1 0 4.4M12 9.8c1.2.5 2 1.6 2.3 3.2"/></svg>';
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

async function loadCustomers() {
  const c = custState();
  try { c.list = (await api('/api/customers')).customers || []; } catch { c.list = []; }
  return c.list;
}

// Panels for every system (search spans them all). Refreshed after PANELS_TTL_MS.
async function loadAllPanels() {
  const c = custState();
  const systems = state.systems || [];
  const lists = await Promise.all(systems.map((s) => api('/api/panels?system=' + encodeURIComponent(s.id)).then((r) => r.panels || []).catch(() => [])));
  c.panels = Object.fromEntries(systems.map((s, i) => [s.id, lists[i]]));
  c.panelsAt = Date.now();
}

// ---------- shell (static inputs; lists are painted into it) ----------
function secCustomers(eng) {
  const head = secHead('Customer groups', 'Viewers in a group see only the channels on its panels. Admins and editors see everything.');
  if (!eng) return `${head}<div class="sec-empty">Sign in as an <b>admin</b> to manage customer groups.</div>`;
  const c = custState();
  if (c.list === null) { loadCustomers().then(renderSettings); return `${head}<div class="sec-empty">Loading…</div>`; }
  if (state.users === null) loadUsers().then(paintCustomers);
  if (Date.now() - c.panelsAt > PANELS_TTL_MS) { c.panelsAt = Date.now(); loadAllPanels().then(() => { paintCustomers(); refreshChannels(); }); }

  if (c.sel != null && !current()) c.sel = null;
  if (c.sel == null && c.list.length) { c.sel = c.list[0].id; refreshChannels(); }
  if (!c.list.length) c.adding = true;

  const cust = current();
  const add = c.adding
    ? `<input id="cuNew" class="cu-new" placeholder="New group name" aria-label="New customer group name" autocomplete="off" />`
    : '<button class="cu-addg" data-act="cust-new">+ New group</button>';
  return `${head}
    <div class="cu">
      <nav class="cu-groups" aria-label="Customer groups"><div id="cuList"></div>${add}</nav>
      <div class="cu-main">${cust ? custShell(cust) : `<div class="sec-empty">${c.list.length ? 'Select a group.' : 'Name your first customer group to start scoping viewers.'}</div>`}</div>
    </div>`;
}

function custShell(cust) {
  const c = custState();
  return `
    <header class="cu-head">
      <div class="cu-titles">
        <input id="cuName" class="cu-name" value="${esc(cust.name)}" aria-label="Group name" autocomplete="off" spellcheck="false" />
        <input id="cuDesc" class="cu-desc" value="${esc(cust.description)}" placeholder="Add a description" aria-label="Description" autocomplete="off" />
      </div>
      <div class="cu-status" id="cuStatus" role="status" aria-live="polite"></div>
      <button class="btn small cu-view" data-act="cust-viewas-group" title="See exactly what this group's viewers see">${VIEW_ICON}Preview</button>
      <button class="btn small danger" data-act="cust-del">Delete</button>
    </header>
    <div class="cu-cols">
      <section class="cu-sec" aria-labelledby="cuPanelsH">
        <h4 id="cuPanelsH">Panels <span class="cu-n" id="cuPanelsN"></span></h4>
        <div class="cu-search">
          <input id="cuQ" type="search" value="${esc(c.q)}" placeholder="Search panels to add — name, type or system" aria-label="Search panels to add"
            role="combobox" aria-controls="cuResults" aria-autocomplete="list" aria-expanded="false" autocomplete="off" spellcheck="false" />
          <div id="cuResults" class="cu-pop" role="listbox" aria-label="Matching panels" aria-multiselectable="true" hidden></div>
        </div>
        <div id="cuPanels"></div>
      </section>
      <div class="cu-aside">
        <section class="cu-sec" aria-labelledby="cuMembersH">
          <h4 id="cuMembersH">Members <span class="cu-n" id="cuMembersN"></span></h4>
          <div class="cu-search">
            <input id="cuMq" type="search" value="${esc(c.mq)}" placeholder="${directoryOn() ? 'Add a viewer, user or directory group' : 'Add a viewer'}" aria-label="Add member"
              role="combobox" aria-controls="cuMResults" aria-autocomplete="list" aria-expanded="false" autocomplete="off" spellcheck="false" />
            <div id="cuMResults" class="cu-pop" role="listbox" aria-label="Suggestions" hidden></div>
          </div>
          <ul id="cuMembers" class="cu-members"></ul>
        </section>
        <section class="cu-sec" id="cuChannels"></section>
      </div>
    </div>`;
}

// ---------- paint (fills the shell; never touches the inputs) ----------
function paintCustomers() {
  if (!document.getElementById('cuList')) return;
  paintGroupList();
  if (!current()) return;
  paintPanels(); paintResults(); paintMembers(); paintChannels(); paintStatus();
}

function paintGroupList() {
  const c = custState();
  document.getElementById('cuList').innerHTML = (c.list || []).map((x) => {
    const members = x.users.length + x.dirGroups.length;
    return `<button class="cu-g${x.id === c.sel ? ' active' : ''}" data-act="cust-select" data-cust="${x.id}"${x.id === c.sel ? ' aria-current="true"' : ''}>
      <b>${esc(x.name)}</b><span>${plural(x.sources.length, 'panel')} · ${plural(members, 'member')}</span></button>`;
  }).join('');
}

function paintPanels() {
  const c = custState(); const cust = current();
  const groups = CustModel.resolveSources(c.panels, state.systems, cust.sources);
  document.getElementById('cuPanelsN').textContent = cust.sources.length || '';
  const host = document.getElementById('cuPanels');
  if (!groups.length) { host.innerHTML = '<p class="cu-empty">No panels yet — search above to add them.</p>'; return; }
  host.innerHTML = groups.map((g) => `
    <div class="cu-sys">
      <div class="cu-sys-h"><b>${esc(g.sysName)}</b><span>${g.items.length}</span></div>
      <ul class="cu-plist">${g.items.map(panelRow).join('')}</ul>
    </div>`).join('');
}
function panelRow(p) {
  const n = (p.memberships || []).length;
  const meta = p.missing ? '<span class="cu-warn">not in current print</span>' : (p.type ? `<span>${esc(p.type)}</span>` : '');
  return `<li class="cu-p${p.missing ? ' missing' : ''}">
    <span class="cu-p-tx"><b title="${esc(p.name)}">${esc(p.name)}</b>${meta}</span>
    ${p.missing ? '' : `<span class="cu-ch" title="${plural(n, 'channel')}">${n}</span>`}
    <button class="cu-x" data-act="cust-rm" data-sys="${esc(p.system)}" data-addr="${esc(p.source.addr)}" aria-label="Remove ${esc(p.name)}" title="Remove">×</button>
  </li>`;
}

function searchResult() {
  const c = custState();
  return CustModel.search(c.panels, state.systems, current().sources, c.q, SEARCH_LIMIT);
}
function paintResults() {
  const c = custState();
  const pop = document.getElementById('cuResults'); const input = document.getElementById('cuQ');
  const r = searchResult();
  const open = !!c.q.trim();
  pop.hidden = !open; input.setAttribute('aria-expanded', String(open));
  if (!open) { input.removeAttribute('aria-activedescendant'); return; }
  if (!r.total) { pop.innerHTML = '<p class="cu-empty">No panels match.</p>'; return; }
  const flat = r.groups.flatMap((g) => g.items);
  c.qi = Math.min(c.qi, flat.length - 1);
  const inGroup = r.total - r.fresh.length;
  const bulk = r.fresh.length
    ? `<button class="btn small primary" data-act="cust-addall">Add all ${r.fresh.length}</button>`
    : `<button class="btn small" data-act="cust-rmall">Remove all ${inGroup}</button>`;
  let i = 0;
  pop.innerHTML = `
    <div class="cu-pop-h"><span>${plural(r.total, 'match', 'matches')}${inGroup ? ` · ${inGroup} in group` : ''}</span>${bulk}</div>
    <div class="cu-pop-list">${r.groups.map((g) => `
      <div class="cu-pop-sys" role="presentation">${esc(g.sysName)}</div>
      ${g.items.map((p) => { const idx = i++; return `
        <div class="cu-opt${p.added ? ' on' : ''}${idx === c.qi ? ' active' : ''}" id="cuOpt${idx}" role="option" aria-selected="${p.added}" data-act="cust-toggle" data-idx="${idx}">
          <span class="cu-tick" aria-hidden="true"></span>
          <span class="cu-p-tx"><b>${esc(p.name)}</b>${p.type ? `<span>${esc(p.type)}</span>` : ''}</span>
          <span class="cu-ch" title="${plural((p.memberships || []).length, 'channel')}">${(p.memberships || []).length}</span>
        </div>`; }).join('')}`).join('')}
    </div>
    ${r.shown < r.total ? `<p class="cu-more">Showing ${r.shown} of ${r.total} — refine the search to see the rest.</p>` : ''}`;
  input.setAttribute('aria-activedescendant', 'cuOpt' + c.qi);
}

function paintMembers() {
  const c = custState(); const cust = current();
  const rows = CustModel.memberRows(cust, state.users || []);
  document.getElementById('cuMembersN').textContent = rows.length || '';
  const sub = (m) => m.kind === 'group' ? 'Directory group' : m.kind === 'user' ? 'Directory user' : m.unscoped ? `${esc(m.role)} · sees everything` : esc(m.sub);
  const icon = (m) => m.kind === 'group' ? `<span class="cu-av grp" aria-hidden="true">${GROUP_ICON}</span>`
    : `<span class="cu-av${m.unscoped ? ' dim' : ''}" aria-hidden="true">${esc((m.label[0] || '?').toUpperCase())}</span>`;
  const list = document.getElementById('cuMembers');
  list.innerHTML = rows.length ? rows.map((m) => `
    <li class="cu-m${m.unscoped ? ' unscoped' : ''}">${icon(m)}
      <span class="cu-p-tx"><b title="${esc(m.label)}">${esc(m.label)}</b><span>${sub(m)}</span></span>
      ${m.kind !== 'group' && !m.unscoped ? `<button class="cu-x cu-eye" data-act="cust-viewas-user" data-user="${esc(m.value)}" aria-label="View as ${esc(m.label)}" title="View as ${esc(m.label)}">${VIEW_ICON}</button>` : ''}
      <button class="cu-x" data-act="cust-mrm" data-kind="${m.kind}" data-val="${esc(m.value)}" aria-label="Remove ${esc(m.label)}" title="Remove">×</button>
    </li>`).join('') : '<li class="cu-empty">No members yet.</li>';
  if (rows.some((m) => m.kind === 'group')) list.insertAdjacentHTML('beforeend', '<li class="cu-note">Directory groups also let all their members sign in as viewers.</li>');
  paintMemberSuggestions();
}
function memberSuggestions() {
  const c = custState();
  return CustModel.memberSuggestions(c.mq, current(), state.users || [], directoryOn());
}
function paintMemberSuggestions() {
  const c = custState();
  const pop = document.getElementById('cuMResults'); const input = document.getElementById('cuMq');
  const list = memberSuggestions();
  const open = c.mOpen && (list.length > 0 || !!c.mq.trim());
  pop.hidden = !open; input.setAttribute('aria-expanded', String(open));
  if (!open) { input.removeAttribute('aria-activedescendant'); return; }
  c.mi = Math.max(0, Math.min(c.mi, list.length - 1));
  const what = (s) => s.kind === 'group' ? 'Add directory group' : s.kind === 'user' ? 'Add directory user' : esc(s.sub);
  pop.innerHTML = list.length ? `<div class="cu-pop-list">${list.map((s, i) => `
    <div class="cu-opt${i === c.mi ? ' active' : ''}" id="cuMOpt${i}" role="option" aria-selected="false" data-act="cust-madd" data-idx="${i}">
      <span class="cu-av${s.kind === 'group' ? ' grp' : ''}" aria-hidden="true">${s.kind === 'group' ? GROUP_ICON : esc((s.label[0] || '?').toUpperCase())}</span>
      <span class="cu-p-tx"><b>${esc(s.label)}</b>${what(s) ? `<span>${what(s)}</span>` : ''}</span>
    </div>`).join('')}</div>`
    : `<p class="cu-empty">No viewer account matches.${state.users && !state.users.some((u) => u.role === 'viewer') ? ' Create viewer accounts under Users.' : ''}</p>`;
  if (list.length) input.setAttribute('aria-activedescendant', 'cuMOpt' + c.mi);
}

function paintChannels() {
  const c = custState(); const cust = current();
  const host = document.getElementById('cuChannels'); if (!host) return;
  const ch = c.channels && c.channels.id === cust.id ? c.channels : null;
  if (!cust.sources.length) { host.innerHTML = ''; return; }
  if (!ch) { host.innerHTML = '<h4>Channels <span class="cu-n">…</span></h4>'; return; }
  const body = ch.groups.map((g) => `${ch.groups.length > 1 ? `<div class="cu-sys-h"><b>${esc(g.sysName)}</b><span>${g.confs.length}</span></div>` : ''}
    <ul class="cu-chlist">${g.confs.map((x) => `<li title="${esc(x.label || '')}">${esc(x.name)}</li>`).join('')}</ul>`).join('');
  host.innerHTML = `<details class="cu-chan"${c.chanOpen ? ' open' : ''}><summary><h4>Channels <span class="cu-n">${ch.total}</span></h4><span class="cu-chev" aria-hidden="true"></span></summary>${ch.total ? body : '<p class="cu-empty">These panels host no channels.</p>'}</details>`;
}

function paintStatus() {
  const el = document.getElementById('cuStatus'); if (!el) return;
  const s = custState().status;
  el.className = 'cu-status' + (s && s.bad ? ' bad' : '');
  el.innerHTML = s ? `${esc(s.text)}${s.undo ? ' <button class="cu-undo" data-act="cust-undo">Undo</button>' : ''}` : '';
}
let statusTimer = null;
function showSaveState(text, { undo = null, bad = false, sticky = false } = {}) {
  const c = custState();
  c.status = text ? { text, undo, bad } : null;
  clearTimeout(statusTimer);
  if (text && !sticky) statusTimer = setTimeout(() => { c.status = null; paintStatus(); }, STATUS_MS);
  paintStatus();
}

// ---------- live channel preview (per system, in parallel) ----------
let previewTimer = null, previewSeq = 0;
function refreshChannels() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const c = custState(); const cust = current(); if (!cust) return;
    const seq = ++previewSeq;
    const systems = [...new Set(cust.sources.map((s) => s.system))];
    const results = await Promise.all(systems.map((sys) =>
      apiWrite('/api/customers/preview?system=' + encodeURIComponent(sys), 'POST', { sources: cust.sources.filter((s) => s.system === sys) })
        .then((r) => r.conferences || []).catch(() => [])));
    if (seq !== previewSeq) return;   // a newer change superseded this one
    const groups = systems.map((sys, i) => ({ system: sys, sysName: ((state.systems || []).find((s) => s.id === sys) || {}).name || sys, confs: results[i] }))
      .filter((g) => g.confs.length);
    c.channels = { id: cust.id, groups, total: groups.reduce((n, g) => n + g.confs.length, 0) };
    paintChannels();
  }, PREVIEW_DEBOUNCE_MS);
}

// ---------- saving: optimistic, serialized, undoable ----------
let saveChain = Promise.resolve();
let pending = 0;
function commit(patch, { msg = 'Saved', undo = null } = {}) {
  const c = custState(); const cust = current(); if (!cust) return;
  const id = cust.id;
  c.list = c.list.map((x) => (x.id === id ? { ...x, ...patch } : x));
  pending++;
  showSaveState('Saving…', { sticky: true });
  paintCustomers();
  if (patch.sources) refreshChannels();
  saveChain = saveChain.then(async () => {
    try {
      const saved = await apiWrite('/api/customers/' + id, 'PATCH', patch);
      pending--;
      // Only adopt the server copy once no newer optimistic edit is in flight.
      if (!pending) c.list = c.list.map((x) => (x.id === id ? saved : x));
      if (!pending) showSaveState(msg, { undo: undo ? { id, patch: undo } : null });
    } catch (e) {
      pending--;
      await loadCustomers();
      showSaveState('Not saved — ' + e.message, { bad: true });
      refreshChannels();
    }
    if (custState().sel === id) { const n = document.getElementById('cuName'); if (n && document.activeElement !== n) n.value = current().name; }
    paintCustomers();
  });
}

function changeSources(next, msg) {
  const prev = current().sources;
  commit({ sources: next }, { msg, undo: { sources: prev } });
}
function changeMembers(next, msg) {
  const cust = current();
  commit({ users: next.users, dirGroups: next.dirGroups }, { msg, undo: { users: cust.users, dirGroups: cust.dirGroups } });
}

function selectCustomer(id) {
  const c = custState();
  c.sel = id; c.q = ''; c.qi = 0; c.mq = ''; c.mi = 0; c.mOpen = false; c.channels = null; c.status = null; c.adding = false;
  renderSettings(); refreshChannels();
}

// ---------- actions (delegated from app.js settingsAction) ----------
async function customersAction(act, el) {
  const c = custState();
  if (act === 'cust-viewas-user') { startViewAs({ username: el.dataset.user }); return; }
  if (act === 'cust-viewas-group') { if (current()) startViewAs({ customerId: current().id }); return; }
  if (act === 'cust-select') { selectCustomer(Number(el.dataset.cust)); return; }
  if (act === 'cust-new') { c.adding = true; renderSettings(); document.getElementById('cuNew').focus(); return; }
  const cust = current(); if (!cust) return;

  if (act === 'cust-toggle') {
    const item = searchResult().groups.flatMap((g) => g.items)[Number(el.dataset.idx)]; if (!item) return;
    c.qi = Number(el.dataset.idx);
    if (item.added) changeSources(CustModel.removeSources(cust.sources, [item.sourceKey]), `Removed ${item.name}`);
    else changeSources(CustModel.addSources(cust.sources, [item]), `Added ${item.name}`);
    document.getElementById('cuQ').focus();
    return;
  }
  if (act === 'cust-addall') {
    const fresh = searchResult().fresh;
    closeSearch();   // bulk done: show the result (and Undo), don't leave a flipped button under the cursor
    changeSources(CustModel.addSources(cust.sources, fresh), `Added ${plural(fresh.length, 'panel')}`);
    return;
  }
  if (act === 'cust-rmall') {
    const r = CustModel.search(c.panels, state.systems, cust.sources, c.q);
    const added = r.groups.flatMap((g) => g.items).filter((p) => p.added);
    closeSearch();
    changeSources(CustModel.removeSources(cust.sources, added.map((p) => p.sourceKey)), `Removed ${plural(added.length, 'panel')}`);
    return;
  }
  if (act === 'cust-rm') {
    // (keys join system + address with NUL, which can't survive an HTML attribute — rebuild it)
    const key = CustModel.sourceKey(el.dataset.sys, el.dataset.addr);
    const item = CustModel.resolveSources(c.panels, state.systems, cust.sources).flatMap((g) => g.items).find((p) => p.key === key);
    changeSources(CustModel.removeSources(cust.sources, [key]), `Removed ${item ? item.name : 'panel'}`);
    return;
  }
  if (act === 'cust-madd') { addMemberAt(Number(el.dataset.idx)); return; }
  if (act === 'cust-mrm') {
    const m = { kind: el.dataset.kind, value: el.dataset.val };
    changeMembers(CustModel.removeMember(cust, m), `Removed ${m.value}`);
    return;
  }
  if (act === 'cust-undo') {
    const u = c.status && c.status.undo; if (!u || u.id !== cust.id) return;
    commit(u.patch, { msg: 'Undone' });
    return;
  }
  if (act === 'cust-del') {
    if (!confirm(`Delete "${cust.name}"? Its members will see nothing (or everything, if no groups remain).`)) return;
    await apiWrite('/api/customers/' + cust.id, 'DELETE');
    c.sel = null; c.channels = null;
    await loadCustomers(); renderSettings(); setMsg(`Deleted "${cust.name}".`, true);
  }
}

function closeSearch() {
  const c = custState(); c.q = ''; c.qi = 0;
  const q = document.getElementById('cuQ'); if (q) { q.value = ''; q.blur(); }
}

function addMemberAt(idx) {
  const c = custState();
  const s = memberSuggestions()[idx]; if (!s) return;
  c.mq = ''; c.mi = 0;
  const input = document.getElementById('cuMq'); if (input) { input.value = ''; input.focus(); }
  changeMembers(CustModel.addMember(current(), s), `Added ${s.label}`);
}

async function createCustomer(name) {
  const c = custState();
  try {
    const saved = await apiWrite('/api/customers', 'POST', { name });
    await loadCustomers();
    selectCustomer(saved.id);
    const q = document.getElementById('cuQ'); if (q) q.focus();
  } catch (e) { setMsg(e.message, false); c.adding = true; }
}

async function renameCustomer(field, value) {
  const cust = current(); if (!cust) return;
  const v = value.trim();
  if (field === 'name' && !v) { document.getElementById('cuName').value = cust.name; return; }
  if (v === (cust[field] || '')) return;
  commit({ [field]: v }, { msg: field === 'name' ? 'Renamed' : 'Saved' });
}

// ---------- keyboard + typing (document-level; the shell's inputs persist) ----------
document.addEventListener('input', (e) => {
  const c = custState(); const id = e.target.id;
  if (id === 'cuQ') { c.q = e.target.value; c.qi = 0; paintResults(); }
  else if (id === 'cuMq') { c.mq = e.target.value; c.mi = 0; c.mOpen = true; paintMemberSuggestions(); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'cuName') renameCustomer('name', e.target.value);
  else if (e.target.id === 'cuDesc') renameCustomer('description', e.target.value);
});
document.addEventListener('focusin', (e) => {
  if (e.target.id === 'cuMq') { custState().mOpen = true; paintMemberSuggestions(); }
});
document.addEventListener('focusout', (e) => {
  if (e.target.id === 'cuMq') { custState().mOpen = false; paintMemberSuggestions(); }
  // Swap just the input back (a full re-render here would swallow a click on another group).
  if (e.target.id === 'cuNew' && !e.target.value.trim() && custState().list.length) {
    custState().adding = false;
    e.target.outerHTML = '<button class="cu-addg" data-act="cust-new">+ New group</button>';
  }
});
// Keep focus in the search field while clicking an option, so the list stays open.
// Clicking anywhere else closes the panel results.
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('.cu-pop')) { e.preventDefault(); return; }
  const c = custState(); const q = document.getElementById('cuQ');
  if (q && c.q && e.target !== q) { closeSearch(); paintResults(); }
});
document.addEventListener('toggle', (e) => { if (e.target.classList && e.target.classList.contains('cu-chan')) custState().chanOpen = e.target.open; }, true);

document.addEventListener('keydown', (e) => {
  const c = custState(); const id = e.target.id;
  if (id === 'cuNew') {
    if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); createCustomer(e.target.value.trim()); }
    else if (e.key === 'Escape' && c.list.length) { c.adding = false; renderSettings(); }
    return;
  }
  if (id === 'cuName' || id === 'cuDesc') {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    else if (e.key === 'Escape') { const cust = current(); e.target.value = id === 'cuName' ? cust.name : cust.description; e.target.blur(); }
    return;
  }
  if (id === 'cuQ') {
    const n = searchResult().shown;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!n) return;
      c.qi = (c.qi + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      paintResults();
      const opt = document.getElementById('cuOpt' + c.qi); if (opt) opt.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && n) {
      e.preventDefault();
      const opt = document.getElementById('cuOpt' + c.qi); if (opt) customersAction('cust-toggle', opt);
    } else if (e.key === 'Escape' && c.q) { e.preventDefault(); c.q = ''; e.target.value = ''; paintResults(); }
    return;
  }
  if (id === 'cuMq') {
    const n = memberSuggestions().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!n) return;
      c.mOpen = true; c.mi = (c.mi + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      paintMemberSuggestions();
    } else if (e.key === 'Enter' && n) { e.preventDefault(); addMemberAt(c.mi); }
    else if (e.key === 'Escape') { e.preventDefault(); c.mq = ''; e.target.value = ''; c.mOpen = false; paintMemberSuggestions(); }
  }
});

// ---------- "view as" preview (lib/view-as) ----------
// The server holds the target on the admin's session; a full reload then renders
// the app exactly as that viewer gets it. Exit returns to where the preview started.
const VIEW_AS_RETURN_KEY = 'imx.viewAsReturn';
function reloadAt(hash) { history.replaceState(null, '', location.pathname + location.search + hash); location.reload(); }

async function startViewAs(target) {
  try { await apiWrite('/api/view-as', 'POST', target); }
  catch (e) { setMsg(e.message, false); return; }
  try { sessionStorage.setItem(VIEW_AS_RETURN_KEY, location.hash || ''); } catch { /* storage blocked: exit lands on Customers */ }
  reloadAt('');
}
async function exitViewAs() {
  try { await apiWrite('/api/view-as', 'DELETE'); } catch { /* reload re-reads the session either way */ }
  let back = '#settings/customers';
  try { back = sessionStorage.getItem(VIEW_AS_RETURN_KEY) || back; sessionStorage.removeItem(VIEW_AS_RETURN_KEY); } catch { /* default */ }
  reloadAt(back);
}

function renderViewAsBar() {
  const bar = document.getElementById('viewAsBar'); if (!bar) return;
  const v = state.auth && state.auth.viewAs;
  bar.hidden = !v;
  if (!v) { bar.textContent = ''; return; }
  const who = v.kind === 'group' ? `the <b>${esc(v.label)}</b> group` : `<b>${esc(v.label)}</b>`;
  bar.innerHTML = `${VIEW_ICON}<span class="viewas-tx">Viewing as ${who}</span><span class="viewas-ro">Read-only preview</span>
    <button class="viewas-exit" data-viewas-exit>Exit preview</button>`;
}
document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-viewas-exit]')) exitViewAs(); });

// ---------- scoped-viewer badge (header) ----------
// Shown to a viewer confined to customer group(s), so it's obvious the matrix is
// a filtered view rather than the whole system.
function renderScopeBadge() {
  renderViewAsBar();
  const host = document.getElementById('scopeBadge'); if (!host) return;
  const list = state.auth && Array.isArray(state.auth.customers) ? state.auth.customers : null;
  if (!list) { host.classList.add('hidden'); host.textContent = ''; return; }
  host.classList.remove('hidden');
  host.title = list.length ? 'You see only the channels on these customer groups’ panels' : 'You are not in any customer group — ask an admin for access';
  host.innerHTML = list.length ? `<span class="scope-k">Viewing</span> ${esc(list.join(' + '))}` : '<span class="scope-k">No access</span> not in a customer group';
}
