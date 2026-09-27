// public/all-systems.js — client helpers for the "All systems" view (system=all):
// every system in one matrix, conferences matched across systems merged into one
// column (lib/combined-model). This file owns the system chips, the "real name
// per system" tooltips, and routing per-system actions (raising a request) back
// to one system.
//
// Loaded BEFORE app.js; everything here runs lazily, after app.js globals exist.

/* global state, esc, els, switchSystem, openComposer, allDests, tipAttr, Names */

const ALL_SYSTEMS = 'all';
const ALL_SYSTEMS_NAME = 'All systems';
const SYS_SLOTS = 6;   // chip colours cycle through .sys-0 … .sys-5

const isAllView = () => !!(state.data && state.data.source === 'combined');
const sysName = (id) => ((state.systems || []).find((s) => s.id === id) || {}).name || id;
function sysSlot(id) {
  const i = (state.systems || []).findIndex((s) => s.id === id);
  return i < 0 ? 0 : i % SYS_SLOTS;
}
// A coloured system tag. Only meaningful in the All systems view — callers gate on isAllView().
const sysChip = (id, name) => `<span class="sys-chip sys-${sysSlot(id)}" title="${esc(name || sysName(id))}">${esc(name || sysName(id))}</span>`;
const sysChips = (ids) => ids.map((id) => sysChip(id)).join('');

// "Matched across 3 systems" + each system's real name, for hover titles.
function variantsTitle(d) {
  if (!d || !d.variants) return '';
  return d.variants.map((v) => `${v.sysName}: ${v.name}${v.label ? ' (' + v.label + ')' : ''}`).join('\n');
}
// The conference's real name on one system (col → system → name), for cell titles.
function variantNameOn(col, system) {
  const v = col && col.variants && col.variants.find((x) => x.system === system);
  return v ? v.name : col && col.name;
}

// ---------- routing per-system actions ----------
// A small anchored menu: resolves with the chosen option, or null if dismissed.
function chooseSystem(anchor, title, options) {
  return new Promise((resolve) => {
    document.querySelectorAll('.sys-menu').forEach((m) => m.remove());
    const menu = document.createElement('div');
    menu.className = 'sys-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div class="sys-menu-h">${esc(title)}</div>` + options.map((o, i) =>
      `<button role="menuitem" data-i="${i}">${sysChip(o.system, o.sysName)}<span${tipAttr(o.tip)}>${esc(o.hint || '')}</span></button>`).join('');
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + window.scrollY + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, r.right + window.scrollX - 260))}px`;
    document.body.appendChild(menu);
    const done = (val) => { menu.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const outside = (e) => { if (!menu.contains(e.target)) done(null); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    menu.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) done(options[Number(b.dataset.i)]); });
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
    const first = menu.querySelector('button'); if (first) first.focus();
  });
}

// Requests belong to ONE system and use its real names. In the All systems view,
// pick the system (asking only when there's a choice), switch to it, then open
// the composer seeded with that system's names. Elsewhere, open it directly.
// seed: { conference, confIdx, panel, panelAddr, op }
async function requestChange(seed, anchor) {
  const s = seed || {};
  if (!isAllView()) { openComposer({ conference: s.conference, panel: s.panel, op: s.op || 'add_member' }); return; }
  let options;
  if (s.confIdx != null && allDests()[s.confIdx]) {
    options = allDests()[s.confIdx].variants.map((v) => ({ system: v.system, sysName: v.sysName, conference: v.name, hint: Names.short(v), tip: v.name }));
  } else if (s.panelAddr) {
    const p = (state.data.panels || []).find((x) => x.addr === s.panelAddr);
    options = p ? [{ system: p.system, sysName: p.sysName, panel: p.port }] : [];
  } else {
    options = (state.data.systems || []).map((x) => ({ system: x.id, sysName: x.name }));
  }
  if (!options.length) return;
  const pick = options.length === 1 ? options[0] : await chooseSystem(anchor || document.body, 'Raise the request on which system?', options);
  if (!pick) return;
  els.system.value = pick.system;
  await switchSystem(pick.system);
  openComposer({ conference: pick.conference, panel: pick.panel, op: s.op || 'add_member' });
}
