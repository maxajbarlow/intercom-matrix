'use strict';
// onboarding.js — first-run setup wizard.
//
// Loaded BEFORE app.js so app.js's init() can ask `await Onboarding.maybeStart()`
// and bail out of the normal boot while setup is in progress. Self-contained on
// purpose (its own fetch/esc/rel helpers) so it has no load-order coupling to
// app.js. It mostly ORCHESTRATES existing endpoints; the only bespoke server
// surface is GET /api/onboarding and POST /api/onboarding/admin.
//
// Flow: Welcome (how it works) → Admin account → First system (live RRCS OR a
// config print) → Branding → Finish. On completion it stamps
// settings.meta.onboardedAt and reloads into the configured app.

(function () {
  // ---- tiny self-contained helpers (mirror app.js, intentionally duplicated) -
  const rel = (p) => p.replace(/^\//, '');                 // sub-path / reverse-proxy friendly
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = (id) => document.getElementById(id);

  async function getJSON(path) {
    const r = await fetch(rel(path));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  // Throw an Error tagged with the HTTP status so callers can distinguish a lost
  // session (401/403) from a validation error and recover gracefully.
  function httpError(status, message) {
    const e = new Error(message || ('HTTP ' + status));
    e.status = status;
    return e;
  }
  async function sendJSON(path, method, body) {
    const r = await fetch(rel(path), { method, headers: { 'Content-Type': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, j.error);
    return j;
  }
  async function sendRaw(path, buf) {
    const r = await fetch(rel(path), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, j.error);
    return j;
  }

  // A system id is fixed at creation and keys stored prints/requests — derive a
  // safe slug from the friendly name (server enforces /^[a-z0-9][a-z0-9_-]{0,39}$/).
  const slugify = (name) => String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'system';

  // ---- wizard state ----------------------------------------------------------
  const STEPS = [
    { key: 'welcome', title: 'Welcome' },
    { key: 'admin', title: 'Admin' },
    { key: 'system', title: 'System' },
    { key: 'branding', title: 'Branding' },
    { key: 'finish', title: 'Finish' },
  ];

  const ob = {
    idx: 0,
    status: null,                 // GET /api/onboarding
    adminDone: false,             // an admin account exists / was created
    sys: { path: 'rrcs', name: 'Studio A', host: '', port: 8193, createdId: null, busy: false, result: null },
    brand: { theme: null },       // chosen theme for live preview
    requireLogin: false,
    msgTimer: null,
  };

  // ---- root DOM (injected once) ----------------------------------------------
  function ensureRoot() {
    if ($('obBackdrop')) return;
    const div = document.createElement('div');
    div.className = 'ob-backdrop hidden';
    div.id = 'obBackdrop';
    div.innerHTML = `
      <div class="ob-card" role="dialog" aria-modal="true" aria-labelledby="obTitle">
        <header class="ob-head">
          <span class="ob-kicker"><span class="dot"></span><span id="obKicker">First-run setup</span></span>
          <h2 class="ob-title" id="obTitle">Welcome</h2>
          <p class="ob-sub" id="obSub"></p>
          <ol class="ob-steps" id="obSteps"></ol>
        </header>
        <div class="ob-body" id="obBody"></div>
        <div class="ob-msg" id="obMsg"></div>
        <footer class="ob-foot" id="obFoot"></footer>
      </div>`;
    document.body.appendChild(div);

    // One delegated handler for every wizard control (data-ob="action").
    div.addEventListener('click', onClick);
    div.addEventListener('submit', (e) => { if (e.target.id === 'obAdminForm') { e.preventDefault(); createAdmin(); } if (e.target.id === 'obLoginForm') { e.preventDefault(); bootstrapLogin(); } });
  }

  function setMsg(text, kind) {
    const el = $('obMsg'); if (!el) return;
    el.textContent = text || '';
    el.className = 'ob-msg' + (text ? ' ' + (kind || 'bad') : '');
    clearTimeout(ob.msgTimer);
    if (text && kind === 'ok') ob.msgTimer = setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'ob-msg'; } }, 3000);
  }

  // ---- render ----------------------------------------------------------------
  function renderSteps() {
    // The welcome card isn't a "task" — show the 4 real steps as progress bars.
    const real = STEPS.slice(1);
    $('obSteps').innerHTML = real.map((s, i) => {
      const stepIdx = i + 1;
      const cls = stepIdx < ob.idx ? 'done' : stepIdx === ob.idx ? 'active' : '';
      const mark = stepIdx < ob.idx ? '✓ ' : '';
      return `<li class="${cls}"><span class="bar"></span><span class="lbl">${mark}${esc(s.title)}</span></li>`;
    }).join('');
  }

  function render() {
    renderSteps();
    const step = STEPS[ob.idx];
    const body = $('obBody'), foot = $('obFoot');
    setMsg('');
    ({
      welcome: renderWelcome,
      admin: renderAdmin,
      system: renderSystem,
      branding: renderBranding,
      finish: renderFinish,
    }[step.key])(body, foot);
    // autofocus the first text input, if any
    const f = body.querySelector('input:not([type=file]), select');
    if (f) setTimeout(() => f.focus(), 0);
  }

  function footHTML({ back = true, next = 'Continue', nextAct = 'next', skip = null, primaryDisabled = false } = {}) {
    return `
      ${back ? '<button class="ob-btn ghost" data-ob="back">← Back</button>' : ''}
      <span class="spacer"></span>
      ${skip ? `<button class="ob-btn ghost" data-ob="skip">${esc(skip)}</button>` : ''}
      <button class="ob-btn primary" data-ob="${esc(nextAct)}" id="obNext"${primaryDisabled ? ' disabled' : ''}>${esc(next)}</button>`;
  }

  // Step 0 — Welcome / how it works
  function renderWelcome(body, foot) {
    $('obKicker').textContent = 'First-run setup';
    $('obTitle').textContent = 'Welcome to Intercom Matrix';
    $('obSub').textContent = 'A read-only viewer for your intercom systems. Four short steps and you’re live.';
    body.innerHTML = `
      <div class="ob-note lock"><span class="ico">🔒</span><div><b>It can’t change your intercom.</b> The RRCS client is hard-locked to <code>Get*</code> queries — it physically cannot set or kill a crosspoint. Everyone gets a safe, read-only view of the live communication matrix.</div></div>
      <div class="ob-note"><span class="ico">📡</span><div><b>Two ways to feed it data.</b> Connect a controller <b>live over RRCS</b> for an always-current view, or upload a <b>config print</b> (export) to work offline from a snapshot. You’ll pick one for your first system next — you can add more later.</div></div>
      <div class="ob-note"><span class="ico">📝</span><div><b>Changes are request → verify.</b> The viewer never writes to the system. It captures change <b>intent</b>, groups it into a work order for the engineer, then auto-verifies against the next config print.</div></div>`;
    foot.innerHTML = footHTML({ back: false, next: 'Get started →' });
  }

  // Step 1 — Admin account
  function renderAdmin(body, foot) {
    $('obKicker').textContent = 'Step 1 of 4';
    $('obTitle').textContent = 'Create the admin account';
    $('obSub').textContent = 'The admin manages systems, settings and other accounts. This is your way in.';

    if (ob.adminDone || (ob.status && ob.status.steps.admin)) {
      body.innerHTML = `
        <div class="ob-note good"><span class="ico">✓</span><div><b>Admin account ready.</b> You’re signed in as an administrator — let’s point the viewer at your first system.</div></div>`;
      foot.innerHTML = footHTML({ next: 'Continue' });
      return;
    }

    const canCreate = !ob.status || ob.status.canCreateAdmin;
    if (!canCreate) {
      // Open admin creation disabled (ONBOARDING_OPEN=0) — fall back to env bootstrap.
      body.innerHTML = `
        <div class="ob-note"><span class="ico">ℹ︎</span><div>In-app admin creation is disabled on this deployment. Sign in with the <b>bootstrap admin</b> (the <code>LOCAL_ADMIN_*</code> credentials from the environment) to continue.</div></div>
        ${loginFormHTML()}`;
      foot.innerHTML = footHTML({ next: 'Continue', primaryDisabled: true });
      return;
    }

    body.innerHTML = `
      <div class="ob-note"><span class="ico">👤</span><div>Stored locally, scrypt-hashed. You can add more accounts (and connect LDAP or SSO) later in <b>Settings → Users</b>.</div></div>
      <form class="ob-fields" id="obAdminForm">
        <label class="ob-fld"><span>Username</span><input id="obAdminUser" autocomplete="username" placeholder="admin" required /></label>
        <label class="ob-fld"><span>Display name <span class="hint">(optional)</span></span><input id="obAdminName" autocomplete="name" placeholder="Jane Engineer" /></label>
        <div class="ob-row2 even">
          <label class="ob-fld"><span>Password</span><input id="obAdminPass" type="password" autocomplete="new-password" placeholder="At least 6 characters" required /></label>
          <label class="ob-fld"><span>Confirm</span><input id="obAdminPass2" type="password" autocomplete="new-password" placeholder="Repeat" required /></label>
        </div>
      </form>
      <div class="ob-linkrow">Already set a bootstrap admin in the environment? <a data-ob="reveal-login">Sign in instead</a></div>
      <div id="obLoginSlot"></div>`;
    foot.innerHTML = footHTML({ next: 'Create admin →', nextAct: 'create-admin' });
  }

  function loginFormHTML() {
    return `
      <form class="ob-fields" id="obLoginForm">
        <label class="ob-fld"><span>Username</span><input id="obLoginUser" autocomplete="username" required /></label>
        <label class="ob-fld"><span>Password</span><input id="obLoginPass" type="password" autocomplete="current-password" required /></label>
        <button class="ob-btn primary" type="submit" style="align-self:flex-start">Sign in</button>
      </form>`;
  }

  // Step 2 — First system (live RRCS OR a config print)
  function renderSystem(body, foot) {
    $('obKicker').textContent = 'Step 2 of 4';
    $('obTitle').textContent = 'Add your first system';
    $('obSub').textContent = 'Pick how this system is fed. Either path gives you the full Matrix, Conferences and Panels views.';
    const s = ob.sys;
    const seg = `
      <div class="ob-seg">
        <div class="opt ${s.path === 'rrcs' ? 'active' : ''}" data-ob="path-rrcs">
          <div class="t"><span class="ic">📡</span> Connect live (RRCS)</div>
          <p class="d">Always-current. Needs the controller reachable on this network.</p>
        </div>
        <div class="opt ${s.path === 'print' ? 'active' : ''}" data-ob="path-print">
          <div class="t"><span class="ic">📄</span> Upload a print</div>
          <p class="d">Offline snapshot from a controller export — works from anywhere, no controller needed.</p>
        </div>
      </div>`;

    const nameFld = `<label class="ob-fld"><span>System name</span><input id="obSysName" value="${esc(s.name)}" placeholder="Studio A" /><span class="hint">A label like “Studio A”, “Control Room”. The id <code>${esc(slugify(s.name))}</code> is derived from it and fixed once created.</span></label>`;

    const pathBody = s.path === 'rrcs' ? `
      ${nameFld}
      <div class="ob-row2">
        <label class="ob-fld"><span>Controller host / IP</span><input id="obSysHost" value="${esc(s.host)}" placeholder="10.0.0.5" /></label>
        <label class="ob-fld"><span>Port</span><input id="obSysPort" type="number" value="${esc(s.port)}" /></label>
      </div>
      <div class="ob-note lock"><span class="ico">🔒</span><div>Connecting turns on live polling, then runs a single read-only <code>Get*</code> probe. Nothing is ever written to the controller.</div></div>
      <button class="ob-btn" data-ob="test-rrcs" id="obTest">Test connection</button>
      <div id="obSysResult"></div>` : `
      ${nameFld}
      <input type="file" id="obPrintFile" accept=".pdf,.txt" hidden />
      <div class="ob-drop" id="obDrop" data-ob="pick-print">
        <span class="big">⬆</span>
        <div><b>Drop a config print here</b> or click to choose</div>
        <div class="hint" style="margin-top:6px">PDF or text export. Imported as version 1 — later prints verify open requests.</div>
      </div>
      <div id="obSysResult"></div>`;

    body.innerHTML = seg + `<div class="ob-fields">${pathBody}</div>`;
    renderSysResult();
    foot.innerHTML = footHTML({ next: 'Continue', skip: 'Skip — add later', primaryDisabled: !s.createdId });
  }

  function renderSysResult() {
    const slot = $('obSysResult'); if (!slot) return;
    const r = ob.sys.result;
    if (ob.sys.busy) { slot.innerHTML = `<div class="ob-result busy"><span class="dotind" style="background:var(--text-dim)"></span><span class="spin">◐</span> ${esc(ob.sys.busy)}</div>`; return; }
    if (!r) { slot.innerHTML = ''; return; }
    slot.innerHTML = `<div class="ob-result ${r.ok ? 'ok' : 'bad'}"><span class="dotind" style="background:var(--${r.ok ? 'ok' : 'bad'})"></span>${esc(r.text)}</div>`;
  }

  // Step 3 — Branding & display (optional)
  function renderBranding(body, foot) {
    $('obKicker').textContent = 'Step 3 of 4';
    $('obTitle').textContent = 'Make it yours';
    $('obSub').textContent = 'Optional — set the name and theme every viewer sees. Change any of this later in Settings.';
    const curTheme = ob.brand.theme || document.documentElement.getAttribute('data-theme') || 'dark';
    // Seed from state so a re-render (e.g. toggling the theme) keeps typed values.
    body.innerHTML = `
      <div class="ob-fields">
        <label class="ob-fld"><span>Site name</span><input id="obBrandName" value="${esc(ob.brand.name || '')}" placeholder="Intercom Matrix" /></label>
        <label class="ob-fld"><span>Subtitle</span><input id="obBrandSub" value="${esc(ob.brand.sub || '')}" placeholder="Live intercom matrix" /></label>
        <div class="ob-fld"><span>Theme</span>
          <div class="ob-seg ob-theme-seg" id="obThemeSeg">
            <div class="opt ${curTheme === 'dark' ? 'active' : ''}" data-ob="theme-dark"><div class="t">◐ Dark</div></div>
            <div class="opt ${curTheme === 'light' ? 'active' : ''}" data-ob="theme-light"><div class="t">☀ Light</div></div>
          </div>
        </div>
      </div>`;
    foot.innerHTML = footHTML({ next: 'Continue', skip: 'Skip' });
  }

  // Step 4 — Finish: recap + optional login wall + complete
  function renderFinish(body, foot) {
    $('obKicker').textContent = 'Step 4 of 4';
    $('obTitle').textContent = 'You’re set up';
    $('obSub').textContent = 'A quick recap of how the viewer works, then you’re in.';
    const sysLine = ob.sys.createdId
      ? `System <b>${esc(ob.sys.name)}</b> added${ob.sys.result && ob.sys.result.ok ? ' — ' + esc(ob.sys.result.short || 'ready') : ''}.`
      : 'No system yet — add one any time in <b>Settings → Systems</b>.';
    body.innerHTML = `
      <div class="ob-recap">
        <div class="item"><span class="k">✓</span><div>Signed in as <b>admin</b>. ${esc('')}Manage everything from <b>⚙ Settings</b>.</div></div>
        <div class="item"><span class="k">✓</span><div>${sysLine}</div></div>
        <div class="item"><span class="k">●</span><div><b>Read-only by design.</b> Browse the Matrix, Conferences and Panels. Export any view to Excel with <b>⬇ Excel</b>.</div></div>
        <div class="item"><span class="k">●</span><div><b>Need a change?</b> File it under <b>Requests</b> → hand the engineer the grouped <b>Work order</b> → upload the next print to auto-verify.</div></div>
      </div>
      <label class="ob-toggle">
        <input type="checkbox" id="obRequireLogin" />
        <span class="tx"><b>Require sign-in to view</b><span>On a trusted network you can leave this off — anonymous visitors get read-only access. Turn it on to gate everything behind a login.</span></span>
      </label>`;
    foot.innerHTML = footHTML({ next: 'Finish setup →', nextAct: 'finish', skip: null });
  }

  // ---- actions ---------------------------------------------------------------
  function onClick(e) {
    const t = e.target.closest('[data-ob]'); if (!t) return;
    const act = t.dataset.ob;
    const handlers = {
      next: () => go(+1),
      back: () => go(-1),
      skip: () => go(+1),
      'create-admin': createAdmin,
      'reveal-login': revealLogin,
      'path-rrcs': () => { ob.sys.path = 'rrcs'; ob.sys.result = null; render(); },
      'path-print': () => { ob.sys.path = 'print'; ob.sys.result = null; render(); },
      'test-rrcs': testRrcs,
      'pick-print': () => $('obPrintFile').click(),
      'theme-dark': () => pickTheme('dark'),
      'theme-light': () => pickTheme('light'),
      finish: finish,
    };
    if (handlers[act]) { e.preventDefault(); handlers[act](); }
  }

  // Advance/retreat, capturing this step's inputs first.
  function go(delta) {
    if (delta > 0 && !captureStep()) return;     // validation blocked it
    ob.idx = Math.max(0, Math.min(STEPS.length - 1, ob.idx + delta));
    // Skip the admin step backwards/forwards once it's satisfied.
    if (STEPS[ob.idx].key === 'admin' && (ob.adminDone || (ob.status && ob.status.steps.admin)) && delta > 0) ob.idx++;
    render();
  }

  // Returns false to block forward navigation (with a message already shown).
  function captureStep() {
    const key = STEPS[ob.idx].key;
    if (key === 'admin' && !ob.adminDone && !(ob.status && ob.status.steps.admin)) {
      setMsg('Create the admin account (or sign in) to continue.'); return false;
    }
    if (key === 'branding') captureBranding();   // stash for finish() + a later Back
    return true;
  }

  async function createAdmin() {
    const u = $('obAdminUser').value.trim(), n = $('obAdminName').value.trim();
    const p = $('obAdminPass').value, p2 = $('obAdminPass2').value;
    if (!u || !p) return setMsg('Username and password are required.');
    if (p.length < 6) return setMsg('Password must be at least 6 characters.');
    if (p !== p2) return setMsg('Passwords don’t match.');
    try {
      $('obNext').disabled = true;
      await sendJSON('/api/onboarding/admin', 'POST', { username: u, password: p, displayName: n });
      ob.adminDone = true;
      setMsg('Admin created — you’re signed in.', 'ok');
      ob.idx = STEPS.findIndex((s) => s.key === 'system');
      render();
    } catch (err) {
      setMsg(err.message || 'Could not create the admin account.');
      const nb = $('obNext'); if (nb) nb.disabled = false;
    }
  }

  function revealLogin() {
    const slot = $('obLoginSlot'); if (!slot || slot.dataset.open) return;
    slot.dataset.open = '1';
    slot.innerHTML = `<div style="margin-top:14px">${loginFormHTML()}</div>`;
    const f = slot.querySelector('input'); if (f) f.focus();
  }

  async function bootstrapLogin() {
    const u = ($('obLoginUser') || {}).value, p = ($('obLoginPass') || {}).value;
    if (!u || !p) return setMsg('Enter the bootstrap admin credentials.');
    try {
      const me = await sendJSON('/api/auth/login', 'POST', { username: u, password: p });
      if (me.role !== 'admin') { setMsg('That account isn’t an admin — setup needs an admin.'); return; }
      ob.adminDone = true;
      setMsg('Signed in.', 'ok');
      ob.idx = STEPS.findIndex((s) => s.key === 'system');
      render();
    } catch (err) { setMsg(err.message || 'Sign-in failed.'); }
  }

  // A privileged step (system create, settings write, print upload) came back
  // 401/403 — the admin session is gone (expired, cleared, or the server was
  // restarted with a fresh DB). Don't dead-end on the raw gate error: send the
  // user back to re-establish admin so they're granted access again.
  function isAuthLoss(err) { return err && (err.status === 401 || err.status === 403); }
  async function recoverLostSession() {
    ob.adminDone = false;
    ob.sys.busy = false; ob.sys.result = null;
    try { ob.status = await getJSON('/api/onboarding'); } catch { /* keep going */ }
    ob.idx = STEPS.findIndex((s) => s.key === 'admin');
    render();
    setMsg('Your setup session was lost — please create the admin account again to continue.');
  }

  // Create the system (if needed), enable live polling, probe once.
  async function testRrcs() {
    const s = ob.sys;
    s.name = $('obSysName').value.trim() || 'Studio A';
    s.host = $('obSysHost').value.trim();
    s.port = Number($('obSysPort').value) || 8193;
    if (!s.host) return setMsg('Enter the controller host or IP.');
    try {
      s.busy = 'Connecting…'; s.result = null; renderSysResult(); $('obTest').disabled = true;
      if (!s.createdId) s.createdId = await createSystemFor({ host: s.host, port: s.port });
      else await sendJSON('/api/systems/' + encodeURIComponent(s.createdId), 'PATCH', { host: s.host, port: s.port });
      await sendJSON('/api/settings', 'PATCH', { safety: { rrcsEnabled: true } });   // live view needs polling on
      const st = await sendJSON('/api/refresh?system=' + encodeURIComponent(s.createdId), 'POST');
      s.busy = false;
      if (st.ok && st.counts) {
        s.result = { ok: true, short: `${st.counts.panels} panels`, text: `Connected — ${st.counts.panels} panels · ${st.counts.conferences} conferences.` };
      } else {
        s.result = { ok: false, text: 'Couldn’t reach the controller: ' + (st.lastError || st.error || 'no response') + '. The system is saved — fix the host later in Settings.' };
      }
    } catch (err) {
      if (isAuthLoss(err)) return recoverLostSession();
      s.busy = false;
      s.result = { ok: false, text: err.message || 'Connection test failed.' };
    }
    const tb = $('obTest'); if (tb) tb.disabled = false;
    renderSysResult();
    syncNextEnabled();
  }

  async function uploadPrint(file) {
    const s = ob.sys;
    s.name = ($('obSysName') || {}).value.trim() || s.name || 'System';
    try {
      s.busy = `Parsing ${file.name}…`; s.result = null; renderSysResult();
      if (!s.createdId) s.createdId = await createSystemFor({});           // offline: no host
      const info = await sendRaw('/api/print-file?system=' + encodeURIComponent(s.createdId) + '&name=' + encodeURIComponent(file.name), await file.arrayBuffer());
      s.busy = false;
      const c = info.conferences != null ? `${info.conferences} conferences` : 'loaded';
      const k = info.keyAssignments != null ? ` · ${info.keyAssignments} keys` : '';
      // text is escaped wholesale by renderSysResult(); keep raw here to avoid double-escaping.
      s.result = { ok: true, short: c, text: `Imported ${file.name} — ${c}${k}.` };
    } catch (err) {
      if (isAuthLoss(err)) return recoverLostSession();
      s.busy = false;
      s.result = { ok: false, text: err.message || 'Could not parse that print.' };
    }
    renderSysResult();
    syncNextEnabled();
  }

  // Create the system with a slug id, retrying once on an id collision (re-run).
  async function createSystemFor(extra) {
    const base = slugify(ob.sys.name);
    for (const id of [base, base + '-2', base + '-3']) {
      try {
        await sendJSON('/api/systems', 'POST', { id, name: ob.sys.name, ...extra });
        return id;
      } catch (err) {
        if (!/already exists/i.test(err.message)) throw err;
      }
    }
    throw new Error('A system with that name already exists — pick another name.');
  }

  function syncNextEnabled() {
    const nb = $('obNext'); if (nb) nb.disabled = !ob.sys.createdId;
  }

  function captureBranding() {
    if ($('obBrandName')) ob.brand.name = $('obBrandName').value.trim();
    if ($('obBrandSub')) ob.brand.sub = $('obBrandSub').value.trim();
  }

  function pickTheme(theme) {
    captureBranding();                  // don't lose typed name/subtitle on re-render
    ob.brand.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);  // live preview
    render();
  }

  async function finish() {
    const nb = $('obNext');
    try {
      if (nb) { nb.disabled = true; nb.innerHTML = '<span class="spin">◐</span> Finishing…'; }
      const requireLogin = !!($('obRequireLogin') || {}).checked;
      // Persist branding/theme (if the user touched them) + the login wall choice,
      // then stamp completion so the wizard never re-launches.
      const patch = { meta: { onboardedAt: new Date().toISOString() }, safety: { requireLogin } };
      const brand = {};
      if (ob.brand.name) brand.siteName = ob.brand.name;
      if (ob.brand.sub != null && ob.brand.sub !== '') brand.subtitle = ob.brand.sub;
      if (ob.brand.theme) patch.display = { theme: ob.brand.theme };
      if (ob.sys.createdId) brand.defaultSystem = ob.sys.createdId;
      if (Object.keys(brand).length) patch.branding = brand;
      await sendJSON('/api/settings', 'PATCH', patch);
      window.location.reload();
    } catch (err) {
      if (isAuthLoss(err)) return recoverLostSession();
      setMsg(err.message || 'Could not finish setup.');
      if (nb) { nb.disabled = false; nb.textContent = 'Finish setup →'; }
    }
  }

  // ---- entry points ----------------------------------------------------------
  function open() {
    ensureRoot();
    // Resume at the first incomplete step (handles "admin made, no system yet").
    if (ob.status && ob.status.steps.admin && !ob.status.steps.system) { ob.adminDone = true; ob.idx = STEPS.findIndex((s) => s.key === 'system'); }
    else ob.idx = 0;
    $('obBackdrop').classList.remove('hidden');
    render();
  }

  // Called by app.js init(). Returns true if the wizard took over the screen.
  async function maybeStart() {
    try {
      ob.status = await getJSON('/api/onboarding');
      if (!ob.status.active) return false;
      open();
      return true;
    } catch { return false; }   // never block the app on a probe failure
  }

  // Admin "Re-run setup" — force the wizard even when already onboarded.
  async function startManual() {
    try { ob.status = await getJSON('/api/onboarding'); } catch { ob.status = { steps: { admin: true, system: false }, canCreateAdmin: false }; }
    ob.adminDone = true;                       // re-run implies an admin is already signed in
    ensureRoot();
    ob.idx = 0;
    $('obBackdrop').classList.remove('hidden');
    render();
  }

  // Delegated file-input change (the input is re-created each render).
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'obPrintFile') {
      const f = e.target.files[0]; if (f) uploadPrint(f);
    }
  });
  // Drag-and-drop onto the print drop zone.
  document.addEventListener('dragover', (e) => { if (e.target.closest && e.target.closest('#obDrop')) { e.preventDefault(); e.target.closest('#obDrop').classList.add('drag'); } });
  document.addEventListener('dragleave', (e) => { const d = e.target.closest && e.target.closest('#obDrop'); if (d) d.classList.remove('drag'); });
  document.addEventListener('drop', (e) => {
    const d = e.target.closest && e.target.closest('#obDrop'); if (!d) return;
    e.preventDefault(); d.classList.remove('drag');
    const f = e.dataTransfer.files[0]; if (f) uploadPrint(f);
  });

  window.Onboarding = { maybeStart, startManual };
})();
