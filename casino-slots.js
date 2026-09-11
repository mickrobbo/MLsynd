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
  // Wild — substitutes for any regular symbol to help complete a line
  // (see slotsEvaluateRun), classic slot convention for this exact
  // emoji. Doesn't substitute for 👑's SCATTER role (that's checked
  // globally across the board, not per-line, so substitution doesn't
  // apply there anyway) — but it IS itself a normal payline symbol too,
  // with its own strong native payout when it lands as a natural run,
  // sitting between 💎 and 👑 in both rarity and payout.
  { sym: '7️⃣', weight: 2, mult3: 60, mult4: 180, mult5: 500 },
  { sym: '👑', weight: 1, mult3: 100, mult4: 300, mult5: 1000 }
];
const SLOTS_WILD_SYMBOL = '7️⃣';
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
// MEGA tier — all 5 reels landing a crown at once (5-of-a-kind scatter,
// the rarest possible board: weight 1 of 27 per reel, so roughly a
// 1-in-14-million shot) awards a bigger bonus on top of the standard
// 3-4 crown trigger, with its own richer celebration. The tier is
// decided once, at the moment the bonus STARTS, and locked in for that
// whole bonus (slotsFreeSpinsMultiplier) — a retrigger mid-bonus adds
// more spins at whatever tier the retrigger itself qualifies for, but
// doesn't change the multiplier already locked in, same "no gaming the
// payout mid-bonus" convention as the bet-lock above.
const SLOTS_MEGA_TRIGGER_COUNT = 5;
const SLOTS_MEGA_FREE_SPINS_AWARD = 20;
const SLOTS_MEGA_FREE_SPINS_MULTIPLIER = 6;
let slotsFreeSpinsRemaining = 0;
let slotsFreeSpinsBet = null; // { amountPerLine, lines } — locked in for the whole bonus
let slotsFreeSpinsMultiplier = SLOTS_FREE_SPINS_MULTIPLIER; // set when a bonus starts, from whichever tier triggered it
let slotsFreeSpinsIsMega = false; // for the celebration/banner styling on this bonus's own spins

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

// ---- Machine Balance — a visible credit meter, same idea as a real
// slot machine's coin tray. Every win (free-spin or gambled-and-
// collected) banks straight in here instead of hitting real XP
// directly; every bet draws from here first, and only reaches into
// real XP once this is empty. Nothing is auto-cashed — the player has
// to tap Cash Out deliberately to move it into real XP, same as they'd
// have to physically collect coins from a tray. In-memory only (resets
// on reload), same as every other piece of this game's session state
// (slotsGamblePot, slotsFreeSpinsRemaining, etc.) — that's exactly why
// Cash Out exists rather than forcing it to sit there indefinitely.
let slotsMachineBalance = 0;
function slotsUpdateMachineBalanceDisplay(){
  const el = document.getElementById('slotsMachineBalanceVal');
  if(el) el.textContent = slotsMachineBalance.toLocaleString();
  const btn = document.getElementById('slotsCashOutBtn');
  if(btn) btn.disabled = slotsMachineBalance <= 0;
}

