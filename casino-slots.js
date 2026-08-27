// ---- Slots (5 reels, single payline) ----
// Restored original polished implementation (recovered from an earlier
// build the user provided), replacing a differently-designed version —
// real translateY reel strips instead of class-toggle blur, sequential
// left-to-right reel stops reusing Spin the Wheel's own peg-tick sound,
// a clean run-based payline, and a proper ×3/×4/×5 column paytable
// (an earlier attempt repeated the symbol 3/4/5 times per row instead,
// which wrapped onto extra lines and looked cramped).
const SLOTS_REEL_COUNT = 5;
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
let slotsBuilt = false;
let slotsLastBet = 0;
function slotsBuildReelStrip(reelEl, finalSymbol, stripLength){
  const symbols = [];
  for(let i = 0; i < stripLength - 1; i++) symbols.push(slotsPickSymbol());
  symbols.push(finalSymbol); // last one is what ends up centered in the window
  const strip = document.createElement('div');
  strip.className = 'slots-symbol-strip';
  strip.innerHTML = symbols.map(s => `<div class="slots-symbol">${s}</div>`).join('');
  reelEl.innerHTML = '';
  reelEl.appendChild(strip);
  return strip;
}
function slotsBuildInitial(){
  for(let i = 0; i < SLOTS_REEL_COUNT; i++){
    slotsBuildReelStrip(document.getElementById('slotsReel' + i), slotsPickSymbol(), 1);
  }
  slotsBuilt = true;
}
async function slotsSpinReel(reelId, finalSymbol, duration){
  const reelEl = document.getElementById(reelId);
  const stripLength = 24;
  const strip = slotsBuildReelStrip(reelEl, finalSymbol, stripLength);
  strip.style.transition = 'none';
  strip.style.transform = 'translateY(0)';
  void strip.offsetWidth;
  const targetY = -(stripLength - 1) * SLOTS_SYMBOL_HEIGHT;
  strip.style.transition = `transform ${duration}ms cubic-bezier(.17,.67,.24,1)`;
  strip.style.transform = `translateY(${targetY}px)`;
  await bjWait(duration);
}
function slotsBuildPaytable(){
  const header = `<div class="slots-pt-header"><div></div><div>&times;3</div><div>&times;4</div><div>&times;5</div></div>`;
  const rows = SLOTS_SYMBOLS.map(s =>
    `<div class="slots-pt-row"><div class="slots-pt-sym">${s.sym}</div><div class="vp-pt-mult">${s.mult3}:1</div><div class="vp-pt-mult">${s.mult4}:1</div><div class="vp-pt-mult">${s.mult5}:1</div></div>`
  ).join('');
  const consolation = `<div class="slots-pt-consolation"><span class="vp-pt-name">Any 2 matching (left to right)</span><span class="vp-pt-mult">1:1</span></div>`;
  document.getElementById('slotsPaytable').innerHTML = header + rows + consolation;
}
// Standard "left to right" slot payline: count how many reels, starting
// from reel 1, match in an unbroken run — 2 matching is a small
// consolation win, 3/4/5 pay escalating multipliers per the paytable, a
// broken run (e.g. reel 1 and 3 match but not 2) pays nothing, exactly
// like a real machine's payline rule.
function slotsEvaluateRun(finals){
  let run = 1;
  for(let i = 1; i < finals.length; i++){
    if(finals[i] === finals[0]) run++;
    else break;
  }
  return run;
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
  const bet = parseInt(document.getElementById('slotsBetInput').value, 10) || 0;
  if(bet <= 0){ errEl.textContent = 'Add some chips first.'; spinBtn.disabled = false; return; }
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; spinBtn.disabled = false; return; }
  if(bet > balance){ errEl.textContent = `You only have ${balance} XP.`; spinBtn.disabled = false; return; }

  if(sameBtn) sameBtn.disabled = true;
  const resultEl = document.getElementById('slotsResultMsg');
  resultEl.textContent = '';
  resultEl.classList.remove('bj-outcome-pop', 'bj-outcome-jackpot');
  bjPlayChipSound();

  const finals = [];
  for(let i = 0; i < SLOTS_REEL_COUNT; i++) finals.push(slotsPickSymbol());
  // Reels stop in sequence left to right (classic slot suspense) rather
  // than all at once — each one's own peg-tick-style sound reused from
  // Spin the Wheel's synth marks the moment it lands.
  await Promise.all(finals.map((sym, i) => (async () => {
    await bjWait(i * 300);
    await slotsSpinReel('slotsReel' + i, sym, 1400 + i * 300);
    dailySpinPlayPegTick();
  })()));

  spinBtn.disabled = false;
  slotsLastBet = bet;
  if(sameBtn) sameBtn.disabled = false;

  const run = slotsEvaluateRun(finals);
  const symData = SLOTS_SYMBOLS.find(s => s.sym === finals[0]);
  let delta, outcome, isJackpot = false;
  if(run >= 3){
    const mult = run === 3 ? symData.mult3 : (run === 4 ? symData.mult4 : symData.mult5);
    delta = bet * mult;
    outcome = `${run} \u00d7 ${finals[0]}! ${mult}:1`;
    isJackpot = mult >= 50;
  } else if(run === 2){
    delta = bet;
    outcome = 'Two match \u2014 small win';
  } else {
    delta = -bet;
    outcome = 'No match';
  }

  resultEl.textContent = `${outcome} (${delta >= 0 ? '+' : ''}${delta} XP)`;
  resultEl.style.color = isJackpot ? '' : (delta > 0 ? 'var(--win)' : 'var(--loss)');
  resultEl.classList.add(isJackpot ? 'bj-outcome-jackpot' : 'bj-outcome-pop');

  const panelEl = document.getElementById('casinoGameSlots');
  if(delta > 0){
    bjPlayChime(true);
    document.querySelectorAll('.slots-reel').forEach((r, i) => {
      if(i < run){ r.classList.remove('pc-reel-win'); void r.offsetWidth; r.classList.add('pc-reel-win'); }
    });
    bjLaunchConfetti(resultEl, isJackpot ? 42 : 20);
  } else if(delta < 0){
    bjPlayChime(false);
    panelEl.classList.remove('pc-shake'); void panelEl.offsetWidth; panelEl.classList.add('pc-shake');
    setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
  }
  if(delta !== 0) await awardXP(delta, delta > 0 ? 'Slots win' : 'Slots loss', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
}
document.getElementById('slotsSpinBtn').addEventListener('click', slotsSpin);
document.getElementById('slotsSameBetBtn').addEventListener('click', () => {
  if(!slotsLastBet) return;
  const input = document.getElementById('slotsBetInput');
  input.value = slotsLastBet;
  input.dispatchEvent(new Event('input'));
});
document.getElementById('slotsBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('slotsChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
});

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
