// ---- Roulette ----
// American double-zero (0/00) wheel — 38 pockets, real physical wheel
// order. Pocket identity is kept as a STRING everywhere ('0', '00', '17'
// etc.) specifically because '00' has no sane numeric representation
// without colliding with plain 0 — every comparison downstream (color,
// odd/even, high/low, dozens) treats '0'/'00' as the two green pockets
// that lose every outside bet, matching the real house-edge rule.
// The ball's orbit rotates (via a plain CSS transform transition, several
// full spins plus the exact landing angle) around a STATIC wheel, rather
// than spinning the numbered wheel itself.
const ROULETTE_WHEEL_ORDER = ['0','28','9','26','30','11','7','20','32','17','5','22','34','15','3','24','36','13','1','00','27','10','25','29','12','8','19','31','18','6','21','33','16','4','23','35','14','2'];
const ROULETTE_RED = new Set(['1','3','5','7','9','12','14','16','18','19','21','23','25','27','30','32','34','36']);
function rouletteColorOf(pocket){ if(pocket === '0' || pocket === '00') return 'green'; return ROULETTE_RED.has(pocket) ? 'red' : 'black'; }
let rouletteWheelBuilt = false;
let rouletteBallRotation = 0;
let rouletteHistory = [];
// Multiple simultaneous bets, exactly like a real table — every confirmed
// bet is its own entry here: { id, type, value/nums, label, amount,
// cellEls }. cellEls is kept so tapping an already-placed bet's own
// cell(s) again removes just that one bet, without disturbing any others.
let rouletteActiveBets = [];
let rouletteBetIdCounter = 0;
// Snapshot of the bets that were on the table for the last completed spin —
// powers the "Same Bet" pill so a repeat player doesn't have to re-tap the
// whole table every round. cellEls are real DOM nodes from the (never
// rebuilt) grid, so they're safe to reuse directly.
let rouletteLastBets = [];
// In-progress number taps that haven't yet formed (or been confirmed into)
// a valid inside bet — separate from rouletteActiveBets, which only ever
// holds fully-confirmed, already-placed bets.
let rouletteBuildingNums = [];
// Populated once by rouletteBuildBetGrid() — number/'0'/'00' → its DOM cell.
// Avoids a live CSS query on every bet confirmation.
let rouletteCellByValue = {};