// ---- Progressive Jackpot — a shared pool across the whole syndicate,
// separate from the existing Casino Pot system on purpose (that one
// already has its own distribution schedule, fines, and history —
// mixing this into it would just be confusing). 2% of every real
// (non-free-spin) bet feeds it; landing 5 wilds on an active payline
// pays out the whole thing and resets it to a floor, not zero, so it
// never looks "broken/empty" right after a win. Uses a read-then-write
// pattern rather than a true atomic increment (the REST API doesn't
// expose Firebase's transaction primitive the way the SDK does) — a
// real tradeoff if two people spin in the exact same instant, but
// low-risk for an ~11-person friendly group, same reasoning already
// accepted elsewhere in this app for similar simplifications.
const SLOTS_JACKPOT_SEED = 5000;
const SLOTS_JACKPOT_CONTRIBUTION_RATE = 0.02;
let slotsJackpotAmount = SLOTS_JACKPOT_SEED;
function slotsUpdateJackpotDisplay(){
  const el = document.getElementById('slotsJackpotVal');
  if(el) el.textContent = Math.round(slotsJackpotAmount).toLocaleString();
}
async function slotsFetchJackpot(){
  try{
    const res = await authedFetch('/casinoSlotsJackpot/amount.json');
    const val = await res.json();
    slotsJackpotAmount = (typeof val === 'number' && val > 0) ? val : SLOTS_JACKPOT_SEED;
  }catch(e){
    slotsJackpotAmount = SLOTS_JACKPOT_SEED;
  }
  slotsUpdateJackpotDisplay();
}
async function slotsContributeToJackpot(betAmount){
  const contribution = Math.max(1, Math.round(betAmount * SLOTS_JACKPOT_CONTRIBUTION_RATE));
  slotsJackpotAmount += contribution; // optimistic local update, shown immediately
  slotsUpdateJackpotDisplay();
  try{
    const res = await authedFetch('/casinoSlotsJackpot/amount.json');
    const current = await res.json();
    const base = (typeof current === 'number' && current > 0) ? current : SLOTS_JACKPOT_SEED;
    const next = base + contribution;
    await authedFetch('/casinoSlotsJackpot/amount.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next)
    });
    slotsJackpotAmount = next; // reconcile to the real server value once confirmed
    slotsUpdateJackpotDisplay();
  }catch(e){}
}
async function slotsPayJackpot(){
  const won = Math.round(slotsJackpotAmount);
  slotsMachineBalance += won;
  slotsUpdateMachineBalanceDisplay();
  slotsJackpotAmount = SLOTS_JACKPOT_SEED;
  slotsUpdateJackpotDisplay();
  try{
    await authedFetch('/casinoSlotsJackpot/amount.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SLOTS_JACKPOT_SEED)
    });
  }catch(e){}
  return won;
}
let slotsActiveLineCount = 3;

