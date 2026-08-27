// ================= Double or Nothing =================
// Call Heads or Tails. Guess right and the pot doubles — bank it, or
// risk the lot again for another double. No cap on how far a streak can
// run; the probability of getting there decays fast enough on its own
// (0.485^n) that an artificial cap isn't needed the way Slots' Gamble
// feature (a bonus layered onto an already-resolved win) uses one.
//
// The "coin" isn't a genuinely fair 50/50 — the win/loss roll happens
// first (DON_WIN_PROBABILITY), and the displayed face is derived from
// that, not the other way round. A truly fair coin at an exact 2x payout
// is a zero-house-edge game by definition, which would be the only game
// in this casino with no edge at all; 48.5% keeps it in line with the
// real, stated RTP every other game here has (2 × 0.485 = 97%).
const DON_WIN_PROBABILITY = 0.485; // ~97% RTP per flip
const DON_LADDER_RUNGS = 6; // how many upcoming doubles to show at once
let donRoundActive = false;
let donFlipping = false;
let donPot = 0;
let donBetAmount = 0;
let donStreak = 0;
let donHistory = [];

const DON_CROUPIER_LINES = {
  win: ['Called it.', 'Good read.'],
  lose: ['Wrong side — gone.', 'Not this time.'],
  bank: ['Smart to bank that.']
};

function donSetUiState(active){
  const stakeRow = document.getElementById('donStakeRow');
  const bankRow = document.getElementById('donBankRow');
  if(stakeRow) stakeRow.style.display = active ? 'none' : 'block';
  if(bankRow) bankRow.style.display = active ? 'flex' : 'none';
}
function donRenderHistory(){
  const histEl = document.getElementById('donHistory');
  if(!histEl) return;
  histEl.innerHTML = donHistory.slice(-10).reverse().map(h =>
    `<div class="craps-history-chip" style="background:${h.won ? 'var(--win)' : 'var(--loss)'};">${h.won ? '+' + h.streak : '✕'}</div>`
  ).join('');
}
// Ladder shows DON_LADDER_RUNGS doubles centred around wherever the
// streak currently is, not always starting from 2x — past the first
// couple of rungs a fixed 2/4/8/16/32/64 list stops meaning anything
// once you're 8 flips deep, so the window slides to stay relevant.
function donRenderLadder(){
  const el = document.getElementById('donLadder');
  if(!el) return;
  const startRung = Math.max(1, donStreak - 1);
  let html = '';
  for(let i = 0; i < DON_LADDER_RUNGS; i++){
    const rung = startRung + i;
    const mult = Math.pow(2, rung);
    const cls = rung < donStreak ? 'done' : (rung === donStreak ? 'current' : '');
    html += `<span class="don-ladder-rung ${cls}">${mult >= 1000 ? (mult/1000) + 'k' : mult}x</span>`;
  }
  el.innerHTML = html;
}
function donUpdateHeatGlow(){
  const el = document.getElementById('donHeatGlow');
  if(!el) return;
  el.classList.remove('don-heat-1', 'don-heat-2', 'don-heat-3', 'don-heat-4');
  if(donStreak >= 6) el.classList.add('don-heat-4');
  else if(donStreak >= 4) el.classList.add('don-heat-3');
  else if(donStreak >= 2) el.classList.add('don-heat-2');
  else if(donStreak >= 1) el.classList.add('don-heat-1');
}
function donResetToIdle(){
  donRoundActive = false;
  donPot = 0;
  donStreak = 0;
  document.getElementById('donPotVal').textContent = '—';
  document.getElementById('donStreakVal').textContent = '0';
  document.getElementById('donLadder').innerHTML = '';
  donUpdateHeatGlow();
  donSetUiState(false);
}
function donSetButtonsDisabled(disabled){
  document.getElementById('donHeadsBtn').disabled = disabled;
  document.getElementById('donTailsBtn').disabled = disabled;
  const bankBtn = document.getElementById('donBankBtn');
  if(bankBtn) bankBtn.disabled = disabled;
}
// Swaps the coin's visible face between the "?" idle placeholder and the
// two real face images — one spot to change if either image ever needs
// swapping out, rather than scattering textContent/display toggles
// through every call site.
function donShowFace(result){
  const qEl = document.getElementById('donCoinFace');
  const headsImg = document.getElementById('donCoinHeadsImg');
  const tailsImg = document.getElementById('donCoinTailsImg');
  if(qEl) qEl.style.display = result ? 'none' : '';
  if(headsImg) headsImg.style.display = result === 'heads' ? 'block' : 'none';
  if(tailsImg) tailsImg.style.display = result === 'tails' ? 'block' : 'none';
}

