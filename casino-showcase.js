// casino-showcase.js (v223)
// Finishing touches for every casino table, added on top of the games
// without changing how any of them play:
//   - playing cards drawn like real ones: proper pip layouts for 2-10,
//     framed court cards for J/Q/K, a single large suit on aces
//   - every game's result line becomes a clear win / loss / push banner
//   - roulette shows the winning number as a coloured ball
//   - Blackjack, Baccarat and War get the rules printed on the felt
// Everything here reacts to what the games already render, so a game
// update can't be broken by it; if anything fails it simply does nothing.
(function(){
  'use strict';
  const host = () => document.getElementById('tab-casino') || document.body;

  // ---------- playing cards ----------
  // [x%, y%] inside the pip area; anything below the middle is drawn upside
  // down, as on a real card
  const PIPS = {
    2: [[50, 0], [50, 100]],
    3: [[50, 0], [50, 50], [50, 100]],
    4: [[0, 0], [100, 0], [0, 100], [100, 100]],
    5: [[0, 0], [100, 0], [50, 50], [0, 100], [100, 100]],
    6: [[0, 0], [100, 0], [0, 50], [100, 50], [0, 100], [100, 100]],
    7: [[0, 0], [100, 0], [50, 25], [0, 50], [100, 50], [0, 100], [100, 100]],
    8: [[0, 0], [100, 0], [50, 25], [0, 50], [100, 50], [50, 75], [0, 100], [100, 100]],
    9: [[0, 0], [100, 0], [0, 33.3], [100, 33.3], [50, 50], [0, 66.6], [100, 66.6], [0, 100], [100, 100]],
    10: [[0, 0], [100, 0], [50, 16.6], [0, 33.3], [100, 33.3], [0, 66.6], [100, 66.6], [50, 83.3], [0, 100], [100, 100]],
  };
  function dressCard(card){
    if(!card || card.dataset.czDressed || card.classList.contains('pc-back')) return;
    const tl = card.querySelector('.pc-pip-tl'); const big = card.querySelector('.pc-suit-big');
    if(!tl || !big) return;
    const rank = (tl.firstChild && tl.firstChild.nodeType === 3 ? tl.firstChild.textContent : tl.textContent).trim().replace(/[^0-9AJQK]/gi, '').toUpperCase();
    const suit = (tl.querySelector('.pc-suit-mini') || big).textContent.trim();
    if(!rank || !suit) return;
    card.dataset.czDressed = '1';
    card.dataset.rank = rank;
    // tiny cards (history strips, mini seats) keep the single suit: the
    // stylesheet hides the pips there with a container query
    const n = Number(rank);
    if(n >= 2 && n <= 10){
      const box = document.createElement('div'); box.className = 'cz-pips cz-pips-' + n; box.setAttribute('aria-hidden', 'true');
      PIPS[n].forEach(([x, y]) => { const s = document.createElement('span'); s.textContent = suit; s.style.left = x + '%'; s.style.top = y + '%'; if(y > 50) s.className = 'flip'; box.appendChild(s); });
      card.appendChild(box); card.classList.add('cz-has-pips');
    } else if(rank === 'J' || rank === 'Q' || rank === 'K'){
      const f = document.createElement('div'); f.className = 'cz-court'; f.setAttribute('aria-hidden', 'true');
      f.innerHTML = `<span class="cz-court-rank">${rank}</span><span class="cz-court-suit">${suit}</span><span class="cz-court-rank flip">${rank}</span>`;
      card.appendChild(f); card.classList.add('cz-has-court');
    } else if(rank === 'A'){
      card.classList.add('cz-ace');
    }
  }

  // ---------- result banners ----------
  const RESULT_IDS = ['bjOutcomeMsg', 'bacOutcomeMsg', 'warOutcomeMsg', 'rouletteResultMsg', 'crapsTotalMsg', 'slotsResultMsg', 'vpOutcomeMsg', 'plinkoResultMsg', 'bigWheelResultMsg', 'minesResultMsg', 'crashResultMsg', 'donResultMsg', 'dailySpinResultMsg', 'bjPPOutcomeMsg', 'bacPPOutcomeMsg', 'warPPOutcomeMsg', 'bjInsuranceOutcomeMsg'];
  function stateOf(el){
    const t = (el.textContent || '').trim();
    if(!t) return '';
    const c = (el.style.color || '').toLowerCase();
    if(/win|#7fe3a2|34, ?163|var\(--win\)/.test(c) || el.classList.contains('bj-outcome-jackpot')) return 'win';
    if(/loss|#e5484d|#ff8a80|var\(--loss\)/.test(c)) return 'loss';
    const m = t.match(/([+-−])\s*\$?([\d,]+)\s*XP/i) || t.match(/Total:\s*([+-−])([\d,]+)/i);
    if(m) return m[1] === '+' ? (Number(m[2].replace(/,/g, '')) > 0 ? 'win' : 'push') : 'loss';
    if(/\b(win|won|wins|cashed|banked|jackpot)\b/i.test(t)) return 'win';
    if(/\b(lose|lost|loses|bust|crashed|boom|house wins)\b/i.test(t)) return 'loss';
    if(/\b(push|tie|void|returned|back)\b/i.test(t)) return 'push';
    return 'info';
  }
  function markResult(el){
    const s = stateOf(el);
    if(el.dataset.czState !== s){ el.dataset.czState = s; if(s){ el.classList.remove('cz-pop'); void el.offsetWidth; el.classList.add('cz-pop'); } }
    if(el.id === 'rouletteResultMsg') rouletteBall(el);
  }
  function watchResults(){
    RESULT_IDS.forEach(id => {
      const el = document.getElementById(id);
      if(!el || el.dataset.czWatch) return;
      el.dataset.czWatch = '1'; el.classList.add('cz-result');
      markResult(el);
      new MutationObserver(() => markResult(el)).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    });
  }

  // ---------- roulette: the winning number as a ball ----------
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  function rouletteBall(msg){
    let ball = document.getElementById('czRouletteBall');
    const m = (msg.textContent || '').trim().match(/^(00|\d{1,2})\b/);
    if(!m){ if(ball) ball.hidden = true; return; }
    if(!ball){
      ball = document.createElement('div'); ball.id = 'czRouletteBall'; ball.className = 'cz-ball'; ball.setAttribute('aria-hidden', 'true');
      msg.parentNode.insertBefore(ball, msg);
    }
    const n = m[1], num = Number(n);
    ball.className = 'cz-ball ' + (n === '0' || n === '00' ? 'green' : RED.has(num) ? 'red' : 'black');
    ball.textContent = n; ball.hidden = false;
    ball.classList.remove('cz-pop'); void ball.offsetWidth; ball.classList.add('cz-pop');
  }

  // ---------- rules printed on the felt ----------
  const PRINT = {
    casinoGameBlackjack: ['Blackjack pays 3 to 2', 'Dealer stands on 17'],
    casinoGameBaccarat: ['Player and Banker pay 1 to 1', 'Closest to nine wins'],
    casinoGameWar: ['Highest card wins', 'Ties go to war'],
  };
  function printFelt(){
    Object.entries(PRINT).forEach(([panelId, lines]) => {
      const panel = document.getElementById(panelId); if(!panel) return;
      const table = panel.querySelector('.bj-table'); if(!table || table.querySelector('.cz-print')) return;
      const boxes = table.querySelectorAll(':scope > .table-box');
      if(boxes.length < 2) return;
      const p = document.createElement('div'); p.className = 'cz-print'; p.setAttribute('aria-hidden', 'true');
      p.innerHTML = `<span>${lines[0]}</span><i></i><span>${lines[1]}</span>`;
      boxes[0].after(p);
    });
  }

  // ---------- run ----------
  function sweep(root){ (root || host()).querySelectorAll('.playing-card:not([data-cz-dressed])').forEach(dressCard); }
  function init(){
    try{ watchResults(); printFelt(); sweep(); }catch(e){}
    const target = host();
    let queued = false;
    new MutationObserver((muts) => {
      for(const m of muts){
        for(const n of m.addedNodes){
          if(n.nodeType !== 1) continue;
          if(n.classList && n.classList.contains('playing-card')) dressCard(n);
          else if(n.querySelector && n.querySelector('.playing-card')) n.querySelectorAll('.playing-card:not([data-cz-dressed])').forEach(dressCard);
        }
      }
      if(!queued){ queued = true; requestAnimationFrame(() => { queued = false; try{ watchResults(); printFelt(); }catch(e){} }); }
    }).observe(target, { childList: true, subtree: true });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.czShowcase = { dressCard, sweep };
})();
