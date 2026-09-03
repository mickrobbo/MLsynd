// ================= Big Wheel =================
// A real Big Six money wheel — 54 segments at true casino odds (24x "1",
// 15x "2", 8x "5", 4x "10", 2x "20", 1x Joker), not the free daily-prize
// wheel Daily Spin already has. Reuses that exact wheel/spin mechanism
// (conic-gradient segments, a counter-rotating label layer, peg-tick
// audio) since it's already a solid, tested build — this is the same
// spinning-wheel physics wearing a betting-game ruleset instead of a
// once-every-2-days free spin.
// Dialled back from a "real" 54-segment Big Six wheel to 24 — the exact
// segment count Daily Spin already proved legible with real text labels
// at this size. 54 narrow wedges with nothing but colour-matched dots
// looked cluttered and gave no way to actually read the wheel; this
// version shows the real value on every wedge. Odds are recalculated for
// the new counts (see the note on BIG_WHEEL_PAYOUT below) rather than
// just scaling the old 54-wheel numbers down and hoping — every bet was
// re-verified to still be a genuine loser on average, same as real Big
// Six math, not just visually simplified.
// Shared chip-pill formatter — "1.2k" instead of "1200" once a staged
// amount gets big, used by every game with a chip-pill display (Craps,
// Big Wheel, Mines).
function casinoFmtChip(n){ return n >= 1000 ? (n % 1000 === 0 ? (n / 1000) + 'k' : (n / 1000).toFixed(1) + 'k') : String(n); }
const BIG_WHEEL_PAYOUT = { '1': 1, '2': 2, '5': 5, '10': 10, '20': 20, joker: 18 };
function buildBigWheelSegments(){
  // Round-robin interleave spreads same-value wedges around the wheel
  // rather than clumping them — order is purely cosmetic, every wedge is
  // equally likely regardless of where it sits.
  const queues = [['1', 11], ['2', 6], ['5', 3], ['10', 2], ['20', 1], ['joker', 1]].map(([val, count]) => ({ val, remaining: count }));
  const result = [];
  while(result.length < 24){
    for(const q of queues){
      if(q.remaining > 0 && result.length < 24){ result.push(q.val); q.remaining--; }
    }
  }
  return result;
}
const BIG_WHEEL_SEGMENTS = buildBigWheelSegments();
// Same colour identity carried through to the bet spots below (see
// bigWheelInit) so there's an actual visual link between "this wedge" and
// "this is the spot to tap for it" — the wheel and the betting grid used
// to share no colour language at all.
const BIG_WHEEL_COLORS = { '1': '#1a4a33', '2': '#7a2a20', '5': '#2a5a8a', '10': '#6a3a9a', '20': '#b8862e', joker: '#e0b23e' };
let bigWheelBuilt = false;
let bigWheelRotation = 0;
let bigWheelSpinning = false;
let bigWheelHistory = [];
let bigWheelStaged = { '1': 0, '2': 0, '5': 0, '10': 0, '20': 0, joker: 0 };
let bigWheelLastStaged = null; // snapshot of the last completed spin's bets, for the Same Bet button