async function donFlip(choice){
  if(donFlipping) return;
  // Guard flag AND button-disable both happen synchronously, before any
  // await — the previous version only set these after the balance check
  // resolved, leaving a real window where a fast double-tap on Heads/
  // Tails could slip a second flip in before the first one's guard ever
  // went up. That's exactly what was causing two overlapping flips to
  // run at once. Validation failures now unwind this (re-enable, clear
  // the flag) before returning, instead of never having set it at all.
  donFlipping = true;
  donSetButtonsDisabled(true);
  const errEl = document.getElementById('donBetError');
  errEl.textContent = '';

  if(!donRoundActive){
    const bet = parseInt(document.getElementById('donBetInput').value, 10) || 0;
    if(!bet || bet < 5){
      errEl.textContent = 'Minimum bet is 5 XP.';
      donFlipping = false; donSetButtonsDisabled(false);
      return;
    }
    const balance = await getXPBalance();
    if(balance == null){
      errEl.textContent = 'Could not check your XP balance — try again.';
      donFlipping = false; donSetButtonsDisabled(false);
      return;
    }
    if(bet > balance){
      errEl.textContent = `You only have ${balance} XP.`;
      donFlipping = false; donSetButtonsDisabled(false);
      return;
    }
    donBetAmount = bet;
    donPot = bet;
    scrollIntoViewSmooth('donTableRail');
  }

  document.getElementById('donResultMsg').textContent = '';

  const coinEl = document.getElementById('donCoin');
  donShowFace(null); // back to "?" for the tumble itself
  coinEl.classList.remove('don-flipping', 'don-settle', 'don-busted');
  void coinEl.offsetWidth;
  coinEl.classList.add('don-flipping');
  bjPlayChipSound();
  bjPlaySpinSound();

  const won = Math.random() < DON_WIN_PROBABILITY;
  const shownResult = won ? choice : (choice === 'heads' ? 'tails' : 'heads');

  await bjWait(1500); // matches the coin-tumble CSS animation duration

  coinEl.classList.remove('don-flipping');
  donShowFace(shownResult);
  coinEl.classList.add('don-settle');
  donFlipping = false;
  donSetButtonsDisabled(false);

  const resultEl = document.getElementById('donResultMsg');
  const resultLabel = shownResult === 'heads' ? 'Heads' : 'Tails';
  const railEl = document.getElementById('donTableRail');

  if(won){
    donPot *= 2;
    donStreak++;
    donRoundActive = true;
    document.getElementById('donPotVal').textContent = donPot.toLocaleString() + ' XP';
    document.getElementById('donStreakVal').textContent = donStreak;
    donRenderLadder();
    donUpdateHeatGlow();
    resultEl.textContent = `${resultLabel} — pot's now ${donPot.toLocaleString()} XP`;
    resultEl.style.color = 'var(--win)';
    resultEl.classList.remove('bj-outcome-pop'); void resultEl.offsetWidth; resultEl.classList.add('bj-outcome-pop');
    croupierSay('donCroupierMsg', DON_CROUPIER_LINES.win);
    bjPlayChime(true);
    if(donStreak >= 3) bjLaunchConfetti(resultEl, Math.min(10 + donStreak * 4, 40));
    railEl.classList.remove('pc-flash-gold'); void railEl.offsetWidth; railEl.classList.add('pc-flash-gold');
    setTimeout(() => railEl.classList.remove('pc-flash-gold'), 800);
    donSetUiState(true);
  } else {
    resultEl.textContent = `${resultLabel} — lost the lot (-${donBetAmount} XP)`;
    resultEl.style.color = 'var(--loss)';
    resultEl.classList.remove('bj-outcome-pop'); void resultEl.offsetWidth; resultEl.classList.add('bj-outcome-pop');
    croupierSay('donCroupierMsg', DON_CROUPIER_LINES.lose);
    bjPlayChime(false);
    railEl.classList.add('pc-shake');
    setTimeout(() => railEl.classList.remove('pc-shake'), 700);
    setTimeout(() => {
      coinEl.classList.remove('don-settle');
      coinEl.classList.add('don-busted');
    }, 250);

    donHistory.push({ won: false, streak: donStreak });
    donRenderHistory();

    await awardXP(-donBetAmount, 'Double or Nothing loss', { silent: true });
    const bal = await getXPBalance();
    updateXPBalanceDisplay(bal);
    renderXPLog();

    donResetToIdle();
    // Coin resets to idle (fresh appearance) once the tumble-away has had
    // a moment to actually play, rather than snapping back mid-animation.
    setTimeout(() => {
      coinEl.classList.remove('don-busted');
      donShowFace(null);
    }, 750);
  }
}
async function donBank(){
  if(!donRoundActive || donFlipping) return;
  donSetButtonsDisabled(true);
  const delta = donPot - donBetAmount;
  const resultEl = document.getElementById('donResultMsg');
  resultEl.textContent = `Banked ${donPot.toLocaleString()} XP — +${delta} XP`;
  resultEl.style.color = 'var(--win)';
  resultEl.classList.remove('bj-outcome-pop'); void resultEl.offsetWidth; resultEl.classList.add('bj-outcome-pop');
  croupierSay('donCroupierMsg', DON_CROUPIER_LINES.bank);
  bjPlayChime(true);
  bjLaunchConfetti(resultEl, Math.min(20 + donStreak * 4, 46));
  const railEl = document.getElementById('donTableRail');
  railEl.classList.remove('pc-flash-gold'); void railEl.offsetWidth; railEl.classList.add('pc-flash-gold');
  setTimeout(() => railEl.classList.remove('pc-flash-gold'), 800);

  donHistory.push({ won: true, streak: donStreak });
  donRenderHistory();

  await awardXP(delta, 'Double or Nothing win', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();

  donResetToIdle();
  donSetButtonsDisabled(false);
  donShowFace(null);
}
document.getElementById('donHeadsBtn').addEventListener('click', () => donFlip('heads'));
document.getElementById('donTailsBtn').addEventListener('click', () => donFlip('tails'));
document.getElementById('donBankBtn').addEventListener('click', donBank);
document.getElementById('donBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('donChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
});
document.getElementById('donChipDisplay').addEventListener('click', () => {
  if(donRoundActive || donFlipping) return;
  const input = document.getElementById('donBetInput');
  const entry = prompt('Bet amount (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
});
// ================= /Double or Nothing =================