function rouletteBuildWheel(){
  const wheel = document.getElementById('rouletteWheel');
  const n = ROULETTE_WHEEL_ORDER.length;
  const anglePer = 360 / n;
  const stops = ROULETTE_WHEEL_ORDER.map((pocket, i) => {
    const color = rouletteColorOf(pocket);
    const col = color === 'green' ? '#1f7a4a' : (color === 'red' ? '#8c2a22' : '#161616');
    return `${col} ${(i * anglePer).toFixed(3)}deg ${((i + 1) * anglePer).toFixed(3)}deg`;
  });
  wheel.style.background = `conic-gradient(${stops.join(',')})`;
  wheel.innerHTML = ROULETTE_WHEEL_ORDER.map((pocket, i) => {
    const angle = i * anglePer + anglePer / 2;
    return `<div class="roulette-pocket-label" style="transform: rotate(${angle}deg) translateY(-104px) rotate(${-angle}deg);">${pocket}</div>`;
  }).join('');
  rouletteWheelBuilt = true;
}
function rouletteBuildBetGrid(){
  const grid = document.getElementById('rouletteTableGrid');
  let html = '<div class="rt-row rt-zero-row">';
  html += `<div class="rt-cell rt-green" data-bet-type="straight" data-bet-value="0">0</div>`;
  html += `<div class="rt-cell rt-green" data-bet-type="straight" data-bet-value="00">00</div>`;
  html += '</div><div class="rt-number-grid">';
  for(let r = 0; r < 12; r++){
    const base = 34 - r * 3;
    for(let c = 0; c < 3; c++){
      const num = String(base + c);
      const colorClass = rouletteColorOf(num) === 'red' ? 'rt-red-num' : 'rt-black-num';
      html += `<div class="rt-cell ${colorClass}" data-bet-type="straight" data-bet-value="${num}">${num}</div>`;
    }
  }
  html += '</div>';
  // Columns are a real, separate bet from Dozens — 2:1 on all 12 numbers
  // sharing a screen-column (1,4,7...34 / 2,5,8...35 / 3,6,9...36), not
  // the horizontal thirds Dozens covers. Previously only Dozens existed.
  html += `<div class="rt-row rt-columns-row">
    <div class="rt-cell rt-outside" data-bet-type="col1">Col 1 (2:1)</div>
    <div class="rt-cell rt-outside" data-bet-type="col2">Col 2 (2:1)</div>
    <div class="rt-cell rt-outside" data-bet-type="col3">Col 3 (2:1)</div>
  </div>`;
  html += `<div class="rt-row rt-dozens-row">
    <div class="rt-cell rt-outside" data-bet-type="dozen1">1st 12</div>
    <div class="rt-cell rt-outside" data-bet-type="dozen2">2nd 12</div>
    <div class="rt-cell rt-outside" data-bet-type="dozen3">3rd 12</div>
  </div>`;
  html += `<div class="rt-row rt-outside-row">
    <div class="rt-cell rt-outside" data-bet-type="low">1-18</div>
    <div class="rt-cell rt-outside rt-black-cell" data-bet-type="even">EVEN</div>
    <div class="rt-cell rt-outside rt-red-cell" data-bet-type="red">RED</div>
    <div class="rt-cell rt-outside rt-black-cell" data-bet-type="black">BLACK</div>
    <div class="rt-cell rt-outside" data-bet-type="odd">ODD</div>
    <div class="rt-cell rt-outside" data-bet-type="high">19-36</div>
  </div>`;
  grid.innerHTML = html;
  // Cache number → cell once at build time instead of re-querying the DOM
  // with an attribute-selector CSS query every single time a bet is
  // confirmed (rouletteConfirmBuilding runs this lookup on every tap
  // sequence, so it's worth avoiding a live querySelector per number).
  rouletteCellByValue = {};
  grid.querySelectorAll('.rt-cell[data-bet-type="straight"]').forEach(cell => {
    rouletteCellByValue[cell.dataset.betValue] = cell;
    cell.addEventListener('click', () => rouletteToggleNumberCell(cell));
  });
  grid.querySelectorAll('.rt-cell:not([data-bet-type="straight"])').forEach(cell => {
    cell.addEventListener('click', () => rouletteTapOutsideCell(cell));
  });
}
const ROULETTE_BET_LABELS = {
  red: 'Red (1:1)', black: 'Black (1:1)', odd: 'Odd (1:1)', even: 'Even (1:1)',
  low: '1\u201318 (1:1)', high: '19\u201336 (1:1)',
  dozen1: '1st 12 (2:1)', dozen2: '2nd 12 (2:1)', dozen3: '3rd 12 (2:1)',
  col1: 'Column 1 (2:1)', col2: 'Column 2 (2:1)', col3: 'Column 3 (2:1)'
};
// Inside bets are built by geometry, not a menu — tap 1, 2, 3, 4 or 6
// numbers on the grid (in the right adjacent arrangement) and the exact
// bet type/payout is auto-detected from the shape of your selection,
// exactly like tapping the real felt between numbers on a physical table.
// The instant a valid shape forms, it's confirmed as a placed bet using
// whatever chip amount is currently set, and the next tap starts a fresh
// selection — so you can place several different inside bets one after
// another in the same spin, same as an outside bet.
function rouletteNumRow(n){ return Math.floor((n - 1) / 3); }  // 0 = bottom row {1,2,3}
function rouletteNumCol(n){ return (n - 1) % 3; }               // 0 = left column {1,4,7...}
function rouletteDetectBetFromSelection(strNums){
  const hasZero = strNums.includes('0') || strNums.includes('00');
  if(hasZero){
    const set = new Set(strNums);
    if(set.size === 5 && set.has('0') && set.has('00') && set.has('1') && set.has('2') && set.has('3')){
      return { type: 'topline', nums: ['0','00','1','2','3'], label: 'Top Line (0-00-1-2-3) \u2014 6:1' };
    }
    if(set.size === 2){
      // The real zero-adjacent splits available on an American (double-
      // zero) table — 0-00 itself, plus each zero's neighbours across the
      // felt. Anything else touching zero at 2 numbers isn't a real bet.
      const has = (v) => set.has(v);
      if(has('0') && has('00')) return { type: 'split', nums: ['0','00'], label: 'Split 0-00 (17:1)' };
      if(has('0') && has('1')) return { type: 'split', nums: ['0','1'], label: 'Split 0-1 (17:1)' };
      if(has('0') && has('2')) return { type: 'split', nums: ['0','2'], label: 'Split 0-2 (17:1)' };
      if(has('00') && has('2')) return { type: 'split', nums: ['00','2'], label: 'Split 00-2 (17:1)' };
      if(has('00') && has('3')) return { type: 'split', nums: ['00','3'], label: 'Split 00-3 (17:1)' };
      return null;
    }
    if(set.size === 1) return { type: 'straight', value: strNums[0], label: `Straight ${strNums[0]} (35:1)` };
    return null; // any other combination touching 0/00 isn't offered here
  }
  const n = strNums.map(Number).sort((a, b) => a - b);
  if(n.length === 1) return { type: 'straight', value: String(n[0]), label: `Straight ${n[0]} (35:1)` };
  if(n.length === 2){
    const [a, b] = n;
    const adjH = rouletteNumRow(a) === rouletteNumRow(b) && Math.abs(rouletteNumCol(a) - rouletteNumCol(b)) === 1;
    const adjV = rouletteNumCol(a) === rouletteNumCol(b) && Math.abs(rouletteNumRow(a) - rouletteNumRow(b)) === 1;
    if(adjH || adjV) return { type: 'split', nums: n.map(String), label: `Split ${a}-${b} (17:1)` };
    return null;
  }
  if(n.length === 3){
    const r = rouletteNumRow(n[0]);
    if(n.every(x => rouletteNumRow(x) === r) && rouletteNumCol(n[0]) === 0 && rouletteNumCol(n[1]) === 1 && rouletteNumCol(n[2]) === 2){
      return { type: 'street', nums: n.map(String), label: `Street ${n[0]}-${n[2]} (11:1)` };
    }
    return null;
  }
  if(n.length === 4){
    const expected = [n[0], n[0] + 1, n[0] + 3, n[0] + 4];
    if(rouletteNumCol(n[0]) <= 1 && JSON.stringify(n) === JSON.stringify(expected)){
      return { type: 'corner', nums: n.map(String), label: `Corner ${n.join('-')} (8:1)` };
    }
    return null;
  }
  if(n.length === 6){
    const r = rouletteNumRow(n[0]);
    const expected = [3*r+1, 3*r+2, 3*r+3, 3*r+4, 3*r+5, 3*r+6];
    if(JSON.stringify(n) === JSON.stringify(expected)){
      return { type: 'sixline', nums: n.map(String), label: `Double Street ${n[0]}-${n[5]} (5:1)` };
    }
    return null;
  }
  return null;
}
// Whether two grid values are physically adjacent on the felt — the same
// relationship a Split bet requires, plus the zero-column's own neighbours
// (0 sits next to 00/1/2, 00 sits next to 0/2/3). Used to decide whether a
// new tap is plausibly extending the current building selection (toward a
// Corner or Double Street) versus starting an unrelated new bet.
function rouletteAreAdjacent(aStr, bStr){
  if(aStr === bStr) return false;
  const zeroAdj = { '0': ['00','1','2'], '00': ['0','2','3'], '1': ['0'], '2': ['0','00'], '3': ['00'] };
  if(zeroAdj[aStr] && zeroAdj[aStr].includes(bStr)) return true;
  if(zeroAdj[bStr] && zeroAdj[bStr].includes(aStr)) return true;
  if(aStr === '0' || aStr === '00' || bStr === '0' || bStr === '00') return false;
  const a = Number(aStr), b = Number(bStr);
  const adjH = rouletteNumRow(a) === rouletteNumRow(b) && Math.abs(rouletteNumCol(a) - rouletteNumCol(b)) === 1;
  const adjV = rouletteNumCol(a) === rouletteNumCol(b) && Math.abs(rouletteNumRow(a) - rouletteNumRow(b)) === 1;
  return adjH || adjV;
}
function rouletteFindBetByCell(cell){
  return rouletteActiveBets.find(b => b.cellEls.includes(cell));
}
function rouletteRemoveBet(betId){
  const idx = rouletteActiveBets.findIndex(b => b.id === betId);
  if(idx === -1) return;
  const bet = rouletteActiveBets[idx];
  bet.cellEls.forEach(cell => {
    cell.classList.remove('selected');
    const badge = cell.querySelector('.rt-chip-badge');
    if(badge) badge.remove();
  });
  rouletteActiveBets.splice(idx, 1);
  rouletteRenderActiveBets();
}
function rouletteClearBuilding(){
  document.querySelectorAll('.rt-cell.building').forEach(c => c.classList.remove('building'));
  rouletteBuildingNums = [];
  const confirmBtn = document.getElementById('rouletteConfirmBetBtn');
  if(confirmBtn) confirmBtn.style.display = 'none';
}
// Updates the hint text + Confirm Bet pill to reflect the current pending
// selection. `bet` is the CURRENT selection's resolved bet type if it's
// already a complete, valid shape (Straight/Split/Street/Corner/Double
// Street/Top Line) — or null if it's a legitimate work-in-progress (e.g.
// 3 numbers on the way to a Corner) that isn't a valid bet YET on its own.
function rouletteUpdateBuildingUI(bet){
  const spotEl = document.getElementById('rouletteSelectedSpot');
  const confirmBtn = document.getElementById('rouletteConfirmBetBtn');
  if(rouletteBuildingNums.length === 0){
    spotEl.textContent = 'No bets placed yet';
    spotEl.style.color = '';
    if(confirmBtn) confirmBtn.style.display = 'none';
    return;
  }
  if(bet){
    spotEl.textContent = `${bet.label} \u2014 tap Confirm Bet, or keep tapping adjacent numbers to grow it`;
    spotEl.style.color = 'var(--brass-light)';
    if(confirmBtn){ confirmBtn.style.display = 'inline-block'; confirmBtn.disabled = false; }
  } else {
    const n = rouletteBuildingNums.length;
    spotEl.textContent = `${n} number${n === 1 ? '' : 's'} selected \u2014 tap another adjacent number to complete a bet`;
    spotEl.style.color = '';
    if(confirmBtn){ confirmBtn.style.display = 'inline-block'; confirmBtn.disabled = true; }
  }
}
// Confirms whatever's currently in rouletteBuildingNums as a placed bet —
// only ever called once we KNOW it's meant to be locked in (max shape size
// reached, the player tapped Confirm Bet, or they moved on to something
// else with a still-valid selection pending).
function rouletteConfirmBuilding(detectedBet){
  const amount = parseInt(document.getElementById('rouletteBetInput').value, 10) || 0;
  if(amount <= 0){
    const errEl = document.getElementById('rouletteBetError');
    if(errEl) errEl.textContent = 'Pick a chip amount first.';
    rouletteClearBuilding();
    return;
  }
  const cellEls = rouletteBuildingNums.map(v => rouletteCellByValue[v]).filter(Boolean);
  const bet = { id: ++rouletteBetIdCounter, ...detectedBet, amount, cellEls };
  rouletteActiveBets.push(bet);
  cellEls.forEach(c => {
    c.classList.remove('building');
    c.classList.add('selected');
    const badge = document.createElement('div');
    badge.className = 'rt-chip-badge';
    badge.textContent = amount;
    c.appendChild(badge);
  });
  rouletteBuildingNums = [];
  rouletteUpdateBuildingUI(null);
  rouletteRenderActiveBets();
  bjPlayChipSound();
}
// Confirms any still-pending selection IF it currently resolves to a valid
// bet — called right before anything that moves focus away from number-
// building (an outside tap, Same Bet, or Spin) so a pending Straight/
// Split/Street/etc never just gets silently abandoned or left ambiguous.
// If the pending selection is mid-way through building toward a Corner or
// Double Street and isn't valid on its own yet, it's simply abandoned —
// there's no sensible bet to fall back to.
function rouletteConfirmPendingSelectionIfAny(){
  if(rouletteBuildingNums.length === 0) return;
  const bet = rouletteDetectBetFromSelection(rouletteBuildingNums);
  if(bet) rouletteConfirmBuilding(bet);
  else rouletteClearBuilding();
}
document.getElementById('rouletteConfirmBetBtn').addEventListener('click', () => {
  rouletteConfirmPendingSelectionIfAny();
});
function rouletteToggleNumberCell(cell){
  // Tapping a cell that's already part of a CONFIRMED bet removes that
  // whole bet — this is the "clear selection" control the member asked
  // for, applied per-bet rather than needing a separate mode.
  const existingBet = rouletteFindBetByCell(cell);
  if(existingBet){ rouletteRemoveBet(existingBet.id); return; }

  const val = cell.dataset.betValue;
  const idx = rouletteBuildingNums.indexOf(val);
  if(idx >= 0){
    // deselecting a number that's mid-build (not yet confirmed)
    rouletteBuildingNums.splice(idx, 1);
    cell.classList.remove('building');
    rouletteUpdateBuildingUI(rouletteBuildingNums.length ? rouletteDetectBetFromSelection(rouletteBuildingNums) : null);
    return;
  }

  // Taps accumulate into the building set WITHOUT requiring every
  // intermediate size to itself be a valid bet — that requirement is what
  // made Corner and Double Street unreachable before (a Corner's 3-number
  // subset is an "L" shape, not a Street, so it could never pass through a
  // valid waypoint on the way to 4). Only the FINAL confirmed selection
  // needs to resolve to a real bet type.
  // A tap that isn't adjacent to anything already building is read as an
  // unrelated new bet: finalize whatever WAS pending (if valid) first.
  const isAdjacentToBuilding = rouletteBuildingNums.some(v => rouletteAreAdjacent(v, val));
  if(rouletteBuildingNums.length > 0 && !isAdjacentToBuilding){
    rouletteConfirmPendingSelectionIfAny();
  }

  const touchesZero = rouletteBuildingNums.includes('0') || rouletteBuildingNums.includes('00') || val === '0' || val === '00';
  const hardCap = touchesZero ? 5 : 6; // Top Line tops out at 5, Double Street at 6 — nothing bigger exists
  if(rouletteBuildingNums.length >= hardCap) return; // maxed out — tap Confirm Bet or deselect a number first

  rouletteBuildingNums.push(val);
  cell.classList.add('building');
  const bet = rouletteDetectBetFromSelection(rouletteBuildingNums);
  if(bet && rouletteBuildingNums.length >= hardCap){
    rouletteConfirmBuilding(bet);
  } else {
    rouletteUpdateBuildingUI(bet);
  }
}
function rouletteTapOutsideCell(cell){
  const existingBet = rouletteFindBetByCell(cell);
  if(existingBet){ rouletteRemoveBet(existingBet.id); return; }

  rouletteConfirmPendingSelectionIfAny();

  const betType = cell.dataset.betType;
  const amount = parseInt(document.getElementById('rouletteBetInput').value, 10) || 0;
  if(amount <= 0){
    const errEl = document.getElementById('rouletteBetError');
    if(errEl) errEl.textContent = 'Pick a chip amount first.';
    return;
  }
  const bet = { id: ++rouletteBetIdCounter, type: betType, value: null, label: ROULETTE_BET_LABELS[betType] || betType, amount, cellEls: [cell] };
  rouletteActiveBets.push(bet);
  cell.classList.add('selected');
  const badge = document.createElement('div');
  badge.className = 'rt-chip-badge';
  badge.textContent = amount;
  cell.appendChild(badge);
  rouletteRenderActiveBets();
  bjPlayChipSound();
}
function rouletteRenderActiveBets(){
  const area = document.getElementById('rouletteActiveBetsArea');
  const clearBtn = document.getElementById('rouletteClearAllBtn');
  const clearBtnTop = document.getElementById('rouletteClearAllTopBtn');
  if(rouletteActiveBets.length === 0){
    area.innerHTML = '<div class="roulette-total-staked">Total staked: 0 XP</div>';
    clearBtn.disabled = true;
    if(clearBtnTop) clearBtnTop.disabled = true;
    return;
  }
  clearBtn.disabled = false;
  if(clearBtnTop) clearBtnTop.disabled = false;
  const total = rouletteActiveBets.reduce((s, b) => s + b.amount, 0);
  area.innerHTML = rouletteActiveBets.map(b => `
    <div class="roulette-active-bet-row">
      <span class="rab-label">${escapeHtml(b.label)}</span>
      <span><span class="rab-amount">${b.amount}</span> <span class="rab-remove" data-remove-id="${b.id}">\u2715</span></span>
    </div>`).join('') + `<div class="roulette-total-staked">Total staked: ${total} XP</div>`;
  area.querySelectorAll('.rab-remove').forEach(el => {
    el.addEventListener('click', () => rouletteRemoveBet(parseInt(el.dataset.removeId, 10)));
  });
}
function rouletteClearAllBets(){
  rouletteActiveBets.slice().forEach(b => rouletteRemoveBet(b.id));
  rouletteClearBuilding();
  document.getElementById('rouletteSelectedSpot').textContent = 'No spot selected';
  document.getElementById('rouletteSelectedSpot').style.color = '';
}
document.getElementById('rouletteClearAllBtn').addEventListener('click', rouletteClearAllBets);
document.getElementById('rouletteClearAllTopBtn').addEventListener('click', rouletteClearAllBets);
// Re-places every bet from the last completed spin exactly as it was —
// replaces whatever's currently on the table rather than stacking on top,
// so tapping it twice in a row is a no-op, not a doubled bet.
function rouletteRepeatLastBet(){
  if(rouletteLastBets.length === 0) return;
  rouletteConfirmPendingSelectionIfAny();
  rouletteActiveBets.slice().forEach(b => rouletteRemoveBet(b.id));
  rouletteLastBets.forEach(lb => {
    const bet = { id: ++rouletteBetIdCounter, type: lb.type, value: lb.value, nums: lb.nums, label: lb.label, amount: lb.amount, cellEls: lb.cellEls };
    rouletteActiveBets.push(bet);
    bet.cellEls.forEach(c => {
      c.classList.add('selected');
      const badge = document.createElement('div');
      badge.className = 'rt-chip-badge';
      badge.textContent = bet.amount;
      c.appendChild(badge);
    });
  });
  rouletteRenderActiveBets();
  bjPlayChipSound();
}
document.getElementById('rouletteSameBetBtn').addEventListener('click', rouletteRepeatLastBet);
document.getElementById('rouletteSameBetTopBtn').addEventListener('click', rouletteRepeatLastBet);
document.getElementById('rouletteBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('rouletteChipDisplay');
  if(chip){
    chip.textContent = e.target.value || '0';
    chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
  }
  const errEl = document.getElementById('rouletteBetError');
  if(errEl) errEl.textContent = '';
});
// Tap the chip readout to type any amount — the 10/25/50/100/250 buttons
// are quick-pick shortcuts, not a ceiling; there's no house limit here.
document.getElementById('rouletteChipDisplay').addEventListener('click', () => {
  const input = document.getElementById('rouletteBetInput');
  const entry = prompt('Bet amount (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
  document.querySelectorAll('#rouletteBetPanel .table-chip').forEach(c => c.classList.remove('active-chip'));
});
function rouletteEvaluate(bet, pocket){
  if(bet.type === 'straight') return pocket === bet.value ? 35 : -1;
  if(bet.type === 'topline') return ['0','00','1','2','3'].includes(pocket) ? 6 : -1;
  if(bet.type === 'split') return bet.nums.includes(pocket) ? 17 : -1;
  if(bet.type === 'street') return bet.nums.includes(pocket) ? 11 : -1;
  if(bet.type === 'corner') return bet.nums.includes(pocket) ? 8 : -1;
  if(bet.type === 'sixline') return bet.nums.includes(pocket) ? 5 : -1;
  if(pocket === '0' || pocket === '00') return -1; // standard house rule: all outside/dozen/column bets lose on zero
  const num = parseInt(pocket, 10);
  const color = rouletteColorOf(pocket);
  switch(bet.type){
    case 'red': return color === 'red' ? 1 : -1;
    case 'black': return color === 'black' ? 1 : -1;
    case 'odd': return num % 2 === 1 ? 1 : -1;
    case 'even': return num % 2 === 0 ? 1 : -1;
    case 'low': return num <= 18 ? 1 : -1;
    case 'high': return num >= 19 ? 1 : -1;
    case 'dozen1': return num >= 1 && num <= 12 ? 2 : -1;
    case 'dozen2': return num >= 13 && num <= 24 ? 2 : -1;
    case 'dozen3': return num >= 25 && num <= 36 ? 2 : -1;
    case 'col1': return rouletteNumCol(num) === 0 ? 2 : -1;
    case 'col2': return rouletteNumCol(num) === 1 ? 2 : -1;
    case 'col3': return rouletteNumCol(num) === 2 ? 2 : -1;
  }
  return -1;
}
function rouletteRenderHistory(){
  const el = document.getElementById('rouletteHistory');
  el.innerHTML = rouletteHistory.slice(-10).reverse().map(pocket => {
    const color = rouletteColorOf(pocket);
    const bg = color === 'green' ? '#1f7a4a' : (color === 'red' ? '#8c2a22' : '#141414');
    return `<div class="roulette-history-chip" style="background:${bg};">${pocket}</div>`;
  }).join('');
}
// Scrolls the given element into view smoothly — used right as a Spin/Roll
// starts so the animation is actually on-screen even if the person just
// tapped a button sitting below the wheel/dice on a small phone.
function scrollIntoViewSmooth(elId){
  const el = document.getElementById(elId);
  if(el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
let rouletteSpinning = false; // guards a fast double-tap on Spin — same class fixed for Craps/Blackjack/War/Baccarat/Slots/Daily Spin
async function rouletteSpin(){
  if(rouletteSpinning) return;
  rouletteSpinning = true;
  const spinBtn = document.getElementById('rouletteSpinBtn');
  const spinBtnTop = document.getElementById('rouletteSpinTopBtn');
  if(spinBtn) spinBtn.disabled = true;
  if(spinBtnTop) spinBtnTop.disabled = true;
  try{
    await rouletteSpinInner();
  } finally {
    rouletteSpinning = false;
    if(spinBtn) spinBtn.disabled = false;
    if(spinBtnTop) spinBtnTop.disabled = false;
  }
}
async function rouletteSpinInner(){
  rouletteConfirmPendingSelectionIfAny();
  const errEl = document.getElementById('rouletteBetError');
  errEl.textContent = '';
  if(rouletteActiveBets.length === 0){ errEl.textContent = 'Place at least one bet on the table first.'; return; }
  const totalStaked = rouletteActiveBets.reduce((s, b) => s + b.amount, 0);
  if(totalStaked > CASINO_MAX_BET_PER_HAND){ errEl.textContent = `Maximum bet per spin is ${CASINO_MAX_BET_PER_HAND.toLocaleString()} XP total across all placed bets (staked: ${totalStaked.toLocaleString()}).`; return; }
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(totalStaked > balance){ errEl.textContent = `You only have ${balance} XP (staked: ${totalStaked}).`; return; }

  scrollIntoViewSmooth('rouletteWheelPanel');
  const resultEl = document.getElementById('rouletteResultMsg');
  resultEl.textContent = '';
  resultEl.classList.remove('bj-outcome-pop', 'bj-outcome-jackpot');
  bjPlayChipSound();
  croupierSay('rouletteCroupierMsg', CROUPIER_LINES.rouletteNoMoreBets);

  const winningIndex = Math.floor(Math.random() * ROULETTE_WHEEL_ORDER.length);
  const winningPocket = ROULETTE_WHEEL_ORDER[winningIndex];
  const anglePer = 360 / ROULETTE_WHEEL_ORDER.length;
  const targetAngle = winningIndex * anglePer + anglePer / 2;
  const spins = 6 + Math.floor(Math.random() * 3);
  rouletteBallRotation = rouletteBallRotation - (rouletteBallRotation % 360) + spins * 360 + targetAngle;
  const track = document.getElementById('rouletteBallTrack');
  track.style.transition = 'transform 4.2s cubic-bezier(.12,.67,.18,1)';
  track.style.transform = `rotate(${rouletteBallRotation}deg)`;
  bjPlaySpinSound();

  await bjWait(4300);
  document.getElementById('rouletteSpinBtn').disabled = false;
  const spinBtnTopMidFlow = document.getElementById('rouletteSpinTopBtn');
  if(spinBtnTopMidFlow) spinBtnTopMidFlow.disabled = false;

  const color = rouletteColorOf(winningPocket);
  let totalDelta = 0;
  let isJackpot = false;
  const parts = rouletteActiveBets.map(bet => {
    const multiplier = rouletteEvaluate(bet, winningPocket);
    const delta = multiplier > 0 ? bet.amount * multiplier : -bet.amount;
    totalDelta += delta;
    if(bet.type === 'straight' && multiplier > 0) isJackpot = true;
    return `${bet.label}: ${delta >= 0 ? '+' : ''}${delta}`;
  });

  rouletteHistory.push(winningPocket);
  rouletteRenderHistory();

  const wheel = document.getElementById('rouletteWheel');
  wheel.classList.remove('pc-winner-flash'); void wheel.offsetWidth; wheel.classList.add('pc-winner-flash');

  const colorLabel = color === 'green' ? '\ud83d\udfe2 Green' : (color === 'red' ? '\ud83d\udd34 Red' : '\u26ab Black');
  resultEl.textContent = `${winningPocket} \u2014 ${colorLabel}  |  ${parts.join('  \u00b7  ')}  \u2014  Total: ${totalDelta >= 0 ? '+' : ''}${totalDelta} XP`;
  resultEl.style.color = isJackpot ? '' : (totalDelta > 0 ? 'var(--win)' : (totalDelta < 0 ? 'var(--loss)' : 'var(--muted)'));
  resultEl.classList.add(isJackpot ? 'bj-outcome-jackpot' : 'bj-outcome-pop');
  croupierSay('rouletteCroupierMsg', isJackpot ? CROUPIER_LINES.rouletteBigWin : (totalDelta > 0 ? CROUPIER_LINES.rouletteWin : (totalDelta < 0 ? CROUPIER_LINES.rouletteLoss : CROUPIER_LINES.rouletteNoBet)));

  const panelEl = document.getElementById('casinoGameRoulette');
  const wheelPanelEl = document.getElementById('rouletteWheelPanel');
  if(totalDelta > 0){
    bjPlayChime(true);
    wheelPanelEl.classList.remove('pc-flash-gold'); void wheelPanelEl.offsetWidth; wheelPanelEl.classList.add('pc-flash-gold');
    bjLaunchConfetti(resultEl, isJackpot ? 42 : 22);
    setTimeout(() => wheelPanelEl.classList.remove('pc-flash-gold'), 700);
  } else if(totalDelta < 0){
    bjPlayChime(false);
    panelEl.classList.add('pc-shake');
    setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
  }

  if(totalDelta !== 0) await awardXP(totalDelta, totalDelta > 0 ? 'Roulette win' : 'Roulette loss', { silent: true, detail: { type: 'roulette', number: winningPocket, color } });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();

  // Bets are consumed by the spin, same as chips being swept off a real
  // table — clear everything ready for the next round. Snapshot them first
  // so the Same Bet pill can re-place this exact spread next round.
  rouletteLastBets = rouletteActiveBets.map(b => ({ ...b, cellEls: b.cellEls.slice() }));
  document.getElementById('rouletteSameBetBtn').disabled = rouletteLastBets.length === 0;
  const sameBetTopBtn = document.getElementById('rouletteSameBetTopBtn');
  if(sameBetTopBtn) sameBetTopBtn.disabled = rouletteLastBets.length === 0;
  rouletteActiveBets.forEach(b => b.cellEls.forEach(c => { c.classList.remove('selected'); const bd = c.querySelector('.rt-chip-badge'); if(bd) bd.remove(); }));
  rouletteActiveBets = [];
  rouletteRenderActiveBets();
}
document.getElementById('rouletteSpinBtn').addEventListener('click', rouletteSpin);
document.getElementById('rouletteSpinTopBtn').addEventListener('click', rouletteSpin);
