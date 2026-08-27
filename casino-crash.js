// ================= Crash =================
// The multiplier climbs from 1.00x the instant you hit Start, following
// e^(t/T) — a smooth exponential, not a straight line, same "the longer
// you wait the faster it moves" feel as the real thing. Cash out any
// time before it crashes to lock in a payout of bet × whatever it's
// showing; miss the window and the crash point itself is what determines
// the loss, decided the moment the round starts (see
// crashGenerateCrashPoint), not faked after the fact to punish a
// particular cash-out.
//
// Crash point uses the standard fair-crash-game distribution: for any
// multiplier x you might cash out at, P(crash >= x) = RTP/x — which
// makes the expected return exactly RTP regardless of when you decide to
// cash out. Sampled via inverse transform: crashPoint = RTP / (1 - U)
// for U uniform in [0,1), clamped to a 1.00x floor. That floor clamp
// nudges true RTP a hair under the nominal 97% (a small, standard cost
// of not allowing an literally-sub-1.00x result), same honesty about the
// real number as every other game's stated RTP in this casino.
const CRASH_RTP = 0.97;
const CRASH_GROWTH_T = 2.5; // seconds — tuned so 2x lands around ~1.7s, 10x around ~5.7s
function crashGenerateCrashPoint(){
  const u = Math.random();
  const raw = CRASH_RTP / (1 - u);
  return Math.max(1.00, Math.round(raw * 100) / 100);
}

let crashRunning = false;
let crashCashedOut = false;
let crashCurrentMult = 1.00;
let crashCrashPoint = 1.00;
let crashBetAmount = 0;
let crashLastBet = null; // { amount }
let crashHistory = [];
let crashIntervalHandle = null;
let crashStartTime = 0;

function crashSetStartVisible(visible){
  const bottomBtn = document.getElementById('crashStartBtn');
  const topRow = document.getElementById('crashTopActions');
  if(bottomBtn) bottomBtn.style.display = visible ? 'inline-block' : 'none';
  if(topRow) topRow.style.display = visible ? 'flex' : 'none';
}
function crashSetCashOutVisible(visible){
  const topBtn = document.getElementById('crashCashOutTopBtn');
  const bottomBtn = document.getElementById('crashCashOutBtn');
  if(topBtn) topBtn.style.display = visible ? 'block' : 'none';
  if(bottomBtn) bottomBtn.style.display = visible ? 'inline-block' : 'none';
}
function crashSetSameBetEnabled(enabled){
  const topBtn = document.getElementById('crashSameBetTopBtn');
  const bottomBtn = document.getElementById('crashSameBetBtn');
  if(topBtn) topBtn.disabled = !enabled;
  if(bottomBtn) bottomBtn.disabled = !enabled;
}
function crashUpdateDisplay(mult){
  const el = document.getElementById('crashMultiplierVal');
  if(!el) return;
  el.textContent = mult.toFixed(2) + 'x';
  el.classList.remove('crash-mid', 'crash-hot', 'crash-busted');
  if(mult >= 5) el.classList.add('crash-hot');
  else if(mult >= 2) el.classList.add('crash-mid');
}

const CRASH_CROUPIER_LINES = {
  start: ['Away it goes.', 'Climbing — watch it.', 'Here we go.'],
  cashout: ['Cashed out — nice timing.', 'Locked it in.'],
  bust: ['Crashed — house wins this one.', 'Gone. Too greedy.']
};

