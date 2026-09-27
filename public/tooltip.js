// public/tooltip.js — instant hover text for anything carrying data-tip (the
// long name behind a conference alias, a panel's full name).
//
// The native title attribute waits about a second before it shows; this shows
// on pointer-over and on keyboard focus with no delay. One shared element and
// document-level delegation, so views that re-render need no wiring.

(function () {
  'use strict';

  const GAP = 6;    // px between the target and the tip
  const EDGE = 8;   // px kept clear of the viewport edge

  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.id = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);

  let cur = null;

  // Below the target, flipped above when there's no room; clamped to the viewport.
  function place(el) {
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let top = r.bottom + GAP;
    if (top + h > vh - EDGE && r.top - GAP - h >= EDGE) top = r.top - GAP - h;
    const left = Math.min(Math.max(EDGE, r.left), vw - w - EDGE);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function show(el) {
    if (cur) cur.removeAttribute('aria-describedby');
    cur = el;
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    place(el);
    el.setAttribute('aria-describedby', tip.id);
  }
  function hide() {
    if (!cur) return;
    cur.removeAttribute('aria-describedby');
    cur = null;
    tip.hidden = true;
  }
  function onOver(e) {
    const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (el === cur) return;
    if (el && el.dataset.tip) show(el); else hide();
  }

  document.addEventListener('pointerover', onOver);
  // Keyboard focus only: a click also focuses links, and usually re-renders them away.
  document.addEventListener('focusin', (e) => { if (e.target instanceof Element && e.target.matches(':focus-visible')) onOver(e); });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) hide(); });   // left the window
  // A click or keystroke usually re-renders the view under the pointer; drop the
  // tip rather than leave it pinned to a detached element.
  document.addEventListener('pointerdown', hide);
  document.addEventListener('keydown', hide);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();
