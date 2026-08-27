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
const CRASH_VISUAL_WINDOW = 8; // seconds — the graph's horizontal span; past this the rocket rides the right edge, still climbing in height
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
let crashSparkIntervalHandle = null;
let crashStartTime = 0;
let crashPathPoints = [];

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
// Single source of truth for "how dangerous does this feel right now" —
// drives the number's colour/pulse speed, the graph line's colour, the
// box's danger glow, and the Cash Out button's urgency together so they
// always agree with each other.
function crashDangerTier(mult){
  if(mult >= 5) return 'hot';
  if(mult >= 2) return 'mid';
  return 'calm';
}
function crashUpdateDisplay(mult, elapsed){
  const el = document.getElementById('crashMultiplierVal');
  const tier = crashDangerTier(mult);
  if(el){
    el.textContent = mult.toFixed(2) + 'x';
    el.classList.remove('crash-mid', 'crash-hot');
    if(tier === 'mid') el.classList.add('crash-mid');
    else if(tier === 'hot') el.classList.add('crash-hot');
  }
  const box = document.getElementById('crashGraphBox');
  if(box){
    box.classList.remove('crash-danger-1', 'crash-danger-2');
    if(tier === 'mid') box.classList.add('crash-danger-1');
    else if(tier === 'hot') box.classList.add('crash-danger-2');
  }
  const cashBtn = document.getElementById('crashCashOutTopBtn');
  if(cashBtn){
    cashBtn.classList.remove('crash-cashout-warm', 'crash-cashout-hot');
    if(tier === 'mid') cashBtn.classList.add('crash-cashout-warm');
    else if(tier === 'hot') cashBtn.classList.add('crash-cashout-hot');
  }
  const line = document.getElementById('crashGraphLine');
  if(line){
    line.classList.remove('crash-line-mid', 'crash-line-hot');
    if(tier === 'mid') line.classList.add('crash-line-mid');
    else if(tier === 'hot') line.classList.add('crash-line-hot');
  }
  if(elapsed != null) crashUpdateGraph(mult, elapsed);
}
// Plots the rocket's actual path — x from elapsed time (capped at the
// visual window, so it rides the right edge rather than running off
// forever on a long round), y from 1 - 1/mult (asymptotic, always inside
// [0,1) no matter how high mult goes, so it can never overflow the box).
// Real coordinates, not a decorative loop — the same numbers driving the
// rocket icon's position also become the SVG polyline's points.
function crashUpdateGraph(mult, elapsed){
  const normX = Math.min(elapsed / CRASH_VISUAL_WINDOW, 1);
  const normY = 1 - 1 / mult;
  const px = normX * 100;
  const pyTop = 100 - normY * 100; // SVG y grows downward; flip so "up" reads as climbing
  crashPathPoints.push(`${px.toFixed(2)},${pyTop.toFixed(2)}`);
  const line = document.getElementById('crashGraphLine');
  if(line) line.setAttribute('points', crashPathPoints.join(' '));
  const rocket = document.getElementById('crashRocket');
  if(rocket){
    rocket.style.left = px + '%';
    rocket.style.bottom = (normY * 100) + '%';
  }
}
function crashSpawnSpark(){
  const box = document.getElementById('crashGraphBox');
  const rocket = document.getElementById('crashRocket');
  if(!box || !rocket) return;
  const spark = document.createElement('div');
  spark.className = 'crash-spark';
  spark.style.left = rocket.style.left;
  spark.style.bottom = rocket.style.bottom;
  box.appendChild(spark);
  setTimeout(() => spark.remove(), 700);
}
function crashExplode(){
  const box = document.getElementById('crashGraphBox');
  const rocket = document.getElementById('crashRocket');
  if(!box || !rocket) return;
  const originLeft = rocket.style.left;
  const originBottom = rocket.style.bottom;
  const count = 14;
  for(let i = 0; i < count; i++){
    const p = document.createElement('div');
    p.className = 'crash-explosion-particle';
    p.style.left = originLeft;
    p.style.bottom = originBottom;
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.3;
    const dist = 26 + Math.random() * 34;
    p.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
    p.style.setProperty('--dy', (-Math.sin(angle) * dist).toFixed(1) + 'px');
    box.appendChild(p);
    setTimeout(() => p.remove(), 650);
  }
  box.classList.remove('crash-flash'); void box.offsetWidth; box.classList.add('crash-flash');
  setTimeout(() => box.classList.remove('crash-flash'), 400);
}

const CRASH_CROUPIER_LINES = {
  start: ['Away it goes.', 'Climbing — watch it.', 'Here we go.'],
  cashout: ['Cashed out — nice timing.', 'Locked it in.'],
  bust: ['Crashed — house wins this one.', 'Gone. Too greedy.']
};

