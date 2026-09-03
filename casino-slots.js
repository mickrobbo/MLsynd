// ---- Slots (5 reels × 3 rows, multi-payline) ----
// Upgraded from the original single-row/single-payline machine to a real
// pokie-style grid: 3 symbols visible per reel, up to 5 fixed paylines
// (activated in order — 1/3/5, matching how real machines let you choose
// how many of the available lines to bet on), each evaluated with the
// same left-to-right "matching run" rule the single payline always used.
// Winning lines are traced with an actual line drawn across the grid
// (SVG, real DOM-measured coordinates — not guessed percentages, so it
// stays aligned if the reel spacing/padding ever changes) plus a glow on
// the specific winning cells, same gold flash language as every other
// win moment in the casino.
const SLOTS_REEL_COUNT = 5;
const SLOTS_ROW_COUNT = 3;
const SLOTS_SYMBOLS = [
  { sym: '🍒', weight: 8, mult3: 3, mult4: 8, mult5: 20 },
  { sym: '🍋', weight: 7, mult3: 5, mult4: 12, mult5: 30 },
  { sym: '🔔', weight: 5, mult3: 10, mult4: 25, mult5: 75 },
  { sym: '⭐', weight: 4, mult3: 20, mult4: 50, mult5: 150 },
  { sym: '💎', weight: 2, mult3: 50, mult4: 150, mult5: 400 },
  { sym: '👑', weight: 1, mult3: 100, mult4: 300, mult5: 1000 }
];
const SLOTS_WEIGHTED_POOL = [];
SLOTS_SYMBOLS.forEach(s => { for(let i = 0; i < s.weight; i++) SLOTS_WEIGHTED_POOL.push(s.sym); });
function slotsPickSymbol(){ return SLOTS_WEIGHTED_POOL[Math.floor(Math.random() * SLOTS_WEIGHTED_POOL.length)]; }
const SLOTS_SYMBOL_HEIGHT = 66; // matches .slots-symbol height in CSS

// Free Spins bonus — 👑 doubles as the scatter symbol (same top-tier
// symbol that already pays the best on a line, real pokies often reuse
// their premium symbol as the trigger too). 3+ crowns ANYWHERE on the
// 5×3 board, regardless of payline, awards free spins at a flat 6x
// multiplier on every win. The bet is locked to whatever was active on
// the triggering spin for the whole bonus (real-pokie convention — can't
// crank your stake mid-bonus to game the payout), and can retrigger for
// more free spins on top of whatever's left.
const SLOTS_SCATTER_SYMBOL = '👑';
const SLOTS_FREE_SPINS_TRIGGER_COUNT = 3;
const SLOTS_FREE_SPINS_AWARD = 8; // spins granted per trigger — a judgment call, not specified; easy to retune
const SLOTS_FREE_SPINS_MULTIPLIER = 3;
let slotsFreeSpinsRemaining = 0;
let slotsFreeSpinsBet = null; // { amountPerLine, lines } — locked in for the whole bonus

// Five classic pokie paylines — row index (0=top,1=middle,2=bottom) per
// reel, left to right. Activated in this exact order: betting "1 Line"
// only lights up Middle, "3 Lines" adds Top+Bottom, "5 Lines" adds both
// diagonals — same convention real machines use so the paytable/line
// list stays predictable as you raise how many lines you're covering.
const SLOTS_PAYLINES = [
  { name: 'Middle', rows: [1,1,1,1,1] },
  { name: 'Top', rows: [0,0,0,0,0] },
  { name: 'Bottom', rows: [2,2,2,2,2] },
  { name: 'V', rows: [0,1,2,1,0] },
  { name: 'Inverted V', rows: [2,1,0,1,2] },
];

let slotsBuilt = false;
let slotsLastBet = null; // { amountPerLine, lines }
let slotsActiveLineCount = 3;

// ---- Gamble feature — offered after any real (non-free-spin) win.
// Two fair sub-games (no house edge added on top of the win itself,
// same as how this feature commonly works in the real thing — the base
// game already carries the house's edge): Red/Black at exactly 1/2 odds
// for 2x, or a suit pick at exactly 1/4 odds for 4x. Capped at 5 rounds
// so a hot streak can't run forever — real pokie gamble features
// typically cap it too, and it keeps the state genuinely simple.
const SLOTS_GAMBLE_MAX_ROUNDS = 5;
const SLOTS_SUITS = ['♠', '♥', '♦', '♣'];
let slotsGamblePot = 0;
let slotsGambleRound = 0;
let slotsGambleBusy = false;

