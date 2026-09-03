// ================= Plinko =================
// 12 rows, 13 slots. Whole-number payouts, symmetric around a 0x centre —
// the three middle slots (~61% combined chance) pay nothing, then 1x, 2x,
// 7x, 35x, and 180x moving outward to the two rare edges. Verified to a
// real 97.51% RTP by summing the actual binomial probability of every
// slot against its payout before ever shipping this.
const PLINKO_ROWS = 12;
const PLINKO_SLOTS = PLINKO_ROWS + 1; // 13
const PLINKO_MULTIPLIERS = [180, 35, 7, 2, 1, 0, 0, 0, 1, 2, 7, 35, 180];
function plinkoSlotTier(i){
  const distFromCenter = Math.abs(i - PLINKO_ROWS / 2);
  if(distFromCenter >= 6) return 'tier-edge';       // 180x
  if(distFromCenter >= 5) return 'tier-high';        // 35x
  if(distFromCenter >= 4) return 'tier-upper-mid';   // 7x
  if(distFromCenter >= 3) return 'tier-mid';         // 2x
  if(distFromCenter >= 2) return 'tier-low-mid';     // 1x
  return 'tier-low';                                 // 0x
}
let plinkoBuilt = false;
let plinkoDropping = false;
let plinkoBallCount = 1;
let plinkoLastBet = null; // snapshot of the last drop's bet amount + ball count, for the Same Bet button
let plinkoHistory = [];