async function crashStart(){
  if(crashRunning) return;
  // Guard flag AND hiding Start both happen synchronously, before any
  // await — same fix as Double or Nothing's identical bug: a fast
  // double-tap on Start could previously slip a second round in during
  // the balance-check window, before crashRunning ever went true. Any
  // validation failure below now unwinds this (un-hides Start, clears
  // the flag) before returning, instead of never having set it.
  crashRunning = true;
  crashSetStartVisible(false);
  const errEl = document.getElementById('crashBetError');
  errEl.textContent = '';
  const bet = parseInt(document.getElementById('crashBetInput').value, 10) || 0;
  if(!bet || bet < 5){
    errEl.textContent = 'Minimum bet is 5 XP.';
    crashRunning = false; crashSetStartVisible(true);
    return;
  }
  const balance = await getXPBalance();
  if(balance == null){
    errEl.textContent = 'Could not check your XP balance — try again.';
    crashRunning = false; crashSetStartVisible(true);
    return;
  }
  if(bet > balance){
    errEl.textContent = `You only have ${balance} XP.`;
    crashRunning = false; crashSetStartVisible(true);
    return;
  }

  scrollIntoViewSmooth('crashTableRail');
  crashBetAmount = bet;
  crashCrashPoint = crashGenerateCrashPoint();
  crashCurrentMult = 1.00;
  crashCashedOut = false;
  crashPathPoints = ['0,100'];
  crashSetCashOutVisible(true);
  document.getElementById('crashResultMsg').textContent = '';
  const rocketEl = document.getElementById('crashRocket');
  const lineEl = document.getElementById('crashGraphLine');
  const numEl = document.getElementById('crashMultiplierVal');
  if(rocketEl){ rocketEl.style.opacity = '1'; rocketEl.classList.remove('crash-busted'); rocketEl.classList.add('crash-flying'); rocketEl.style.left = '0%'; rocketEl.style.bottom = '0%'; }
  if(lineEl){ lineEl.classList.remove('crash-line-mid', 'crash-line-hot', 'crash-line-busted'); lineEl.setAttribute('points', '0,100'); }
  if(numEl){ numEl.classList.remove('crash-busted'); numEl.classList.add('crash-flying'); }
  crashUpdateDisplay(1.00, 0);
  croupierSay('crashCroupierMsg', CRASH_CROUPIER_LINES.start);
  bjPlayChipSound();
  bjPlaySpinSound();
  crashStartTime = Date.now();
  crashIntervalHandle = setInterval(crashTick, 60);
  crashSparkIntervalHandle = setInterval(crashSpawnSpark, 130);
}
function crashTick(){
  const elapsed = (Date.now() - crashStartTime) / 1000;
  const mult = Math.exp(elapsed / CRASH_GROWTH_T);
  if(mult >= crashCrashPoint){
    crashCurrentMult = crashCrashPoint;
    const finalElapsed = Math.log(crashCrashPoint) * CRASH_GROWTH_T;
    crashUpdateDisplay(crashCurrentMult, finalElapsed);
    crashHandleBust();
    return;
  }
  crashCurrentMult = mult;
  crashUpdateDisplay(mult, elapsed);
}
async function crashCashOut(){
  if(!crashRunning || crashCashedOut) return;
  crashCashedOut = true;
  crashRunning = false;
  clearInterval(crashIntervalHandle);
  clearInterval(crashSparkIntervalHandle);
  const rocketEl = document.getElementById('crashRocket');
  const numEl = document.getElementById('crashMultiplierVal');
  if(rocketEl) rocketEl.classList.remove('crash-flying');
  if(numEl) numEl.classList.remove('crash-flying');
  const payout = Math.round(crashBetAmount * crashCurrentMult);
  await crashResolve(payout, crashCurrentMult, true);
}
async function crashHandleBust(){
  crashRunning = false;
  clearInterval(crashIntervalHandle);
  clearInterval(crashSparkIntervalHandle);
  const rocketEl = document.getElementById('crashRocket');
  const numEl = document.getElementById('crashMultiplierVal');
  const lineEl = document.getElementById('crashGraphLine');
  if(numEl){ numEl.classList.remove('crash-flying'); numEl.classList.add('crash-busted'); }
  if(lineEl){ lineEl.classList.remove('crash-line-mid', 'crash-line-hot'); lineEl.classList.add('crash-line-busted'); }
  crashExplode();
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

  // Reset the rocket/graph to a fresh idle state a moment after the
  // explosion/settle has actually had time to play, rather than snapping
  // instantly and cutting the animation off.
  setTimeout(() => {
    const rocketEl = document.getElementById('crashRocket');
    const lineEl = document.getElementById('crashGraphLine');
    const numEl = document.getElementById('crashMultiplierVal');
    const box = document.getElementById('crashGraphBox');
    const cashBtn = document.getElementById('crashCashOutTopBtn');
    if(rocketEl){ rocketEl.classList.remove('crash-busted'); rocketEl.style.opacity = '1'; rocketEl.style.left = '0%'; rocketEl.style.bottom = '0%'; }
    if(lineEl){ lineEl.classList.remove('crash-line-busted', 'crash-line-mid', 'crash-line-hot'); lineEl.setAttribute('points', ''); }
    if(numEl) numEl.classList.remove('crash-busted', 'crash-mid', 'crash-hot');
    if(box) box.classList.remove('crash-danger-1', 'crash-danger-2');
    if(cashBtn) cashBtn.classList.remove('crash-cashout-warm', 'crash-cashout-hot');
    crashPathPoints = [];
  }, won ? 200 : 550);
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
