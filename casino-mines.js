// ================= Mines =================
// The one genuinely different game in the casino — every other table is
// a single bet-and-reveal; this is the only one where the player decides
// mid-round how far to push their luck. 5x5 grid, pick a mine count,
// reveal safe tiles for a growing multiplier, cash out whenever — or
// keep going and risk it all. True combinatorial odds (see
// minesFairMultiplier), with the same house edge discipline as every
// other game: a real, verified RTP, not a made-up number.
const MINES_GRID_SIZE = 25;
const MINES_RTP = 0.97; // 3% house edge — genuinely in line with how real Mines games are priced, lower than the wheel/dice games since the player carries more of the decision-making here
function minesFairMultiplier(total, mineCount, revealed){
  let mult = 1;
  for(let i = 0; i < revealed; i++){ mult *= (total - i) / (total - mineCount - i); }
  return mult;
}
let minesBuilt = false;
let minesActionInFlight = false; // guards Start/Cash Out double-taps, same class of bug fixed everywhere else
let minesRoundActive = false;
let minesCount = 3;
let minesLastBet = null; // snapshot of the last round's bet amount + mine count, for the Same Bet button
let minesBoard = [];
let minesRevealedCount = 0;
let minesBetAmount = 0;
let minesHistory = [];

// Both Cash Out buttons (the one up top on the felt, and the one down in
// the bet panel) always show/hide together — one helper so every call
// site only has to remember there's a button, not that there are two.
function minesSetCashOutVisible(visible){
  const display = visible ? 'inline-block' : 'none';
  const topBtn = document.getElementById('minesCashOutTopBtn');
  const bottomBtn = document.getElementById('minesCashOutBtn');
  if(topBtn) topBtn.style.display = visible ? 'block' : 'none';
  if(bottomBtn) bottomBtn.style.display = display;
}
function minesInit(){
  minesBuilt = true;
  const grid = document.getElementById('minesGrid');
  grid.innerHTML = '';
  for(let i = 0; i < MINES_GRID_SIZE; i++){
    const tile = document.createElement('div');
    tile.className = 'mines-tile disabled';
    tile.dataset.idx = i;
    tile.addEventListener('click', () => minesTapTile(i));
    grid.appendChild(tile);
  }
}
document.querySelectorAll('#minesMineCountRow .craps-winmode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if(minesRoundActive) return; // locked in for the round once Started
    minesCount = parseInt(btn.dataset.mines, 10);
    document.querySelectorAll('#minesMineCountRow .craps-winmode-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});
document.getElementById('minesBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('minesChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
});
document.getElementById('minesChipDisplay').addEventListener('click', () => {
  if(minesRoundActive) return;
  const input = document.getElementById('minesBetInput');
  const entry = prompt('Bet amount (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
});

const MINES_CROUPIER_LINES = {
  start: ['Mines are live — good luck.', 'Board is set.'],
  cashout: ['Cashed out — smart move.', 'Locking that in.'],
  cleared: ['Every safe tile found — full clear!'],
  bust: ['Boom — house wins this one.', 'Unlucky tile.']
};

async function minesStart(){
  if(minesActionInFlight) return;
  minesActionInFlight = true;
  const startBtn = document.getElementById('minesStartBtn');
  startBtn.disabled = true;
  try{
    await minesStartInner();
  } finally {
    startBtn.disabled = false;
    minesActionInFlight = false;
  }
}
async function minesStartInner(){
  const errEl = document.getElementById('minesBetError');
  errEl.textContent = '';
  const bet = parseInt(document.getElementById('minesBetInput').value, 10) || 0;
  if(!bet || bet < 5){ errEl.textContent = 'Minimum bet is 5 XP.'; return; }
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(bet > balance){ errEl.textContent = `You only have ${balance} XP.`; return; }

  scrollIntoViewSmooth('minesTableRail');
  minesBetAmount = bet;
  minesRevealedCount = 0;
  minesRoundActive = true;

  const positions = Array.from({ length: MINES_GRID_SIZE }, (_, i) => i);
  for(let i = positions.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const mineSet = new Set(positions.slice(0, minesCount));
  minesBoard = Array.from({ length: MINES_GRID_SIZE }, (_, i) => mineSet.has(i));

  document.querySelectorAll('#minesGrid .mines-tile').forEach(tile => {
    tile.className = 'mines-tile';
    tile.innerHTML = '';
  });
  document.getElementById('minesMultVal').textContent = '1.00x';
  document.getElementById('minesPayoutVal').textContent = `${bet.toLocaleString()} XP`;
  document.getElementById('minesResultMsg').textContent = '';
  document.getElementById('minesStartBtn').style.display = 'none';
  minesSetCashOutVisible(false);
  document.getElementById('minesNewGameBtn').style.display = 'none';
  document.getElementById('minesHint').textContent = 'Tap a tile to reveal it — cash out anytime after your first safe gem.';
  croupierSay('minesCroupierMsg', MINES_CROUPIER_LINES.start);
  bjPlayChipSound();
}

async function minesTapTile(idx){
  if(!minesRoundActive || minesActionInFlight) return;
  const tile = document.querySelector(`#minesGrid .mines-tile[data-idx="${idx}"]`);
  if(!tile || tile.classList.contains('revealed')) return;

  if(minesBoard[idx]){
    minesActionInFlight = true;
    minesRoundActive = false;
    tile.classList.add('revealed', 'mine');
    tile.innerHTML = '💣';
    bjPlayChime(false);
    croupierSay('minesCroupierMsg', MINES_CROUPIER_LINES.bust);
    const railEl = document.getElementById('minesTableRail');
    railEl.classList.add('pc-shake');
    setTimeout(() => railEl.classList.remove('pc-shake'), 700);
    minesBoard.forEach((isMine, i) => {
      if(isMine && i !== idx){
        const t = document.querySelector(`#minesGrid .mines-tile[data-idx="${i}"]`);
        if(t){ t.classList.add('revealed', 'mine-dimmed'); t.innerHTML = '💣'; }
      }
    });
    document.querySelectorAll('#minesGrid .mines-tile:not(.revealed)').forEach(t => t.classList.add('disabled'));
    try{ await minesResolve(0); } finally { minesActionInFlight = false; }
    return;
  }

  minesRevealedCount++;
  tile.classList.add('revealed', 'safe');
  tile.innerHTML = '💎';
  bjPlayChipSound();
  const payoutMult = minesFairMultiplier(MINES_GRID_SIZE, minesCount, minesRevealedCount) * MINES_RTP;
  const payout = Math.round(minesBetAmount * payoutMult);
  document.getElementById('minesMultVal').textContent = payoutMult.toFixed(2) + 'x';
  document.getElementById('minesPayoutVal').textContent = payout.toLocaleString() + ' XP';
  minesSetCashOutVisible(true);

  if(minesRevealedCount === MINES_GRID_SIZE - minesCount){
    croupierSay('minesCroupierMsg', MINES_CROUPIER_LINES.cleared);
    await minesCashOut();
  }
}

async function minesCashOut(){
  if(minesActionInFlight || !minesRoundActive) return;
  minesActionInFlight = true;
  const cashBtn = document.getElementById('minesCashOutBtn');
  const cashBtnTop = document.getElementById('minesCashOutTopBtn');
  cashBtn.disabled = true;
  if(cashBtnTop) cashBtnTop.disabled = true;
  try{
    minesRoundActive = false;
    const payoutMult = minesFairMultiplier(MINES_GRID_SIZE, minesCount, minesRevealedCount) * MINES_RTP;
    const payout = Math.round(minesBetAmount * payoutMult);
    document.querySelectorAll('#minesGrid .mines-tile:not(.revealed)').forEach(t => t.classList.add('disabled'));
    croupierSay('minesCroupierMsg', MINES_CROUPIER_LINES.cashout);
    await minesResolve(payout);
  } finally {
    cashBtn.disabled = false;
    if(cashBtnTop) cashBtnTop.disabled = false;
    minesActionInFlight = false;
  }
}

async function minesResolve(payout){
  const delta = payout - minesBetAmount;
  const won = delta > 0;
  const resultEl = document.getElementById('minesResultMsg');
  resultEl.textContent = won
    ? `Cashed out at ${(payout / minesBetAmount).toFixed(2)}x — +${delta} XP`
    : `Hit a mine after ${minesRevealedCount} safe — -${minesBetAmount} XP`;
  resultEl.style.color = won ? 'var(--win)' : 'var(--loss)';
  resultEl.classList.remove('bj-outcome-pop'); void resultEl.offsetWidth; resultEl.classList.add('bj-outcome-pop');

  minesHistory.push({ won, revealed: minesRevealedCount });
  const histEl = document.getElementById('minesHistory');
  if(histEl){
    histEl.innerHTML = minesHistory.slice(-10).reverse().map(h => {
      return `<div class="craps-history-chip" style="background:${h.won ? 'var(--win)' : 'var(--loss)'};">${h.won ? h.revealed : '✕'}</div>`;
    }).join('');
  }

  if(won){
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, minesRevealedCount >= 10 ? 42 : 20);
    const railEl = document.getElementById('minesTableRail');
    railEl.classList.remove('pc-flash-gold'); void railEl.offsetWidth; railEl.classList.add('pc-flash-gold');
    setTimeout(() => railEl.classList.remove('pc-flash-gold'), 800);
  }

  minesSetCashOutVisible(false);
  document.getElementById('minesNewGameBtn').style.display = 'inline-block';
  document.getElementById('minesHint').textContent = 'Round over — press New Game to play again.';
  minesLastBet = { amount: minesBetAmount, count: minesCount };
  document.getElementById('minesSameBetBtn').disabled = false;

  if(delta !== 0) await awardXP(delta, delta > 0 ? 'Mines win' : 'Mines loss', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
}
document.getElementById('minesStartBtn').addEventListener('click', minesStart);
// Restores both the bet amount and mine count from the last completed
// round — real-clicks the correct mine-count pill so its active styling
// stays in sync, same as every other repeat-bet button in the casino.
document.getElementById('minesSameBetBtn').addEventListener('click', () => {
  if(!minesLastBet || minesRoundActive) return;
  const betInput = document.getElementById('minesBetInput');
  betInput.value = minesLastBet.amount;
  betInput.dispatchEvent(new Event('input'));
  const targetBtn = document.querySelector(`#minesMineCountRow .craps-winmode-btn[data-mines="${minesLastBet.count}"]`);
  if(targetBtn) targetBtn.click();
  bjPlayChipSound();
});
document.getElementById('minesCashOutBtn').addEventListener('click', minesCashOut);
document.getElementById('minesCashOutTopBtn').addEventListener('click', minesCashOut);
document.getElementById('minesNewGameBtn').addEventListener('click', () => {
  document.getElementById('minesStartBtn').style.display = 'inline-block';
  document.getElementById('minesNewGameBtn').style.display = 'none';
  document.getElementById('minesMultVal').textContent = '1.00x';
  document.getElementById('minesPayoutVal').textContent = '—';
  document.getElementById('minesResultMsg').textContent = '';
  document.getElementById('minesHint').textContent = 'Pick your bet and how many mines, then Start.';
  document.querySelectorAll('#minesGrid .mines-tile').forEach(tile => { tile.className = 'mines-tile disabled'; tile.innerHTML = ''; });
});
// ================= /Mines =================