function bigWheelBuildWheel(){
  bigWheelBuilt = true;
  const wheel = document.getElementById('bigWheelWheel');
  const labelsLayer = document.getElementById('bigWheelLabelsLayer');
  const n = BIG_WHEEL_SEGMENTS.length;
  const anglePer = 360 / n;
  const stops = BIG_WHEEL_SEGMENTS.map((val, i) => `${BIG_WHEEL_COLORS[val]} ${(i * anglePer).toFixed(3)}deg ${((i + 1) * anglePer).toFixed(3)}deg`);
  wheel.style.background = `conic-gradient(${stops.join(',')})`;
  // Real text on every wedge now that there's actual room for it — same
  // counter-rotation technique as Daily Spin, so labels stay upright and
  // horizontal throughout the spin instead of spinning with the wheel.
  let piecesHtml = '';
  BIG_WHEEL_SEGMENTS.forEach((val, i) => {
    const angle = i * anglePer + anglePer / 2;
    const isJoker = val === 'joker';
    const displayText = isJoker ? '🃏' : val;
    piecesHtml += `<div class="bigwheel-segment-label${isJoker ? ' joker-label' : ''}" data-base-angle="${angle}" data-radius="98" style="transform: rotate(${angle}deg) translateY(-98px) rotate(${-angle}deg);">${displayText}</div>`;
  });
  labelsLayer.innerHTML = piecesHtml;
  // Colour each bet spot to match its wheel wedge — the missing link
  // that made it impossible to tell at a glance which spot corresponded
  // to which colour on the wheel.
  document.querySelectorAll('#bigWheelBetGrid .casino-num-spot').forEach(spot => {
    const val = spot.dataset.wheelBet;
    spot.style.borderTopColor = BIG_WHEEL_COLORS[val];
    spot.style.borderTopWidth = '4px';
  });
}
function bigWheelSetSpotAmt(val, staged){
  const el = document.querySelector(`[data-wheel-amt="${val}"]`);
  const spot = document.querySelector(`[data-wheel-bet="${val}"]`);
  if(!el || !spot) return;
  el.innerHTML = staged > 0 ? `<span class="craps-chip-pill craps-chip-new" data-clear-key="${val}" title="Remove this bet">${casinoFmtChip(staged)} ✕</span>` : '';
  spot.classList.toggle('has-live', staged > 0);
}
function bigWheelRenderBetSpots(){
  Object.keys(bigWheelStaged).forEach(val => bigWheelSetSpotAmt(val, bigWheelStaged[val]));
}
document.querySelectorAll('#bigWheelBetGrid .casino-num-spot').forEach(spot => {
  spot.addEventListener('click', (e) => {
    const val = spot.dataset.wheelBet;
    const ghostPill = e.target.closest('.craps-chip-new');
    if(ghostPill){
      bigWheelStaged[val] = 0;
      bigWheelRenderBetSpots();
      bjPlayChipSound();
      return;
    }
    const chip = parseInt(document.getElementById('bigWheelBetInput').value, 10) || 0;
    if(chip <= 0) return;
    bigWheelStaged[val] += chip;
    bigWheelRenderBetSpots();
    bjPlayChipSound();
    spot.classList.remove('pc-chip-tap'); void spot.offsetWidth; spot.classList.add('pc-chip-tap');
  });
});
document.getElementById('bigWheelClearBtn').addEventListener('click', () => {
  bigWheelStaged = { '1': 0, '2': 0, '5': 0, '10': 0, '20': 0, joker: 0 };
  document.getElementById('bigWheelBetError').textContent = '';
  bigWheelRenderBetSpots();
  const railEl = document.getElementById('bigWheelTableRail');
  if(railEl){ railEl.classList.remove('pc-flash-gold'); void railEl.offsetWidth; railEl.classList.add('pc-flash-gold'); }
});
// Re-places every spot from the last completed spin exactly as it was —
// replaces whatever's currently staged rather than stacking on top, same
// pattern as Roulette's Same Bet button.
document.getElementById('bigWheelSameBetBtn').addEventListener('click', () => {
  if(!bigWheelLastStaged) return;
  bigWheelStaged = { ...bigWheelLastStaged };
  bigWheelRenderBetSpots();
  bjPlayChipSound();
});
document.getElementById('bigWheelBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('bigWheelChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
});
document.getElementById('bigWheelChipDisplay').addEventListener('click', () => {
  const input = document.getElementById('bigWheelBetInput');
  const entry = prompt('Bet amount (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
});

const BIGWHEEL_CROUPIER_LINES = {
  spin: ['No more bets — spinning.', 'Wheel is live.', 'Here we go.'],
  joker: ["It's the Joker! Big payout for the house to make.", "Joker! That's the rarest spot on the wheel."],
  loss: ['House wins this spin.', 'Not this time.']
};
async function bigWheelSpin(){
  if(bigWheelSpinning) return;
  bigWheelSpinning = true;
  const spinBtn = document.getElementById('bigWheelSpinBtn');
  const clearBtn = document.getElementById('bigWheelClearBtn');
  spinBtn.disabled = true; clearBtn.disabled = true;
  try{
    await bigWheelSpinInner();
  } finally {
    spinBtn.disabled = false; clearBtn.disabled = false;
    bigWheelSpinning = false;
  }
}
async function bigWheelSpinInner(){
  const errEl = document.getElementById('bigWheelBetError');
  errEl.textContent = '';
  const totalStaked = Object.values(bigWheelStaged).reduce((a, b) => a + b, 0);
  if(totalStaked === 0){ errEl.textContent = 'Place at least one bet first.'; return; }
  if(totalStaked > CASINO_MAX_BET_PER_HAND){ errEl.textContent = `Maximum bet per spin is ${CASINO_MAX_BET_PER_HAND.toLocaleString()} XP total across all placed bets (staked: ${totalStaked.toLocaleString()}).`; return; }
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(totalStaked > balance){ errEl.textContent = `You only have ${balance} XP (staked: ${totalStaked}).`; return; }

  scrollIntoViewSmooth('bigWheelTableRail');
  bjPlayChipSound();
  croupierSay('bigWheelCroupierMsg', BIGWHEEL_CROUPIER_LINES.spin);

  const winIndex = Math.floor(Math.random() * BIG_WHEEL_SEGMENTS.length);
  const winVal = BIG_WHEEL_SEGMENTS[winIndex];
  const anglePer = 360 / BIG_WHEEL_SEGMENTS.length;
  const targetAngle = winIndex * anglePer + anglePer / 2;
  const spins = 5 + Math.floor(Math.random() * 2);
  bigWheelRotation = bigWheelRotation - (bigWheelRotation % 360) + spins * 360 + (360 - targetAngle);
  const wheel = document.getElementById('bigWheelWheel');
  wheel.style.transform = `rotate(${bigWheelRotation}deg)`;
  document.querySelectorAll('#bigWheelLabelsLayer .bigwheel-segment-label').forEach(label => {
    const baseAngle = parseFloat(label.dataset.baseAngle);
    const radius = parseFloat(label.dataset.radius);
    const liveAngle = baseAngle + bigWheelRotation;
    label.style.transform = `rotate(${liveAngle}deg) translateY(-${radius}px) rotate(${-liveAngle}deg)`;
  });
  dailySpinSchedulePegTicks(6000, 70);
  bjPlaySpinSound();
  await bjWait(6200);
  wheel.classList.remove('pc-winner-flash'); void wheel.offsetWidth; wheel.classList.add('pc-winner-flash');

  let delta = 0;
  const wonSpots = [], lostSpots = [];
  Object.keys(bigWheelStaged).forEach(val => {
    const amt = bigWheelStaged[val]; if(!(amt > 0)) return;
    const label = val === 'joker' ? 'Joker' : val;
    if(val === winVal){ delta += amt * BIG_WHEEL_PAYOUT[val]; wonSpots.push(label); }
    else { delta -= amt; lostSpots.push(label); }
  });
  // Bets are consumed by the spin — snapshot them first so Same Bet can
  // re-place this exact spread next round, same pattern as Roulette.
  bigWheelLastStaged = { ...bigWheelStaged };
  document.getElementById('bigWheelSameBetBtn').disabled = Object.values(bigWheelLastStaged).every(v => v === 0);
  bigWheelStaged = { '1': 0, '2': 0, '5': 0, '10': 0, '20': 0, joker: 0 };
  bigWheelRenderBetSpots();

  const resultEl = document.getElementById('bigWheelResultMsg');
  const winLabel = winVal === 'joker' ? 'Joker 🃏' : winVal;
  let msg = `Landed on ${winLabel}`;
  if(wonSpots.length || lostSpots.length){
    msg += `  |  ${[...wonSpots.map(s => `${s} won`), ...lostSpots.map(s => `${s} lost`)].join(', ')}`;
  }
  resultEl.textContent = `${msg}  —  ${delta >= 0 ? '+' : ''}${delta} XP`;
  resultEl.style.color = delta > 0 ? 'var(--win)' : (delta < 0 ? 'var(--loss)' : 'var(--muted)');
  resultEl.classList.remove('bj-outcome-pop'); void resultEl.offsetWidth; resultEl.classList.add('bj-outcome-pop');

  if(winVal === 'joker') croupierSay('bigWheelCroupierMsg', BIGWHEEL_CROUPIER_LINES.joker);
  else if(delta < 0) croupierSay('bigWheelCroupierMsg', BIGWHEEL_CROUPIER_LINES.loss);

  bigWheelHistory.push(winVal);
  const histEl = document.getElementById('bigWheelHistory');
  if(histEl){
    histEl.innerHTML = bigWheelHistory.slice(-10).reverse().map(v => {
      return `<div class="craps-history-chip" style="background:${BIG_WHEEL_COLORS[v]};">${v === 'joker' ? '🃏' : v}</div>`;
    }).join('');
  }

  const railEl = document.getElementById('bigWheelTableRail');
  if(delta > 0){
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, winVal === 'joker' ? 50 : 22);
    if(railEl){ railEl.classList.remove('pc-flash-gold'); void railEl.offsetWidth; railEl.classList.add('pc-flash-gold'); setTimeout(() => railEl.classList.remove('pc-flash-gold'), 900); }
  } else if(delta < 0){
    bjPlayChime(false);
    if(railEl){ railEl.classList.add('pc-shake'); setTimeout(() => railEl.classList.remove('pc-shake'), 700); }
  }

  if(delta !== 0) await awardXP(delta, delta > 0 ? 'Big Wheel win' : 'Big Wheel loss', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
}
document.getElementById('bigWheelSpinBtn').addEventListener('click', bigWheelSpin);
// ================= /Big Wheel =================