function plinkoInit(){
  plinkoBuilt = true;
  const pegsEl = document.getElementById('plinkoPegs');
  let pegsHtml = '';
  for(let row = 0; row < PLINKO_ROWS; row++){
    pegsHtml += '<div class="plinko-peg-row">' + '<div class="plinko-peg"></div>'.repeat(row + 2) + '</div>';
  }
  pegsEl.innerHTML = pegsHtml;
  document.getElementById('plinkoSlots').innerHTML = PLINKO_MULTIPLIERS.map((m, i) =>
    `<div class="plinko-slot ${plinkoSlotTier(i)}" data-slot="${i}"><span>${m}x</span></div>`
  ).join('');
  plinkoUpdateStakeHint();
}
function plinkoUpdateStakeHint(){
  const bet = parseInt(document.getElementById('plinkoBetInput').value, 10) || 0;
  const hint = document.getElementById('plinkoTotalStakeHint');
  if(hint) hint.textContent = `Total stake: ${(bet * plinkoBallCount).toLocaleString()} XP${plinkoBallCount > 1 ? ` (${bet} XP × ${plinkoBallCount} balls)` : ''}`;
  const label = plinkoBallCount === 1 ? 'Drop Ball' : `Drop ${plinkoBallCount} Balls`;
  const btn = document.getElementById('plinkoDropBtn');
  const btnTop = document.getElementById('plinkoDropTopBtn');
  if(btn && !plinkoDropping) btn.textContent = label;
  if(btnTop && !plinkoDropping) btnTop.textContent = label;
}
document.querySelectorAll('#plinkoBallCountRow .craps-winmode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if(plinkoDropping) return;
    plinkoBallCount = parseInt(btn.dataset.balls, 10);
    document.querySelectorAll('#plinkoBallCountRow .craps-winmode-btn').forEach(b => b.classList.toggle('active', b === btn));
    plinkoUpdateStakeHint();
  });
});
document.getElementById('plinkoBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('plinkoChipDisplay');
  if(chip){
    chip.textContent = e.target.value || '0';
    chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
  }
  plinkoUpdateStakeHint();
});
document.getElementById('plinkoChipDisplay').addEventListener('click', () => {
  if(plinkoDropping) return;
  const input = document.getElementById('plinkoBetInput');
  const entry = prompt('Bet amount per ball (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
});

const PLINKO_CROUPIER_LINES = {
  drop: ['Ball is live.', 'Here we go.', 'Watch it fall.'],
  edge: ['Right on the edge! Huge payout.', "That's the rarest drop on the board."],
  loss: ['Landed in the middle — house wins this one.', 'Not this time.']
};

// One ball's full journey — its own random walk, its own DOM element, its
// own independent animation loop. startDelayMs lets multiple balls be
// kicked off with a slight stagger (see plinkoDropInner) so a 5- or
// 10-ball drop visually cascades down the board rather than every ball
// perfectly overlapping on an identical clock. Returns the landed slot
// index once this ball has settled.
async function plinkoAnimateOneBall(startDelayMs){
  if(startDelayMs > 0) await bjWait(startDelayMs);

  // The random walk that decides BOTH the visual path and the real
  // outcome — starting at slot-space x=6 (dead centre of 13), each of the
  // 12 rows nudges it ±0.5. After 12 steps x always lands exactly on an
  // integer 0-12, which is the actual slot index — no separate "pick a
  // result then animate toward it" step; the animation IS the result.
  let x = (PLINKO_SLOTS - 1) / 2;
  const path = [x];
  for(let i = 0; i < PLINKO_ROWS; i++){
    x += (Math.random() < 0.5) ? -0.5 : 0.5;
    path.push(x);
  }
  const finalSlot = Math.round(path[path.length - 1]);
  const targetSlotEl = document.querySelector(`#plinkoSlots .plinko-slot[data-slot="${finalSlot}"]`);

  const ball = document.createElement('div');
  ball.className = 'plinko-ball';
  document.getElementById('plinkoBoardWrap').appendChild(ball);
  ball.style.transition = 'none';
  ball.style.left = `${(path[0] / (PLINKO_SLOTS - 1)) * 100}%`;
  ball.style.top = '0%';
  ball.style.display = 'block';
  void ball.offsetWidth;
  ball.style.transition = '';

  for(let i = 1; i < path.length; i++){
    const leftPct = (path[i] / (PLINKO_SLOTS - 1)) * 100;
    const topPct = (i / PLINKO_ROWS) * 81; // stops just above the slot row, not on top of it
    ball.style.left = `${leftPct}%`;
    ball.style.top = `${topPct}%`;
    // Squash-and-recover pulse plus a real peg-tick sound on every row —
    // this, together with the overshoot easing on the CSS transition
    // itself, is what actually reads as bouncing off each peg rather
    // than gliding smoothly between fixed points.
    ball.classList.remove('bounce-hit'); void ball.offsetWidth; ball.classList.add('bounce-hit');
    dailySpinPlayPegTick();
    await bjWait(190);
  }
  // Final settle: reparent the ball directly INTO its landed slot, and
  // let simple 50%/50% centering (relative to the slot itself) place it.
  // The previous approach computed the slot's centre from OUTSIDE it via
  // getBoundingClientRect on two separate elements — mathematically
  // sound, but it still wasn't landing dead centre in practice. Having
  // the slot centre the ball within its own box removes that cross-
  // element calculation entirely; the browser's layout engine does the
  // centring natively, the same reliable way it centres content inside
  // any other box in this app, instead of a coordinate calculation that
  // has to account for every bit of padding/gap perfectly.
  ball.style.transition = 'none';
  targetSlotEl.appendChild(ball);
  ball.style.position = 'absolute';
  ball.style.left = '50%';
  ball.style.top = '50%';
  ball.style.margin = '-8px 0 0 -8px'; // half the ball's own 16px size
  void ball.offsetWidth;
  await bjWait(160);
  return finalSlot;
}

async function plinkoDrop(){
  if(plinkoDropping) return;
  plinkoDropping = true;
  const btn = document.getElementById('plinkoDropBtn');
  const btnTop = document.getElementById('plinkoDropTopBtn');
  btn.disabled = true;
  if(btnTop) btnTop.disabled = true;
  try{
    await plinkoDropInner();
  } finally {
    btn.disabled = false;
    if(btnTop) btnTop.disabled = false;
    plinkoDropping = false;
    plinkoUpdateStakeHint(); // restores each button's own label (Drop Ball / Drop N Balls) once re-enabled
  }
}
async function plinkoDropInner(){
  const errEl = document.getElementById('plinkoBetError');
  errEl.textContent = '';
  const betPerBall = parseInt(document.getElementById('plinkoBetInput').value, 10) || 0;
  if(!betPerBall || betPerBall < 5){ errEl.textContent = 'Minimum bet is 5 XP.'; return; }
  const totalStake = betPerBall * plinkoBallCount;
  if(totalStake > CASINO_MAX_BET_PER_HAND){ errEl.textContent = `Maximum total stake per drop is ${CASINO_MAX_BET_PER_HAND.toLocaleString()} XP (${betPerBall.toLocaleString()} × ${plinkoBallCount} balls = ${totalStake.toLocaleString()}).`; return; }
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(totalStake > balance){ errEl.textContent = `You only have ${balance} XP (stake: ${totalStake}).`; return; }

  scrollIntoViewSmooth('plinkoTableRail');
  bjPlayChipSound();
  bjPlaySpinSound();
  croupierSay('plinkoCroupierMsg', PLINKO_CROUPIER_LINES.drop);
  document.getElementById('plinkoResultMsg').textContent = '';
  document.querySelectorAll('#plinkoSlots .plinko-slot').forEach(s => s.classList.remove('landed'));
  document.querySelectorAll('#plinkoBoardWrap .plinko-ball').forEach(b => b.remove());

  // Every ball runs its own independent animation concurrently, staggered
  // by 500ms each so a multi-ball drop reads as a clear sequence of
  // individual drops rather than everything happening in one hit.
  const drops = [];
  for(let n = 0; n < plinkoBallCount; n++){
    drops.push(plinkoAnimateOneBall(n * 500));
  }
  const finalSlots = await Promise.all(drops);

  let totalPayout = 0;
  const landedSlotCounts = {};
  finalSlots.forEach(finalSlot => {
    const mult = PLINKO_MULTIPLIERS[finalSlot];
    totalPayout += Math.round(betPerBall * mult);
    landedSlotCounts[finalSlot] = (landedSlotCounts[finalSlot] || 0) + 1;
    plinkoHistory.push(mult);
  });
  const delta = totalPayout - totalStake;
  plinkoLastBet = { amount: betPerBall, ballCount: plinkoBallCount };
  document.getElementById('plinkoSameBetBtn').disabled = false;
  const sameBetTopBtn = document.getElementById('plinkoSameBetTopBtn');
  if(sameBetTopBtn) sameBetTopBtn.disabled = false;

  Object.keys(landedSlotCounts).forEach(slotIdx => {
    const slotEl = document.querySelector(`#plinkoSlots .plinko-slot[data-slot="${slotIdx}"]`);
    if(slotEl){ slotEl.classList.remove('landed'); void slotEl.offsetWidth; slotEl.classList.add('landed'); }
  });

  const resultEl = document.getElementById('plinkoResultMsg');
  resultEl.textContent = plinkoBallCount === 1
    ? `Landed at ${PLINKO_MULTIPLIERS[finalSlots[0]]}x  —  ${delta >= 0 ? '+' : ''}${delta} XP`
    : `${plinkoBallCount} balls dropped  —  ${delta >= 0 ? '+' : ''}${delta} XP`;
  // A push (net delta 0) is neither a win nor a loss — gets its own
  // neutral colour and skips the "house wins" line, rather than being
  // folded into loss red/messaging the way a non-positive check alone
  // would do.
  resultEl.style.color = delta > 0 ? 'var(--win)' : (delta < 0 ? 'var(--loss)' : 'var(--muted)');
  resultEl.classList.remove('bj-outcome-pop'); void resultEl.offsetWidth; resultEl.classList.add('bj-outcome-pop');

  const anyEdge = finalSlots.some(s => s === 0 || s === PLINKO_SLOTS - 1);
  if(anyEdge) croupierSay('plinkoCroupierMsg', PLINKO_CROUPIER_LINES.edge);
  else if(delta < 0) croupierSay('plinkoCroupierMsg', PLINKO_CROUPIER_LINES.loss);

  const histEl = document.getElementById('plinkoHistory');
  if(histEl){
    histEl.innerHTML = plinkoHistory.slice(-10).reverse().map(m => {
      // With whole-number payouts, 1x is an exact push — its own neutral
      // colour instead of being lumped in with genuine wins.
      const bg = m > 1 ? 'var(--win)' : (m === 1 ? 'var(--muted)' : 'var(--loss)');
      return `<div class="craps-history-chip" style="background:${bg};">${m}x</div>`;
    }).join('');
  }

  const railEl = document.getElementById('plinkoTableRail');
  if(delta > 0){
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, anyEdge ? 44 : 20);
    railEl.classList.remove('pc-flash-gold'); void railEl.offsetWidth; railEl.classList.add('pc-flash-gold');
    setTimeout(() => railEl.classList.remove('pc-flash-gold'), 800);
  } else if(delta < 0){
    bjPlayChime(false);
    railEl.classList.add('pc-shake');
    setTimeout(() => railEl.classList.remove('pc-shake'), 700);
  }

  if(delta !== 0) await awardXP(delta, delta > 0 ? 'Plinko win' : 'Plinko loss', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
}
document.getElementById('plinkoDropBtn').addEventListener('click', plinkoDrop);
document.getElementById('plinkoDropTopBtn').addEventListener('click', plinkoDrop);
// Restores both the bet-per-ball amount and the ball count from the last
// completed drop — real-clicks the correct ball-count pill so its active
// styling and the stake hint both stay in sync, same as every other
// repeat-bet button in the casino.
function plinkoApplySameBet(){
  if(!plinkoLastBet || plinkoDropping) return;
  const targetBtn = document.querySelector(`#plinkoBallCountRow .craps-winmode-btn[data-balls="${plinkoLastBet.ballCount}"]`);
  if(targetBtn) targetBtn.click();
  const betInput = document.getElementById('plinkoBetInput');
  betInput.value = plinkoLastBet.amount;
  betInput.dispatchEvent(new Event('input'));
  bjPlayChipSound();
}
document.getElementById('plinkoSameBetBtn').addEventListener('click', plinkoApplySameBet);
document.getElementById('plinkoSameBetTopBtn').addEventListener('click', plinkoApplySameBet);
// ================= /Plinko =================