async function crashStart(){
  if(crashRunning) return;
  const errEl = document.getElementById('crashBetError');
  errEl.textContent = '';
  const bet = parseInt(document.getElementById('crashBetInput').value, 10) || 0;
  if(!bet || bet < 5){ errEl.textContent = 'Minimum bet is 5 XP.'; return; }
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(bet > balance){ errEl.textContent = `You only have ${balance} XP.`; return; }

  scrollIntoViewSmooth('crashTableRail');
  crashBetAmount = bet;
  crashCrashPoint = crashGenerateCrashPoint();
  crashCurrentMult = 1.00;
  crashCashedOut = false;
  crashRunning = true;
  crashSetStartVisible(false);
  crashSetCashOutVisible(true);
  document.getElementById('crashResultMsg').textContent = '';
  const rocketEl = document.getElementById('crashRocket');
  if(rocketEl){ rocketEl.classList.remove('crash-busted'); rocketEl.classList.add('crash-flying'); }
  crashUpdateDisplay(1.00);
  croupierSay('crashCroupierMsg', CRASH_CROUPIER_LINES.start);
  bjPlayChipSound();
  bjPlaySpinSound();
  crashStartTime = Date.now();
  crashIntervalHandle = setInterval(crashTick, 60);
}
function crashTick(){
  const elapsed = (Date.now() - crashStartTime) / 1000;
  const mult = Math.exp(elapsed / CRASH_GROWTH_T);
  if(mult >= crashCrashPoint){
    crashCurrentMult = crashCrashPoint;
    crashUpdateDisplay(crashCurrentMult);
    crashHandleBust();
    return;
  }
  crashCurrentMult = mult;
  crashUpdateDisplay(mult);
}
async function crashCashOut(){
  if(!crashRunning || crashCashedOut) return;
  crashCashedOut = true;
  crashRunning = false;
  clearInterval(crashIntervalHandle);
  const rocketEl = document.getElementById('crashRocket');
  if(rocketEl) rocketEl.classList.remove('crash-flying');
  const payout = Math.round(crashBetAmount * crashCurrentMult);
  await crashResolve(payout, crashCurrentMult, true);
}
async function crashHandleBust(){
  crashRunning = false;
  clearInterval(crashIntervalHandle);
  const rocketEl = document.getElementById('crashRocket');
  if(rocketEl){ rocketEl.classList.remove('crash-flying'); rocketEl.classList.add('crash-busted'); }
  await crashResolve(0, crashCrashPoint, false);
}
async function crashResolve(payout, atMult, won){
  const delta = payout - crashBetAmount;
  const resultEl = document.getElementById('crashResultMsg');
  resultEl.textContent = won
    ? `Cashed out at ${atMult.toFixed(2)}x — +${delta} XP`
    : `Crashed at ${atMult.toFixed(2)}x — -${crashBetAmount} XP`;
  resultEl.style.color = won ? 'var(--win)' : 'var(--loss)';
  resultEl.classList.remove('bj-outcome-pop'); void resultEl.offsetWidth; resultEl.classList.add('bj-outcome-pop');

  crashHistory.push({ won, mult: atMult });
  const histEl = document.getElementById('crashHistory');
  if(histEl){
    histEl.innerHTML = crashHistory.slice(-10).reverse().map(h =>
      `<div class="craps-history-chip" style="background:${h.won ? 'var(--win)' : 'var(--loss)'};">${h.mult.toFixed(2)}x</div>`
    ).join('');
  }

  croupierSay('crashCroupierMsg', won ? CRASH_CROUPIER_LINES.cashout : CRASH_CROUPIER_LINES.bust);

  const railEl = document.getElementById('crashTableRail');
  if(won){
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, atMult >= 5 ? 42 : 20);
    railEl.classList.remove('pc-flash-gold'); void railEl.offsetWidth; railEl.classList.add('pc-flash-gold');
    setTimeout(() => railEl.classList.remove('pc-flash-gold'), 800);
  } else {
    bjPlayChime(false);
    railEl.classList.add('pc-shake');
    setTimeout(() => railEl.classList.remove('pc-shake'), 700);
  }

  crashSetCashOutVisible(false);
  crashSetStartVisible(true);
  crashLastBet = { amount: crashBetAmount };
  crashSetSameBetEnabled(true);

  if(delta !== 0) await awardXP(delta, delta > 0 ? 'Crash win' : 'Crash loss', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
}
document.getElementById('crashStartBtn').addEventListener('click', crashStart);
document.getElementById('crashStartTopBtn').addEventListener('click', crashStart);
document.getElementById('crashCashOutBtn').addEventListener('click', crashCashOut);
document.getElementById('crashCashOutTopBtn').addEventListener('click', crashCashOut);
function crashApplySameBet(){
  if(!crashLastBet || crashRunning) return;
  const betInput = document.getElementById('crashBetInput');
  betInput.value = crashLastBet.amount;
  betInput.dispatchEvent(new Event('input'));
  bjPlayChipSound();
}
document.getElementById('crashSameBetBtn').addEventListener('click', crashApplySameBet);
document.getElementById('crashSameBetTopBtn').addEventListener('click', crashApplySameBet);
document.getElementById('crashBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('crashChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
});
document.getElementById('crashChipDisplay').addEventListener('click', () => {
  if(crashRunning) return;
  const input = document.getElementById('crashBetInput');
  const entry = prompt('Bet amount (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
});
// ================= /Crash =================
