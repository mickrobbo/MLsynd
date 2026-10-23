// app-a11y.js (v200)
// Accessibility layer for the whole app, kept in one place so it covers
// screens built at runtime too:
//   - every pop-up is announced as a dialog, takes focus when it opens,
//     closes with Escape and hands focus back to whatever opened it
//   - clickable tiles that aren't real buttons can be reached with the
//     keyboard and work with Enter or Space
//   - form fields without a visible label get a spoken one
//   - toasts are read out, and the tab bar says which tab you're on
// None of this changes how anything looks except the keyboard focus ring.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ---------- toasts are announced ----------
  function liveRegions(){
    let host = $('toastHost');
    if(!host){ host = document.createElement('div'); host.id = 'toastHost'; document.body.appendChild(host); }
    if(!host.hasAttribute('role')){ host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); }
  }

  // ---------- dialogs ----------
  const DIALOG_SEL = '.profile-modal, [id$="Modal"]';
  const lastOpener = new WeakMap();
  let lastFocus = null;
  // Focus only jumps into a pop-up for keyboard and switch users; a tap
  // shouldn't leave a focus ring sitting on the first button.
  let keyboardUser = false;
  document.addEventListener('keydown', (e) => { if(e.key === 'Tab' || e.key === 'Enter' || e.key === ' ' || String(e.key || '').startsWith('Arrow')) keyboardUser = true; }, true);
  document.addEventListener('pointerdown', () => { keyboardUser = false; }, true);
  document.addEventListener('focusin', (e) => { if(!e.target.closest(DIALOG_SEL)) lastFocus = e.target; }, true);
  document.addEventListener('click', (e) => { const t = e.target.closest('button, a, [role=button], [tabindex]'); if(t && !t.closest(DIALOG_SEL)) lastFocus = t; }, true);
  const isOpen = (m) => m.classList.contains('open') || (m.style.display && m.style.display !== 'none' && getComputedStyle(m).display !== 'none');
  function focusables(root){
    return [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null || el === document.activeElement);
  }
  function prepDialog(m){
    if(m.dataset.a11y) return;
    m.dataset.a11y = '1';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    const h = m.querySelector('h1, h2, h3, .profile-name, [class*="title"]');
    if(h){ if(!h.id) h.id = (m.id || 'dlg' + Math.random().toString(36).slice(2, 7)) + 'Title'; m.setAttribute('aria-labelledby', h.id); }
    else if(!m.getAttribute('aria-label')) m.setAttribute('aria-label', (m.id || 'Dialog').replace(/Modal$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'));
    const close = m.querySelector('.profile-close, [id$="CloseBtn"], [aria-label="Close"]');
    if(close && !close.getAttribute('aria-label')) close.setAttribute('aria-label', 'Close');
    new MutationObserver(() => syncDialog(m)).observe(m, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  const openState = new WeakMap();
  function syncDialog(m){
    const open = isOpen(m);
    if(open === !!openState.get(m)) return;
    openState.set(m, open);
    if(open){
      lastOpener.set(m, lastFocus);
      // move focus inside, after the open animation has a frame to start
      requestAnimationFrame(() => {
        if(!keyboardUser || m.contains(document.activeElement)) return;
        const f = focusables(m);
        const target = f.find(el => !el.matches('.profile-close, [id$="CloseBtn"]')) || f[0];
        if(target) target.focus({ preventScroll: true });
        else { m.setAttribute('tabindex', '-1'); m.focus({ preventScroll: true }); }
      });
    } else {
      const back = lastOpener.get(m);
      if(keyboardUser && back && document.contains(back) && back.offsetParent !== null) back.focus({ preventScroll: true });
    }
  }
  function topOpenDialog(){
    const open = [...document.querySelectorAll(DIALOG_SEL)].filter(isOpen);
    return open.sort((a, b) => (parseInt(getComputedStyle(b).zIndex) || 0) - (parseInt(getComputedStyle(a).zIndex) || 0))[0] || null;
  }
  document.addEventListener('keydown', (e) => {
    const m = (e.key === 'Escape' || e.key === 'Tab') ? topOpenDialog() : null;
    if(!m) return;
    if(e.key === 'Escape'){
      const close = m.querySelector('.profile-close, [id$="CloseBtn"], [aria-label="Close"]');
      if(close){ e.preventDefault(); close.click(); }
      else if(m.classList.contains('open')){ e.preventDefault(); m.classList.remove('open'); }
      return;
    }
    // keep Tab inside the open dialog
    const f = focusables(m); if(!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  });

  // ---------- clickable tiles that aren't buttons ----------
  const CLICKABLE = [
    '.casino-hub-bubble', '.xp-lb-row', '.weekly-reminder-check-row', '.form-guide-row', '.bj-chip',
    '[id$="ChipDisplay"]',
  ].join(',');
  const TABS = '.casino-social-tab, .lb-time-btn:not(button)';
  function keyboardify(root){
    (root || document).querySelectorAll(CLICKABLE).forEach(el => {
      if(el.dataset.a11yKb || el.matches('button, a, input, select, textarea') || el.closest('button, a')) return;
      el.dataset.a11yKb = '1';
      if(!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if(!el.hasAttribute('tabindex')) el.tabIndex = 0;
      if(!el.getAttribute('aria-label')){ const t = el.textContent.replace(/\s+/g, ' ').trim(); if(!t) el.setAttribute('aria-label', el.title || 'Open'); }
    });
    (root || document).querySelectorAll(TABS).forEach(el => {
      if(el.dataset.a11yKb) return;
      el.dataset.a11yKb = '1';
      el.setAttribute('role', 'tab'); el.tabIndex = 0;
      const sync = () => el.setAttribute('aria-selected', el.classList.contains('active') ? 'true' : 'false');
      sync(); new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });
      if(el.parentElement && !el.parentElement.hasAttribute('role')) el.parentElement.setAttribute('role', 'tablist');
    });
  }
  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target;
    if(!el || !el.dataset || !el.dataset.a11yKb) return;
    e.preventDefault(); el.click();
  });

  // ---------- spoken labels for unlabelled fields ----------
  const FIELD_NAMES = {
    adminWkOdds: 'Odds', adminWkResult: 'Result', adminWibName: 'Bettor', adminWibResult: 'Result', adminWibAmount: 'Amount',
    adminWibSgmResult: 'SGM result', adminWibSgmAmount: 'SGM amount', adminIndName: 'Bettor', adminIndOutlay: 'Outlay', adminIndReturn: 'Return',
  };
  const ID_NAMES = {
    sportSelect: 'Sport', adminWeekLabel: 'Week', adminGMultiOut: 'Group multi outlay', adminGMultiRet: 'Group multi return',
    adminGLottoOut: 'Lotto outlay', adminGLottoRet: 'Lotto return', adminGBonus: 'Bonus pot', adminGSgmWin: 'SGM bonus win',
    adminSlipLabel: 'Slip label', adminSlipUrl: 'Slip link', adminNewMemberName: 'New member name', adminBonusAmount: 'Bonus XP amount', adminRotationOrderInput: 'Bettor rotation order',
  };
  function labelFields(root){
    (root || document).querySelectorAll('input:not([type=hidden]), select, textarea').forEach(el => {
      if(el.dataset.a11yLbl) return;
      el.dataset.a11yLbl = '1';
      if(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))) return;
      let name = (el.id && ID_NAMES[el.id]) || [...el.classList].map(c => FIELD_NAMES[c]).find(Boolean) || el.placeholder || el.title || '';
      // prefix with the row's person when the field sits in a per-member row
      const row = el.closest('[data-name], [data-member], tr, .admin-entry-row, .admin-fin-row-entry');
      const who = row && (row.dataset.name || row.dataset.member || (row.querySelector('.admin-entry-name, td:first-child, span') || {}).textContent || '').trim();
      if(who && name && who.length < 30 && !/^\$|^\d/.test(who)) name = `${who} ${name.toLowerCase()}`;
      if(name) el.setAttribute('aria-label', name);
    });
  }

  // ---------- tab bar: which tab is current ----------
  function tabBar(){
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      if(btn.dataset.a11yTab) return;
      btn.dataset.a11yTab = '1';
      const sync = () => { if(btn.classList.contains('active')) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current'); };
      sync(); new MutationObserver(sync).observe(btn, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // ---------- run now, and on anything built later ----------
  let pending = null;
  function sweep(){
    pending = null;
    liveRegions();
    document.querySelectorAll(DIALOG_SEL).forEach(prepDialog);
    keyboardify();
    labelFields();
    tabBar();
  }
  function init(){
    sweep();
    // one debounced observer instead of many: re-sweeps after the app
    // renders new rows, at most every 400ms, and only during idle time
    new MutationObserver(() => {
      if(pending) return;
      pending = window.requestIdleCallback ? requestIdleCallback(sweep, { timeout: 800 }) : setTimeout(sweep, 400);
    }).observe(document.body, { childList: true, subtree: true });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