// ---- Auto Spin — fires slotsSpin() repeatedly up to a chosen count
// (5/10/20), stopping early the moment a Free Spins feature triggers.
// From there the bonus plays itself out independently (see the
// self-continuing call at the end of slotsSpin) rather than resuming the
// auto-spin count afterward — the feature is the payoff moment, so
// control hands back to the player once it's done, same convention real
// pokie autoplay uses.
let slotsAutoSpinCount = 10;
let slotsAutoSpinRemaining = 0;
let slotsAutoSpinRunning = false;

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
  slotsFetchJackpot();
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
// called once per active payline instead of just once per spin. Wild
// substitution: the line's "anchor" symbol is the first NON-wild symbol
// found scanning left to right (so a wild sitting on reel 1 doesn't
// itself decide the payout — it takes on whatever real symbol appears
// next, same convention every real slot uses), and every wild along the
// run counts as a match for that anchor. A line that's wild the whole
// way across counts as the single highest-paying symbol.
function slotsEvaluateRun(lineSymbols){
  let anchor = lineSymbols.find(s => s !== SLOTS_WILD_SYMBOL);
  if(!anchor) anchor = SLOTS_SYMBOLS[SLOTS_SYMBOLS.length - 1].sym; // all-wild line
  let run = 0;
  for(let i = 0; i < lineSymbols.length; i++){
    if(lineSymbols[i] === anchor || lineSymbols[i] === SLOTS_WILD_SYMBOL) run++;
    else break;
  }
  return { run, anchor };
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
  document.querySelectorAll('#slotsAutoSpinCountRow .craps-winmode-btn').forEach(b => { b.disabled = locked; });
  const autoBtn = document.getElementById('slotsAutoSpinBtn');
  if(autoBtn) autoBtn.disabled = locked;
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
    // Machine Balance covers the bet first — only the shortfall beyond
    // it is ever actually at risk from real XP. If it fully covers this
    // bet's worst case, there's nothing to check against real XP at all
    // (and no need to spend a balance read doing it).
    const xpAtRisk = Math.max(0, totalBet - slotsMachineBalance);
    if(xpAtRisk > 0){
      const balance = await getXPBalance();
      if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; spinBtn.disabled = false; return; }
      if(xpAtRisk > balance){
        errEl.textContent = slotsMachineBalance > 0
          ? `Your Machine Balance covers ${slotsMachineBalance.toLocaleString()} of this ${totalBet.toLocaleString()} XP bet, but you only have ${balance.toLocaleString()} XP for the remaining ${xpAtRisk.toLocaleString()}.`
          : `You only have ${balance} XP (total bet: ${totalBet}).`;
        spinBtn.disabled = false; return;
      }
    }
    // Fire-and-forget — doesn't hold up the spin animation waiting on
    // this. Free spins don't contribute (nothing genuinely staked).
    slotsContributeToJackpot(totalBet);
  }

  if(sameBtn) sameBtn.disabled = true;
  const resultEl = document.getElementById('slotsResultMsg');
  resultEl.textContent = '';
  resultEl.classList.remove('bj-outcome-pop', 'bj-outcome-jackpot', 'slots-mega-outcome', 'slots-retrigger-outcome', 'slots-jackpot-outcome');
  document.getElementById('slotsLinesOverlay').innerHTML = '';
  document.querySelectorAll('.slots-symbol.slots-win-cell').forEach(el => el.classList.remove('slots-win-cell', 'slots-wild-cell'));
  document.querySelectorAll('.slots-symbol.slots-scatter-tease').forEach(el => el.classList.remove('slots-scatter-tease'));
  const prevBigWinBanner = document.getElementById('slotsBigWinBanner');
  if(prevBigWinBanner) prevBigWinBanner.style.display = 'none';

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
  // Spin the Wheel's synth marks the moment it lands. Once 2+ scatters
  // have landed on already-revealed reels while a later reel is still
  // spinning, every landed one pulses (slots-scatter-tease) — the
  // classic "is this going to hit?" suspense beat real pokies use before
  // the deciding reel lands, distinct from the confirmed-win gold glow.
  slotsStartAmbientHum();
  await Promise.all(grid.map((finals, i) => (async () => {
    await bjWait(i * 300);
    await slotsSpinReel('slotsReel' + i, finals, 1400 + i * 300);
    dailySpinPlayPegTick();
    const landedScatterCount = grid.slice(0, i + 1).reduce((n, symbols) => n + symbols.filter(s => s === SLOTS_SCATTER_SYMBOL).length, 0);
    if(landedScatterCount >= 2 && i < SLOTS_REEL_COUNT - 1){
      slotsPlayAnticipationRiser();
      for(let r = 0; r <= i; r++){
        const reelEl2 = document.getElementById('slotsReel' + r);
        grid[r].forEach((sym, row) => {
          if(sym === SLOTS_SCATTER_SYMBOL){
            const cell = reelEl2 && reelEl2.querySelectorAll('.slots-symbol')[row];
            if(cell) cell.classList.add('slots-scatter-tease');
          }
        });
      }
    }
  })()));
  slotsStopAmbientHum();
  document.querySelectorAll('.slots-symbol.slots-scatter-tease').forEach(el => el.classList.remove('slots-scatter-tease'));

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
  let progressiveJackpotWon = false; // 5-of-a-kind wild on an active payline
  const winningLineIndexes = [];
  const winParts = [];
  const winningCellKeys = new Set();

  activeLines.forEach((line, lineIdx) => {
    const lineSymbols = line.rows.map((row, reelI) => grid[reelI][row]);
    const { run, anchor } = slotsEvaluateRun(lineSymbols);
    if(run < 2) return; // this line didn't hit — no different from a real machine's dark line
    if(run === 5 && anchor === SLOTS_WILD_SYMBOL) progressiveJackpotWon = true;
    const symData = SLOTS_SYMBOLS.find(s => s.sym === anchor);
    let delta;
    if(run >= 3){
      const mult = run === 3 ? symData.mult3 : (run === 4 ? symData.mult4 : symData.mult5);
      delta = perLine * mult;
      if(mult >= 50) isJackpot = true;
    } else {
      delta = perLine; // 2 matching — 1:1 consolation, same as the original single-line machine
    }
    if(isFreeSpin) delta *= slotsFreeSpinsMultiplier;
    totalDelta += delta;
    winningLineIndexes.push(lineIdx);
    const hasWild = lineSymbols.slice(0, run).includes(SLOTS_WILD_SYMBOL) && anchor !== SLOTS_WILD_SYMBOL;
    winParts.push(`${line.name} ${run}×${anchor}${hasWild ? ' (wild assist)' : ''} (+${delta})`);
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
  // Kept entirely separate from totalDelta — slotsPayJackpot already
  // credits the win straight into Machine Balance itself, so folding it
  // into totalDelta too would double-count it once the normal win/loss
  // settlement below runs.
  let jackpotWonAmount = 0;
  if(progressiveJackpotWon){
    jackpotWonAmount = await slotsPayJackpot();
  }

  // Scatter check — anywhere on the board, independent of paylines or
  // whether this spin even won anything on a line. Can retrigger during
  // an existing bonus (adds more spins on top of whatever's left) — and
  // a retrigger that lands MEGA's 5-of-a-kind while a standard bonus is
  // already running doesn't just add spins, it UPGRADES the running
  // bonus to MEGA's multiplier for everything still left — a genuine
  // "feature within a feature" moment, not just more of the same. Once
  // a bonus is already at MEGA, a further retrigger (any tier) only
  // ever adds spins — there's no higher tier to upgrade into.
  const scatterCount = grid.reduce((n, reelSymbols) => n + reelSymbols.filter(s => s === SLOTS_SCATTER_SYMBOL).length, 0);
  const triggeredFreeSpins = scatterCount >= SLOTS_FREE_SPINS_TRIGGER_COUNT;
  const isMegaTrigger = scatterCount >= SLOTS_MEGA_TRIGGER_COUNT;
  const thisTriggerAward = isMegaTrigger ? SLOTS_MEGA_FREE_SPINS_AWARD : SLOTS_FREE_SPINS_AWARD;
  let isRetrigger = false;
  let isTierUpgrade = false;
  if(triggeredFreeSpins){
    const wasAlreadyInBonus = slotsFreeSpinsRemaining > 0;
    isRetrigger = wasAlreadyInBonus;
    if(!wasAlreadyInBonus){
      slotsFreeSpinsBet = { amountPerLine: perLine, lines: lineCount };
      slotsSetControlsLockedForFreeSpins(true);
      slotsFreeSpinsMultiplier = isMegaTrigger ? SLOTS_MEGA_FREE_SPINS_MULTIPLIER : SLOTS_FREE_SPINS_MULTIPLIER;
      slotsFreeSpinsIsMega = isMegaTrigger;
    } else if(isMegaTrigger && !slotsFreeSpinsIsMega){
      // The feature-within-a-feature moment: a standard bonus just got
      // hit by a MEGA retrigger mid-run. Upgrade takes effect for every
      // spin still remaining in the bonus, not retroactively.
      isTierUpgrade = true;
      slotsFreeSpinsMultiplier = SLOTS_MEGA_FREE_SPINS_MULTIPLIER;
      slotsFreeSpinsIsMega = true;
    }
    slotsFreeSpinsRemaining += thisTriggerAward;
  }
  if(isFreeSpin) slotsFreeSpinsRemaining--;
  const bonusJustEnded = isFreeSpin && slotsFreeSpinsRemaining <= 0;
  if(bonusJustEnded){
    slotsFreeSpinsRemaining = 0;
    slotsFreeSpinsBet = null;
    slotsFreeSpinsIsMega = false;
    slotsSetControlsLockedForFreeSpins(false);
  }

  const jackpotPrefix = progressiveJackpotWon
    ? `💰🎰 PROGRESSIVE JACKPOT!!! +${jackpotWonAmount.toLocaleString()} XP  `
    : '';
  const resultPrefix = jackpotPrefix + (triggeredFreeSpins
    ? (isTierUpgrade
        ? `👑🔁 UPGRADED TO MEGA! +${SLOTS_MEGA_FREE_SPINS_AWARD} more spins, now paying ${SLOTS_MEGA_FREE_SPINS_MULTIPLIER}x for the rest of the bonus!!  `
        : isRetrigger
          ? (isMegaTrigger
              ? `👑🔁 MEGA RETRIGGER! +${SLOTS_MEGA_FREE_SPINS_AWARD} more free spins!!  `
              : `🔁 RETRIGGERED! +${SLOTS_FREE_SPINS_AWARD} more free spins!  `)
          : (isMegaTrigger
              ? `👑 MEGA! ${scatterCount}×${SLOTS_SCATTER_SYMBOL} — +${SLOTS_MEGA_FREE_SPINS_AWARD} FREE SPINS at ${SLOTS_MEGA_FREE_SPINS_MULTIPLIER}x!!  `
              : `🎉 ${scatterCount}×${SLOTS_SCATTER_SYMBOL} — +${SLOTS_FREE_SPINS_AWARD} FREE SPINS at ${SLOTS_FREE_SPINS_MULTIPLIER}x!  `))
    : '');
  resultEl.textContent = resultPrefix + (winParts.length > 0
    ? `${winParts.join(' · ')} — Total: ${totalDelta >= 0 ? '+' : ''}${totalDelta} XP`
    : (isFreeSpin ? `No line hit (0 XP — free spin, nothing lost)` : `No line hit (${totalDelta} XP)`));
  resultEl.style.color = isJackpot ? '' : (totalDelta > 0 ? 'var(--win)' : (totalDelta < 0 ? 'var(--loss)' : 'var(--muted)'));
  resultEl.classList.add(progressiveJackpotWon ? 'slots-jackpot-outcome' : ((isMegaTrigger || isTierUpgrade) ? 'slots-mega-outcome' : (isRetrigger ? 'slots-retrigger-outcome' : (isJackpot ? 'bj-outcome-jackpot' : 'bj-outcome-pop'))));

  slotsDrawWinLines(winningLineIndexes);
  slotsRenderPaylinesKey(winningLineIndexes);
  winningCellKeys.forEach(key => {
    const [reelI, row] = key.split('-').map(Number);
    const reelEl = document.getElementById('slotsReel' + reelI);
    const cell = reelEl && reelEl.querySelectorAll('.slots-symbol')[row];
    if(cell){
      cell.classList.add('slots-win-cell');
      if(grid[reelI][row] === SLOTS_WILD_SYMBOL) cell.classList.add('slots-wild-cell');
    }
  });

  const panelEl = document.getElementById('casinoGameSlots');
  // Big Win escalation — based on how big THIS win was relative to what
  // was actually staked (not a fixed XP amount, so it scales with
  // anyone's bet size), separate from the scatter-feature and jackpot
  // celebrations above it in priority. Doesn't fire on a scatter-trigger
  // spin (that already has its own announcement) or the jackpot spin.
  const stakeRef = (perLine * lineCount) || 1;
  const winRatio = totalDelta / stakeRef;
  let bigWinTier = null;
  if(!progressiveJackpotWon && !triggeredFreeSpins && totalDelta > 0){
    if(winRatio >= 50) bigWinTier = 'EPIC';
    else if(winRatio >= 25) bigWinTier = 'SUPER';
    else if(winRatio >= 10) bigWinTier = 'BIG';
  }
  if(progressiveJackpotWon){
    // The single biggest possible moment in the game — bigger reaction
    // than even MEGA: three confetti bursts, an escalating fanfare, and
    // the coin cascade plus cha-ching ticks together.
    panelEl.classList.remove('slots-mega-flash'); void panelEl.offsetWidth; panelEl.classList.add('slots-mega-flash');
    setTimeout(() => panelEl.classList.remove('slots-mega-flash'), 900);
    setTimeout(() => { panelEl.classList.remove('slots-mega-flash'); void panelEl.offsetWidth; panelEl.classList.add('slots-mega-flash'); setTimeout(() => panelEl.classList.remove('slots-mega-flash'), 900); }, 550);
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, 90);
    slotsPlayCoinCascade(true);
    slotsPlayCountUpTicks();
    setTimeout(() => { bjPlayChime(true); bjLaunchConfetti(resultEl, 70); }, 450);
    setTimeout(() => { bjPlayChime(true); bjLaunchConfetti(resultEl, 60); }, 900);
  } else if(isMegaTrigger){
    // The rarest possible result gets the biggest reaction in the game —
    // a full flash, a double burst of confetti (immediate + a follow-up
    // half a second later, reads as more sustained than one big dump),
    // and a two-part fanfare instead of the usual single chime. Its own
    // dedicated flash class (not pc-flash-gold — that one only works on
    // elements with a .panel class, and this container is
    // .casino-game-panel, so it would've silently done nothing here).
    panelEl.classList.remove('slots-mega-flash'); void panelEl.offsetWidth; panelEl.classList.add('slots-mega-flash');
    setTimeout(() => panelEl.classList.remove('slots-mega-flash'), 800);
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, 70);
    slotsPlayCoinCascade(true); // was defined but never actually called anywhere — real audio flair, put to use here
    setTimeout(() => { bjPlayChime(true); bjLaunchConfetti(resultEl, 60); }, 500);
  } else if(triggeredFreeSpins){
    // Triggering the bonus is always a celebration moment, even if this
    // particular spin's own lines net-lost — same reasoning a real
    // machine uses (the scatter hit overrides the line outcome's mood).
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, 50);
  } else if(bigWinTier){
    slotsShowBigWinBanner(bigWinTier, totalDelta);
  } else if(totalDelta > 0){
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, isJackpot ? 42 : 20);
  } else if(totalDelta < 0){
    bjPlayChime(false);
    panelEl.classList.remove('pc-shake'); void panelEl.offsetWidth; panelEl.classList.add('pc-shake');
    setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
  }
  // A real (non-free-spin) win gets offered the Gamble feature instead of
  // being credited immediately — the actual credit into Machine Balance
  // happens on Collect (see slotsGambleCollect), not here, to avoid
  // double-crediting. A free-spin win is pure profit (nothing was
  // staked that spin) and banks straight into Machine Balance too — no
  // win ever auto-credits real XP directly anymore; Cash Out is always
  // the deliberate step for that. A loss draws down Machine Balance
  // first, and only reaches into real XP for whatever it doesn't cover.
  const goesToGamble = totalDelta > 0 && !isFreeSpin;
  if(totalDelta > 0 && !goesToGamble){
    slotsMachineBalance += totalDelta;
  } else if(totalDelta < 0){
    const loss = -totalDelta;
    const fromMachine = Math.min(slotsMachineBalance, loss);
    slotsMachineBalance -= fromMachine;
    const fromXP = loss - fromMachine;
    if(fromXP > 0) await awardXP(-fromXP, 'Slots loss', { silent: true });
  }
  slotsUpdateMachineBalanceDisplay();
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  slotsUpdateTotalBetHint();
  if(goesToGamble) slotsOfferGamble(totalDelta);
  // Bonus self-play: once a Free Spins feature is active (just started
  // or continuing) the whole thing plays itself out automatically —
  // real pokies never make you keep tapping through a bonus you already
  // won. Runs regardless of whether this spin was manual or from the
  // Auto Spin loop (which stops itself the moment it sees this happen —
  // see slotsRunAutoSpin). Skipped here specifically when this same spin
  // ALSO triggered the Gamble offer (a line win plus 3+ scatters landing
  // together): the bonus stays armed but waits for that decision to
  // actually resolve first — slotsGambleClose picks it up from there —
  // rather than auto-spinning reels underneath an unresolved Gamble
  // choice, which would be a genuinely confusing collision.
  if(!bonusJustEnded && slotsFreeSpinsRemaining > 0 && !goesToGamble){
    setTimeout(() => { slotsSpin(); }, 900);
  }
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
document.getElementById('slotsChipDisplay').addEventListener('click', async () => {
  const input = document.getElementById('slotsBetInput');
  const amount = await openChipAmountModal(input.value || '50', 'Bet amount per line (XP)');
  if(amount == null) return;
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
  // Real bug, confirmed: slotsGambleCollect's SUCCESS path disables these
  // buttons then calls slotsGambleClose(), which resets slotsGambleBusy
  // but never re-enables them — only the catch block did. So after your
  // first successful Collect in a session, every button here stayed
  // disabled=true forever, carried silently into every later gamble
  // offer. Unconditionally re-enabling on every fresh offer, regardless
  // of whatever state they were left in, is the one fix point that
  // covers all paths into this screen.
  slotsGambleSetButtonsDisabled(false);
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
    // Banks into Machine Balance, not real XP directly — consistent
    // with every other win path now: nothing auto-credits real XP,
    // Cash Out is always the deliberate step for that.
    if(slotsGamblePot > 0){
      slotsMachineBalance += slotsGamblePot;
      slotsUpdateMachineBalanceDisplay();
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
  // Picks up the bonus self-play deferred by slotsSpin when this same
  // win also triggered a Free Spins feature — now that the Gamble
  // decision is actually settled, it's safe to start auto-spinning the
  // bonus without stepping on an unresolved choice.
  if(slotsFreeSpinsRemaining > 0){
    setTimeout(() => { slotsSpin(); }, 900);
  }
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

// ---- Auto Spin ----
document.querySelectorAll('#slotsAutoSpinCountRow .craps-winmode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if(slotsAutoSpinRunning) return; // can't change the count mid-run
    slotsAutoSpinCount = parseInt(btn.dataset.auto, 10) || 10;
    document.querySelectorAll('#slotsAutoSpinCountRow .craps-winmode-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});
async function slotsRunAutoSpin(){
  slotsAutoSpinRemaining = slotsAutoSpinCount;
  const btn = document.getElementById('slotsAutoSpinBtn');
  const errEl = document.getElementById('slotsBetError');
  while(slotsAutoSpinRunning && slotsAutoSpinRemaining > 0){
    // A bonus already running itself (see slotsSpin's self-continue)
    // takes over completely — the base loop stops rather than firing a
    // second, competing spin alongside it.
    if(slotsFreeSpinsRemaining > 0) break;
    const spinBtn = document.getElementById('slotsSpinBtn');
    if(spinBtn.disabled){ await bjWait(150); continue; } // something else mid-spin — wait it out, don't skip a count
    if(errEl) errEl.textContent = '';
    btn.textContent = `⏹ Stop (${slotsAutoSpinRemaining} left)`;
    await slotsSpin();
    // A validation failure (no balance, bad bet, etc.) returns instantly
    // with an error message rather than actually spinning — stop rather
    // than silently burning through the whole count hitting the same
    // wall over and over.
    if(errEl && errEl.textContent){ break; }
    // Let the win/lose message and any confetti actually be seen before
    // firing the next spin — a rapid-fire blur would undercut the whole
    // point of asking for more excitement, not add to it.
    await bjWait(700);
    if(slotsFreeSpinsRemaining > 0) break; // this exact spin was the one that triggered the feature
    slotsAutoSpinRemaining--;
  }
  slotsAutoSpinRunning = false;
  if(btn){ btn.textContent = '🔄 Auto'; btn.classList.remove('slots-auto-running'); }
}
document.getElementById('slotsAutoSpinBtn').addEventListener('click', () => {
  const btn = document.getElementById('slotsAutoSpinBtn');
  if(slotsAutoSpinRunning){
    // Stops after the spin currently in flight finishes — same
    // "let the current action land cleanly" pattern used everywhere
    // else rather than yanking the reels mid-motion.
    slotsAutoSpinRunning = false;
    return;
  }
  slotsAutoSpinRunning = true;
  btn.classList.add('slots-auto-running');
  slotsRunAutoSpin();
});

// ---- Machine Balance Cash Out ----
document.getElementById('slotsCashOutBtn').addEventListener('click', async () => {
  const btn = document.getElementById('slotsCashOutBtn');
  if(slotsMachineBalance <= 0 || btn.disabled) return;
  btn.disabled = true;
  const amount = slotsMachineBalance;
  const errEl = document.getElementById('slotsBetError');
  try{
    // Only zero the visible Machine Balance AFTER the real XP credit
    // actually succeeds — never optimistically clear it first, or a
    // failed request here would silently lose banked winnings with no
    // trace (the exact class of bug this app's own build history
    // flagged before: don't update local state before confirming the
    // write landed).
    await awardXP(amount, 'Slots cash out', { silent: true });
    slotsMachineBalance = 0;
    const bal = await getXPBalance();
    updateXPBalanceDisplay(bal);
    bjPlayChime(true);
  }catch(e){
    console.error('Slots cash out failed:', e);
    if(errEl) errEl.textContent = 'Could not cash out — check your connection and try again.';
  }finally{
    slotsUpdateMachineBalanceDisplay();
  }
});

// ---- Richer sound design ----
// Ambient reel hum: a soft continuous tone for as long as reels are
// actually spinning, stopped the instant they've all landed — gives the
// spin itself some presence instead of total silence until the result.
let slotsAmbientHumNodes = null;
function slotsStartAmbientHum(){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  slotsStopAmbientHum();
  const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 90;
  const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 220;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.035, ctx.currentTime + 0.15);
  osc.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  osc.start();
  slotsAmbientHumNodes = { osc, gain };
}
function slotsStopAmbientHum(){
  if(!slotsAmbientHumNodes) return;
  const { osc, gain } = slotsAmbientHumNodes;
  try{
    const ctx = bjGetAudioCtx();
    if(ctx){
      gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      setTimeout(() => { try{ osc.stop(); }catch(e){} }, 160);
    } else { osc.stop(); }
  }catch(e){}
  slotsAmbientHumNodes = null;
}
// Anticipation riser: a rising pitch synced to the same moment the
// scatter-tease visual pulse kicks in (2+ landed scatters, a later reel
// still spinning) — the audio equivalent of the same suspense beat.
function slotsPlayAnticipationRiser(){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(); osc.type = 'triangle';
  osc.frequency.setValueAtTime(440, now);
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.5);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.55);
}
// Cha-ching count-up ticks — timed to roughly match animateValue's fixed
// 700ms count-up duration, one crisp percussive tick per step so the
// climbing number actually sounds like it's climbing.
function slotsPlayCountUpTicks(){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const now = ctx.currentTime;
  const tickCount = 10;
  for(let i = 0; i < tickCount; i++){
    const t = now + i * 0.068;
    const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = 1600 + i * 55;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.07, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.06);
  }
}

// ---- Big Win escalation — tiered banner + count-up, based on win size
// relative to what was actually staked this spin, so it scales fairly
// regardless of anyone's bet size. Sits below the jackpot and MEGA-
// scatter celebrations in priority (see the celebration block above),
// so a spin that's already getting the biggest possible reaction never
// also gets this layered on top of it.
const SLOTS_BIGWIN_TIERS = {
  BIG:   { text: '🎉 BIG WIN',  cls: 'slots-bigwin-big',   confetti: 30, chimes: 1 },
  SUPER: { text: '🔥 SUPER WIN', cls: 'slots-bigwin-super', confetti: 50, chimes: 2 },
  EPIC:  { text: '💥 EPIC WIN',  cls: 'slots-bigwin-epic',  confetti: 75, chimes: 3 }
};
function slotsShowBigWinBanner(tier, amount){
  const banner = document.getElementById('slotsBigWinBanner');
  const label = document.getElementById('slotsBigWinLabel');
  const valueEl = document.getElementById('slotsBigWinValue');
  if(!banner || !label || !valueEl) return;
  const config = SLOTS_BIGWIN_TIERS[tier];
  label.textContent = config.text;
  banner.className = 'slots-bigwin-banner ' + config.cls;
  banner.style.display = 'flex';
  // Reset the count-up's own starting point so it always climbs from
  // zero, regardless of whatever value this element last animated to.
  valueEl._rawVal = 0;
  valueEl.textContent = '0 XP';
  animateValue('slotsBigWinValue', amount, v => Math.round(v).toLocaleString() + ' XP');
  slotsPlayCountUpTicks();
  bjLaunchConfetti(banner, config.confetti);
  for(let i = 0; i < config.chimes; i++){
    setTimeout(() => bjPlayChime(true), i * 350);
  }
  setTimeout(() => { banner.style.display = 'none'; }, 2600);
}