function slotsBuildReelStrip(reelEl, finalSymbols, stripLength){
  // finalSymbols: array of SLOTS_ROW_COUNT symbols, top to bottom — the
  // last `SLOTS_ROW_COUNT` entries of the strip, so they land as the
  // visible window once the strip's translated up out of view.
  const symbols = [];
  for(let i = 0; i < stripLength - SLOTS_ROW_COUNT; i++) symbols.push(slotsPickSymbol());
  finalSymbols.forEach(s => symbols.push(s));
  const strip = document.createElement('div');
  strip.className = 'slots-symbol-strip';
  strip.innerHTML = symbols.map(s => `<div class="slots-symbol">${s}</div>`).join('');
  reelEl.innerHTML = '';
  reelEl.appendChild(strip);
  return strip;
}
function slotsBuildInitial(){
  for(let i = 0; i < SLOTS_REEL_COUNT; i++){
    const finals = Array.from({ length: SLOTS_ROW_COUNT }, () => slotsPickSymbol());
    slotsBuildReelStrip(document.getElementById('slotsReel' + i), finals, SLOTS_ROW_COUNT);
  }
  slotsBuilt = true;
  slotsUpdateTotalBetHint();
  slotsRenderPaylinesKey();
}
async function slotsSpinReel(reelId, finalSymbols, duration){
  const reelEl = document.getElementById(reelId);
  const stripLength = 24;
  const strip = slotsBuildReelStrip(reelEl, finalSymbols, stripLength);
  strip.style.transition = 'none';
  strip.style.transform = 'translateY(0)';
  void strip.offsetWidth;
  const targetY = -(stripLength - SLOTS_ROW_COUNT) * SLOTS_SYMBOL_HEIGHT;
  strip.style.transition = `transform ${duration}ms cubic-bezier(.17,.67,.24,1)`;
  strip.style.transform = `translateY(${targetY}px)`;
  await bjWait(duration);
}
function slotsBuildPaytable(){
  const header = `<div class="slots-pt-header"><div></div><div>&times;3</div><div>&times;4</div><div>&times;5</div></div>`;
  const rows = SLOTS_SYMBOLS.map(s =>
    `<div class="slots-pt-row"><div class="slots-pt-sym">${s.sym}</div><div class="vp-pt-mult">${s.mult3}:1</div><div class="vp-pt-mult">${s.mult4}:1</div><div class="vp-pt-mult">${s.mult5}:1</div></div>`
  ).join('');
  const consolation = `<div class="slots-pt-consolation"><span class="vp-pt-name">Any 2 matching (left to right, per line)</span><span class="vp-pt-mult">1:1</span></div>`;
  document.getElementById('slotsPaytable').innerHTML = header + rows + consolation;
}
// Standard "left to right" payline rule, unchanged from the original
// single-line machine — count how many reels, starting from reel 1,
// match in an unbroken run along whichever row the line follows. Now
// called once per active payline instead of just once per spin.
function slotsEvaluateRun(lineSymbols){
  let run = 1;
  for(let i = 1; i < lineSymbols.length; i++){
    if(lineSymbols[i] === lineSymbols[0]) run++;
    else break;
  }
  return run;
}
function slotsUpdateTotalBetHint(){
  const hintEl = document.getElementById('slotsTotalBetHint');
  if(!hintEl) return;
  if(slotsFreeSpinsRemaining > 0){
    hintEl.textContent = `🎉 FREE SPIN — ${slotsFreeSpinsRemaining} left, ${SLOTS_FREE_SPINS_MULTIPLIER}x wins, bet locked at ${slotsFreeSpinsBet.amountPerLine} XP/line × ${slotsFreeSpinsBet.lines}`;
    return;
  }
  const perLine = parseInt(document.getElementById('slotsBetInput').value, 10) || 0;
  const total = perLine * slotsActiveLineCount;
  hintEl.textContent = `${perLine} XP/line × ${slotsActiveLineCount} line${slotsActiveLineCount === 1 ? '' : 's'} — total bet ${total} XP`;
}
// Betting controls are locked for the whole bonus — same reason the bet
// itself is locked in the payout math (see the top-of-file note): letting
// someone change stake or line count mid-bonus would let them game a
// multiplier that's meant to apply to whatever they'd already committed to.
function slotsSetControlsLockedForFreeSpins(locked){
  document.querySelectorAll('#slotsLinesRow .craps-winmode-btn').forEach(b => { b.disabled = locked; });
  document.querySelectorAll('#slotsBetPanel .table-chip, #slotsBetPanel .chip-clear-btn').forEach(b => { b.disabled = locked; });
  const chip = document.getElementById('slotsChipDisplay');
  if(chip) chip.style.pointerEvents = locked ? 'none' : '';
  const panel = document.getElementById('casinoGameSlots');
  if(panel) panel.classList.toggle('slots-free-spins-active', locked);
}
function slotsRenderPaylinesKey(winningLineIndexes){
  const el = document.getElementById('slotsPaylinesKey');
  if(!el) return;
  const won = new Set(winningLineIndexes || []);
  el.innerHTML = SLOTS_PAYLINES.slice(0, slotsActiveLineCount).map((line, i) =>
    `<span class="slots-payline-chip${won.has(i) ? ' won' : ''}">${line.name}</span>`
  ).join('');
}
document.querySelectorAll('#slotsLinesRow .craps-winmode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    slotsActiveLineCount = parseInt(btn.dataset.lines, 10);
    document.querySelectorAll('#slotsLinesRow .craps-winmode-btn').forEach(b => b.classList.toggle('active', b === btn));
    slotsUpdateTotalBetHint();
    slotsRenderPaylinesKey();
  });
});
// Draws the actual winning payline(s) across the grid using real
// measured positions — reads each reel's on-screen box and each row's
// vertical center within it, rather than guessing at pixel offsets from
// the CSS. Stays correct even if the reel gap/padding changes later.
function slotsDrawWinLines(winningLineIndexes){
  const svg = document.getElementById('slotsLinesOverlay');
  if(!svg) return;
  svg.innerHTML = '';
  if(winningLineIndexes.length === 0) return;
  const svgRect = svg.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${svgRect.width} ${svgRect.height}`);
  const reelRects = [];
  for(let i = 0; i < SLOTS_REEL_COUNT; i++){
    reelRects.push(document.getElementById('slotsReel' + i).getBoundingClientRect());
  }
  winningLineIndexes.forEach(lineIdx => {
    const line = SLOTS_PAYLINES[lineIdx];
    const points = line.rows.map((row, reelI) => {
      const r = reelRects[reelI];
      const x = (r.left + r.width / 2) - svgRect.left;
      const y = (r.top + (row + 0.5) * SLOTS_SYMBOL_HEIGHT) - svgRect.top;
      return `${x},${y}`;
    }).join(' ');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', points);
    svg.appendChild(poly);
  });
}
async function slotsSpin(){
  const spinBtn = document.getElementById('slotsSpinBtn');
  const sameBtn = document.getElementById('slotsSameBetBtn');
  // Disabling synchronously as the very first thing (before any await)
  // closes the double-tap race where a fast second click could fire a
  // second concurrent spin before the button visually locks.
  if(spinBtn.disabled) return;
  spinBtn.disabled = true;
  const errEl = document.getElementById('slotsBetError');
  errEl.textContent = '';

  const isFreeSpin = slotsFreeSpinsRemaining > 0;
  let perLine, lineCount;
  if(isFreeSpin){
    // Bet is whatever triggered the bonus, not whatever the (disabled)
    // controls currently show — see slotsSetControlsLockedForFreeSpins.
    perLine = slotsFreeSpinsBet.amountPerLine;
    lineCount = slotsFreeSpinsBet.lines;
  } else {
    perLine = parseInt(document.getElementById('slotsBetInput').value, 10) || 0;
    lineCount = slotsActiveLineCount;
    if(perLine <= 0){ errEl.textContent = 'Add some chips first.'; spinBtn.disabled = false; return; }
    const totalBet = perLine * lineCount;
    if(totalBet > CASINO_MAX_BET_PER_HAND){ errEl.textContent = `Maximum bet per spin is ${CASINO_MAX_BET_PER_HAND.toLocaleString()} XP total across all lines (${perLine.toLocaleString()} × ${lineCount} lines = ${totalBet.toLocaleString()}).`; spinBtn.disabled = false; return; }
    const balance = await getXPBalance();
    if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; spinBtn.disabled = false; return; }
    if(totalBet > balance){ errEl.textContent = `You only have ${balance} XP (total bet: ${totalBet}).`; spinBtn.disabled = false; return; }
  }

  if(sameBtn) sameBtn.disabled = true;
  const resultEl = document.getElementById('slotsResultMsg');
  resultEl.textContent = '';
  resultEl.classList.remove('bj-outcome-pop', 'bj-outcome-jackpot');
  document.getElementById('slotsLinesOverlay').innerHTML = '';
  document.querySelectorAll('.slots-symbol.slots-win-cell').forEach(el => el.classList.remove('slots-win-cell'));

  // Everything from here on is wrapped so spinBtn/sameBtn ALWAYS get
  // re-enabled even if something throws mid-spin (a sound call, a DOM
  // lookup, anything) — same reasoning and same bug class as the gamble
  // functions above: without this, an exception here would leave the
  // Spin button permanently disabled, indistinguishable from the reels
  // just being stuck forever.
  try{
  bjPlayChipSound();

  // grid[reel][row] — full 5×3 board, independent of which lines are
  // actually active (a line you didn't bet on still lands normally, it
  // just can't win anything, exactly like a real machine's unlit lines).
  const grid = [];
  for(let r = 0; r < SLOTS_REEL_COUNT; r++){
    grid.push(Array.from({ length: SLOTS_ROW_COUNT }, () => slotsPickSymbol()));
  }
  // Reels stop in sequence left to right (classic slot suspense) rather
  // than all at once — each one's own peg-tick-style sound reused from
  // Spin the Wheel's synth marks the moment it lands.
  await Promise.all(grid.map((finals, i) => (async () => {
    await bjWait(i * 300);
    await slotsSpinReel('slotsReel' + i, finals, 1400 + i * 300);
    dailySpinPlayPegTick();
  })()));

  spinBtn.disabled = false;
  if(!isFreeSpin){
    slotsLastBet = { amountPerLine: perLine, lines: lineCount };
    if(sameBtn) sameBtn.disabled = false;
  } else if(sameBtn){
    sameBtn.disabled = !slotsLastBet;
  }

  const activeLines = SLOTS_PAYLINES.slice(0, lineCount);
  let totalDelta = 0;
  let isJackpot = false;
  const winningLineIndexes = [];
  const winParts = [];
  const winningCellKeys = new Set();

  activeLines.forEach((line, lineIdx) => {
    const lineSymbols = line.rows.map((row, reelI) => grid[reelI][row]);
    const run = slotsEvaluateRun(lineSymbols);
    if(run < 2) return; // this line didn't hit — no different from a real machine's dark line
    const symData = SLOTS_SYMBOLS.find(s => s.sym === lineSymbols[0]);
    let delta;
    if(run >= 3){
      const mult = run === 3 ? symData.mult3 : (run === 4 ? symData.mult4 : symData.mult5);
      delta = perLine * mult;
      if(mult >= 50) isJackpot = true;
    } else {
      delta = perLine; // 2 matching — 1:1 consolation, same as the original single-line machine
    }
    if(isFreeSpin) delta *= SLOTS_FREE_SPINS_MULTIPLIER;
    totalDelta += delta;
    winningLineIndexes.push(lineIdx);
    winParts.push(`${line.name} ${run}×${lineSymbols[0]} (+${delta})`);
    for(let reelI = 0; reelI < run; reelI++){
      winningCellKeys.add(`${reelI}-${line.rows[reelI]}`);
    }
  });
  if(isFreeSpin){
    // Nothing was staked this spin — a dark line costs nothing, unlike a
    // real paid spin where every active line you didn't hit on still
    // takes its per-line stake.
  } else {
    const losingLineCount = activeLines.length - winningLineIndexes.length;
    totalDelta -= losingLineCount * perLine;
  }

  // Scatter check — anywhere on the board, independent of paylines or
  // whether this spin even won anything on a line. Can retrigger during
  // an existing bonus (adds more spins on top of whatever's left).
  const scatterCount = grid.reduce((n, reelSymbols) => n + reelSymbols.filter(s => s === SLOTS_SCATTER_SYMBOL).length, 0);
  const triggeredFreeSpins = scatterCount >= SLOTS_FREE_SPINS_TRIGGER_COUNT;
  if(triggeredFreeSpins){
    const wasAlreadyInBonus = slotsFreeSpinsRemaining > 0;
    if(!wasAlreadyInBonus){
      slotsFreeSpinsBet = { amountPerLine: perLine, lines: lineCount };
      slotsSetControlsLockedForFreeSpins(true);
    }
    slotsFreeSpinsRemaining += SLOTS_FREE_SPINS_AWARD;
  }
  if(isFreeSpin) slotsFreeSpinsRemaining--;
  const bonusJustEnded = isFreeSpin && slotsFreeSpinsRemaining <= 0;
  if(bonusJustEnded){
    slotsFreeSpinsRemaining = 0;
    slotsFreeSpinsBet = null;
    slotsSetControlsLockedForFreeSpins(false);
  }

  const resultPrefix = triggeredFreeSpins
    ? `🎉 ${scatterCount}×${SLOTS_SCATTER_SYMBOL} — +${SLOTS_FREE_SPINS_AWARD} FREE SPINS at ${SLOTS_FREE_SPINS_MULTIPLIER}x!  `
    : '';
  resultEl.textContent = resultPrefix + (winParts.length > 0
    ? `${winParts.join(' · ')} — Total: ${totalDelta >= 0 ? '+' : ''}${totalDelta} XP`
    : (isFreeSpin ? `No line hit (0 XP — free spin, nothing lost)` : `No line hit (${totalDelta} XP)`));
  resultEl.style.color = isJackpot ? '' : (totalDelta > 0 ? 'var(--win)' : (totalDelta < 0 ? 'var(--loss)' : 'var(--muted)'));
  resultEl.classList.add(isJackpot ? 'bj-outcome-jackpot' : 'bj-outcome-pop');

  slotsDrawWinLines(winningLineIndexes);
  slotsRenderPaylinesKey(winningLineIndexes);
  winningCellKeys.forEach(key => {
    const [reelI, row] = key.split('-').map(Number);
    const reelEl = document.getElementById('slotsReel' + reelI);
    const cell = reelEl && reelEl.querySelectorAll('.slots-symbol')[row];
    if(cell) cell.classList.add('slots-win-cell');
  });

  const panelEl = document.getElementById('casinoGameSlots');
  if(triggeredFreeSpins){
    // Triggering the bonus is always a celebration moment, even if this
    // particular spin's own lines net-lost — same reasoning a real
    // machine uses (the scatter hit overrides the line outcome's mood).
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, 50);
  } else if(totalDelta > 0){
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, isJackpot ? 42 : 20);
  } else if(totalDelta < 0){
    bjPlayChime(false);
    panelEl.classList.remove('pc-shake'); void panelEl.offsetWidth; panelEl.classList.add('pc-shake');
    setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
  }
  // A real (non-free-spin) win gets offered the Gamble feature instead of
  // being credited immediately — collecting there is what actually
  // awards the XP, so it's the one case that skips the immediate award
  // below. Losses always award immediately (the deduction), and a
  // free-spin win always awards immediately too (no gamble on those).
  const goesToGamble = totalDelta > 0 && !isFreeSpin;
  if(totalDelta !== 0 && !goesToGamble) await awardXP(totalDelta, totalDelta > 0 ? 'Slots free spin win' : 'Slots loss', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
  slotsUpdateTotalBetHint();
  if(goesToGamble) slotsOfferGamble(totalDelta);
  }catch(e){
    console.error('Slots spin failed partway through:', e);
    const errEl2 = document.getElementById('slotsBetError');
    if(errEl2) errEl2.textContent = 'Something went wrong mid-spin — your bet was not lost twice; refresh if the reels look stuck.';
  }finally{
    // Guaranteed regardless of where in the try block anything failed —
    // the early re-enable a few lines up (right after the reels finish
    // spinning) already covers the normal path; this is the safety net
    // for the reel-spinning phase itself, before that point.
    spinBtn.disabled = false;
    if(sameBtn) sameBtn.disabled = !slotsLastBet;
  }
}
document.getElementById('slotsSpinBtn').addEventListener('click', slotsSpin);
document.getElementById('slotsSameBetBtn').addEventListener('click', () => {
  if(!slotsLastBet) return;
  const input = document.getElementById('slotsBetInput');
  input.value = slotsLastBet.amountPerLine;
  input.dispatchEvent(new Event('input'));
  const targetBtn = document.querySelector(`#slotsLinesRow .craps-winmode-btn[data-lines="${slotsLastBet.lines}"]`);
  if(targetBtn) targetBtn.click();
});
document.getElementById('slotsBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('slotsChipDisplay');
  if(chip){
    chip.textContent = e.target.value || '0';
    chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
  }
  slotsUpdateTotalBetHint();
});
// Click the chip to type any custom amount — same pattern every other
// game's main bet chip already uses. No extra lock-checking needed here:
// slotsSetControlsLockedForFreeSpins already sets pointer-events:none on
// this exact element during a bonus round, so a click simply can't reach
// this handler at all while free spins are active.
document.getElementById('slotsChipDisplay').addEventListener('click', () => {
  const input = document.getElementById('slotsBetInput');
  const entry = prompt('Bet amount per line (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
});

function slotsOfferGamble(winAmount){
  slotsGamblePot = winAmount;
  slotsGambleRound = 0;
  slotsGambleBusy = false;
  const betPanel = document.getElementById('slotsBetPanel');
  const gambleArea = document.getElementById('slotsGambleArea');
  if(betPanel) betPanel.style.display = 'none';
  if(gambleArea) gambleArea.style.display = 'block';
  document.getElementById('slotsGambleCardFace').textContent = '';
  slotsGambleUpdateDisplay();
  slotsGambleSetSuitButtonsVisible(true);
}
function slotsGambleUpdateDisplay(){
  document.getElementById('slotsGamblePotVal').textContent = slotsGamblePot.toLocaleString();
  const hintEl = document.getElementById('slotsGambleRoundHint');
  if(hintEl){
    hintEl.textContent = slotsGambleRound >= SLOTS_GAMBLE_MAX_ROUNDS
      ? 'Max streak reached — collect to bank it'
      : `Round ${slotsGambleRound + 1} of ${SLOTS_GAMBLE_MAX_ROUNDS}`;
  }
}
// At the cap, only Collect stays usable — the guess buttons hide rather
// than sit there disabled, so it reads as "done", not "broken".
function slotsGambleSetSuitButtonsVisible(visible){
  const atCap = slotsGambleRound >= SLOTS_GAMBLE_MAX_ROUNDS;
  const show = visible && !atCap;
  document.getElementById('slotsGambleRedBtn').style.display = show ? 'inline-block' : 'none';
  document.getElementById('slotsGambleBlackBtn').style.display = show ? 'inline-block' : 'none';
  document.querySelectorAll('#slotsGambleArea [data-suit]').forEach(b => { b.style.display = show ? 'inline-block' : 'none'; });
}
function slotsGambleSetButtonsDisabled(disabled){
  document.getElementById('slotsGambleRedBtn').disabled = disabled;
  document.getElementById('slotsGambleBlackBtn').disabled = disabled;
  document.querySelectorAll('#slotsGambleArea [data-suit]').forEach(b => { b.disabled = disabled; });
  document.getElementById('slotsGambleCollectBtn').disabled = disabled;
}
// Both functions below are wrapped in try/catch/finally so the busy flag
// and button-disabled state ALWAYS get reset no matter what happens
// inside — a sound call throwing, a network hiccup on awardXP, anything.
// Before this fix, neither had any error handling at all: an exception
// partway through left slotsGambleBusy stuck true forever, and since both
// functions start with "if(slotsGambleBusy) return", every future click
// — including Collect — silently did nothing from then on. Real bug,
// reported live, matching exactly this symptom ("won't let me click
// anything including collect"). Same bug CLASS already documented and
// fixed once in this file already (see slotsPlayCoinCascade's comment,
// further down) — an uncaught exception skipping past reset code that
// sits after it.
async function slotsGambleGuess(type, value){
  if(slotsGambleBusy) return;
  slotsGambleBusy = true;
  slotsGambleSetButtonsDisabled(true);
  const statusEl = document.getElementById('slotsGambleStatus');
  if(statusEl) statusEl.textContent = '';

  try{
    const suit = SLOTS_SUITS[Math.floor(Math.random() * SLOTS_SUITS.length)];
    const isRed = suit === '♥' || suit === '♦';
    const actualColor = isRed ? 'red' : 'black';
    const won = type === 'color' ? value === actualColor : value === suit;
    const mult = type === 'color' ? 2 : 4;

    const cardEl = document.getElementById('slotsGambleCard');
    const faceEl = document.getElementById('slotsGambleCardFace');
    cardEl.classList.remove('slots-gamble-flip'); void cardEl.offsetWidth; cardEl.classList.add('slots-gamble-flip');
    bjPlayChipSound();
    await bjWait(600);
    faceEl.textContent = suit;
    faceEl.style.color = isRed ? '#e05a4e' : 'var(--chalk)';

    if(won){
      slotsGamblePot *= mult;
      slotsGambleRound++;
      slotsGambleUpdateDisplay();
      slotsGambleSetSuitButtonsVisible(true);
      bjPlayChime(true);
      const panelEl = document.getElementById('casinoGameSlots');
      panelEl.classList.remove('pc-flash-gold'); void panelEl.offsetWidth; panelEl.classList.add('pc-flash-gold');
      setTimeout(() => panelEl.classList.remove('pc-flash-gold'), 700);
    } else {
      bjPlayChime(false);
      const panelEl = document.getElementById('casinoGameSlots');
      panelEl.classList.add('pc-shake');
      setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
      // Busted — the gambled winnings are gone, but this never reaches
      // below zero: the worst case is exactly "as if this spin had been a
      // push", never touching XP the spin itself didn't win.
      slotsGamblePot = 0;
      await slotsGambleClose(); // this also clears slotsGambleBusy and re-shows the bet panel
      return;
    }
  }catch(e){
    console.error('Slots gamble guess failed:', e);
    if(statusEl) statusEl.textContent = 'Something went wrong — try again.';
  }finally{
    // Runs even after the early return above (that's how finally works) —
    // harmless there since the gamble area's already hidden by that point.
    // On the win path or on a genuine failure, this is what actually
    // un-sticks the buttons.
    slotsGambleBusy = false;
    slotsGambleSetButtonsDisabled(false);
  }
}
async function slotsGambleCollect(){
  if(slotsGambleBusy) return;
  slotsGambleBusy = true;
  slotsGambleSetButtonsDisabled(true);
  const statusEl = document.getElementById('slotsGambleStatus');
  if(statusEl) statusEl.textContent = '';
  try{
    if(slotsGamblePot > 0){
      await awardXP(slotsGamblePot, 'Slots gamble collect', { silent: true });
    }
    await slotsGambleClose(); // clears slotsGambleBusy on success
  }catch(e){
    console.error('Slots gamble collect failed:', e);
    if(statusEl) statusEl.textContent = 'Could not collect — check your connection and try again.';
    slotsGambleBusy = false;
    slotsGambleSetButtonsDisabled(false);
  }
}
async function slotsGambleClose(){
  const gambleArea = document.getElementById('slotsGambleArea');
  const betPanel = document.getElementById('slotsBetPanel');
  if(gambleArea) gambleArea.style.display = 'none';
  if(betPanel) betPanel.style.display = 'block';
  slotsGambleBusy = false;
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
}
document.getElementById('slotsGambleRedBtn').addEventListener('click', () => slotsGambleGuess('color', 'red'));
document.getElementById('slotsGambleBlackBtn').addEventListener('click', () => slotsGambleGuess('color', 'black'));
document.querySelectorAll('#slotsGambleArea [data-suit]').forEach(btn => {
  btn.addEventListener('click', () => slotsGambleGuess('suit', btn.dataset.suit));
});
document.getElementById('slotsGambleCollectBtn').addEventListener('click', slotsGambleCollect);

// A bright ascending coin-cascade sound for a casino win — originally part
// of the Slots sound set, but Video Poker's win celebration (below) also
// calls this on every winning hand. The Slots restoration earlier swapped
// in a recovered implementation that reuses Spin the Wheel's peg-tick
// sound instead and never redefined this function — leaving Video Poker
// calling a function that no longer existed. That's a real crash (an
// uncaught ReferenceError), not a cosmetic gap: it fired on every single
// Video Poker win and halted vpDraw() mid-execution, which is exactly why
// the hand could never reset back to a fresh Deal afterward — the reset
// code sits after this call and never got to run. Restoring the function
// fixes both the crash and, as a direct consequence, the stuck-hand bug.
function slotsPlayCoinCascade(big){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const now = ctx.currentTime;
  const count = big ? 16 : 7;
  for(let i = 0; i < count; i++){
    const t = now + i * 0.045 + Math.random() * 0.012;
    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 1500 + Math.random() * 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.13, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.16);
  }
}
