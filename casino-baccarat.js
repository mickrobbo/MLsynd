// ---- Baccarat ----
// Standard punto banco rules: card values A=1, 2-9=pip, 10/J/Q/K=0, hand
// total is the last digit of the sum. Player draws a third card on 0-5,
// stands on 6-7. Banker's third-card draw depends on both its own total
// and the player's third card (the standard baccarat drawing table below).
// Reuses the same generic card render/deal helpers built for Blackjack —
// bjRenderCards, bjPipHtml, bjFreshDeck, bjWait, bjPlayCardSound etc. were
// never actually Blackjack-specific under the hood.
let bacDeck = [];
let bacSelectedBet = 'player';
let bacLastBet = null; // snapshot of the last hand's bet type + amount, for the Same Bet button
let bacStep = 'start';
let bacPlayerHand = [], bacBankerHand = [];
let bacHistory = []; // 'P'/'B'/'T' per hand — the actual winner, regardless of what was bet on
let bacBetAmountLocked = 0, bacBetTypeLocked = '';
let bacPlayerDrew = false, bacPlayerThirdVal = null;

document.querySelectorAll('.bet-spot-btn[data-bac-bet]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.bet-spot-btn[data-bac-bet]').forEach(b => b.classList.toggle('active', b === btn));
    bacSelectedBet = btn.dataset.bacBet;
  });
});
function bacCardValue(c){ if(c.rank === 'A') return 1; if(['10','J','Q','K'].includes(c.rank)) return 0; return Number(c.rank); }
function bacHandTotal(hand){ return hand.reduce((s,c) => s + bacCardValue(c), 0) % 10; }
function bacBankerShouldDraw(bankerTotal, playerDrew, playerThirdVal){
  if(bankerTotal <= 2) return true;
  if(bankerTotal >= 7) return false;
  if(!playerDrew) return bankerTotal <= 5;
  switch(bankerTotal){
    case 3: return playerThirdVal !== 8;
    case 4: return playerThirdVal >= 2 && playerThirdVal <= 7;
    case 5: return playerThirdVal >= 4 && playerThirdVal <= 7;
    case 6: return playerThirdVal === 6 || playerThirdVal === 7;
  }
  return false;
}
function bacPulseChip(el, val){
  el.textContent = val;
  el.classList.remove('pc-chip-tap'); void el.offsetWidth; el.classList.add('pc-chip-tap');
}
// Cards reveal one at a time via the Hit button, in real baccarat's fixed
// order (Player1, Banker1, Player2, Banker2, then conditionally a Player
// third and/or Banker third) — the DRAWING RULES stay fully automatic and
// non-negotiable, exactly as real baccarat works (there's no player choice
// in when a third card is drawn). Hit only controls the pacing/reveal, not
// the outcome — makes the hand feel interactive without inventing a
// "strategy" baccarat doesn't actually have.
function bacAppendCard(containerEl, card){
  const isRed = card.suit === '♥' || card.suit === '♦';
  const el = document.createElement('div');
  el.className = `playing-card ${isRed ? 'pc-red' : 'pc-black'} pc-dealt`;
  el.innerHTML = bjPipHtml(card);
  containerEl.appendChild(el);
}
let bacDealing = false; // guards a fast double-tap on Deal — same class fixed for Craps/Blackjack/War/Slots/Daily Spin
async function bacDeal(){
  if(bacDealing) return;
  bacDealing = true;
  const dealBtn = document.getElementById('bacDealBtn');
  if(dealBtn) dealBtn.disabled = true;
  try{
    await bacDealInner();
  } finally {
    bacDealing = false;
    if(dealBtn) dealBtn.disabled = false;
  }
}
async function bacDealInner(){
  const betType = bacSelectedBet;
  const betInput = document.getElementById('bacBetInput');
  const errEl = document.getElementById('bacBetError');
  errEl.textContent = '';
  const bet = parseInt(betInput.value, 10);
  const balance = await getXPBalance();
  if(!bet || bet < 1){ errEl.textContent = 'Place a bet first.'; return; }
  if(bet > CASINO_MAX_BET_PER_HAND){ errEl.textContent = `Maximum bet per hand is ${CASINO_MAX_BET_PER_HAND.toLocaleString()} XP.`; return; }
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(bet > balance){ errEl.textContent = `You only have ${balance} XP.`; return; }

  bacBetAmountLocked = bet;
  bacBetTypeLocked = betType;
  bacDeck = bjFreshDeck();
  bacPlayerHand = []; bacBankerHand = [];
  bacStep = 'start';
  bacPlayerDrew = false; bacPlayerThirdVal = null;

  document.getElementById('bacBetPanel').style.display = 'none';
  document.getElementById('bacTableArea').style.display = 'block';
  document.getElementById('bacPlayerCards').innerHTML = '';
  document.getElementById('bacBankerCards').innerHTML = '';
  document.getElementById('bacPlayerTotal').textContent = '';
  document.getElementById('bacBankerTotal').textContent = '';
  const outcomeEl = document.getElementById('bacOutcomeMsg');
  outcomeEl.textContent = ''; outcomeEl.classList.remove('bj-outcome-pop', 'bj-outcome-jackpot');
  document.getElementById('bacNewHandBtn').style.display = 'none';
  document.getElementById('bacHitBtn').style.display = 'inline-block';
  document.getElementById('bacHitBtn').disabled = false;
  bacPulseChip(document.getElementById('bacBankerChip'), 0);
  bacPulseChip(document.getElementById('bacPlayerChip'), 0);

  await bacHit(); // reveal the first card straight away so the table isn't empty
}
async function bacHit(){
  const hitBtn = document.getElementById('bacHitBtn');
  hitBtn.disabled = true;
  const pCardsEl = document.getElementById('bacPlayerCards');
  const bCardsEl = document.getElementById('bacBankerCards');

  if(bacStep === 'start'){
    const c = bacDeck.pop(); bacPlayerHand.push(c);
    bacAppendCard(pCardsEl, c); bjPlayCardSound();
    bacStep = 'p1done';
  } else if(bacStep === 'p1done'){
    const c = bacDeck.pop(); bacBankerHand.push(c);
    bacAppendCard(bCardsEl, c); bjPlayCardSound();
    bacStep = 'b1done';
  } else if(bacStep === 'b1done'){
    const c = bacDeck.pop(); bacPlayerHand.push(c);
    bacAppendCard(pCardsEl, c); bjPlayCardSound();
    document.getElementById('bacPlayerTotal').textContent = `Total: ${bacHandTotal(bacPlayerHand)}`;
    bacPulseChip(document.getElementById('bacPlayerChip'), bacHandTotal(bacPlayerHand));
    bacStep = 'p2done';
  } else if(bacStep === 'p2done'){
    const c = bacDeck.pop(); bacBankerHand.push(c);
    bacAppendCard(bCardsEl, c); bjPlayCardSound();
    document.getElementById('bacBankerTotal').textContent = `Total: ${bacHandTotal(bacBankerHand)}`;
    bacPulseChip(document.getElementById('bacBankerChip'), bacHandTotal(bacBankerHand));
    const pt = bacHandTotal(bacPlayerHand), bt = bacHandTotal(bacBankerHand);
    if(pt >= 8 || bt >= 8) bacStep = 'done';
    else if(pt <= 5) bacStep = 'needPlayerThird';
    else bacStep = 'needBankerCheck';
  } else if(bacStep === 'needPlayerThird'){
    const c = bacDeck.pop(); bacPlayerHand.push(c);
    bacPlayerDrew = true; bacPlayerThirdVal = bacCardValue(c);
    bacAppendCard(pCardsEl, c); bjPlayCardSound();
    document.getElementById('bacPlayerTotal').textContent = `Total: ${bacHandTotal(bacPlayerHand)}`;
    bacPulseChip(document.getElementById('bacPlayerChip'), bacHandTotal(bacPlayerHand));
    bacStep = 'needBankerCheck';
  } else if(bacStep === 'needBankerCheck'){
    // The actual moment of truth — everything else in the hand was
    // mechanical, but whether Banker draws here is what decides it. A
    // brief pause + rising tone gives it real weight before the card
    // (or lack of one) lands, instead of it resolving instantly.
    if(typeof slotsPlayAnticipationRiser === 'function') slotsPlayAnticipationRiser();
    await bjWait(450);
    const bt = bacHandTotal(bacBankerHand);
    if(bacBankerShouldDraw(bt, bacPlayerDrew, bacPlayerThirdVal)){
      const c = bacDeck.pop(); bacBankerHand.push(c);
      bacAppendCard(bCardsEl, c); bjPlayCardSound();
      document.getElementById('bacBankerTotal').textContent = `Total: ${bacHandTotal(bacBankerHand)}`;
      bacPulseChip(document.getElementById('bacBankerChip'), bacHandTotal(bacBankerHand));
    }
    bacStep = 'done';
  }

  if(bacStep === 'done'){
    hitBtn.style.display = 'none';
    await bjWait(300);
    await bacResolve();
  } else {
    hitBtn.disabled = false;
  }
}
// Big Road — the real baccarat scoreboard convention: consecutive same
// winner stacks downward in one column; the moment the winner changes,
// a new column starts at the top; a Tie doesn't move the position at
// all, it just marks the most recent existing cell (shown as a small
// green tie count badge). Rebuilt fresh from bacHistory every time
// rather than maintained as separate parallel state, so it can never
// drift out of sync with the actual hand results. Deliberately skips
// the traditional "dragon tail" wrap-around rule for streaks longer
// than 6 in a row (a real but fairly advanced Big Road refinement) —
// a column just keeps growing downward instead, still fully readable.
function bacBuildBigRoad(history){
  const columns = [];
  history.forEach(result => {
    if(result === 'T'){
      if(columns.length === 0){ columns.push({ winner: 'T', cells: [{ ties: 0 }] }); return; }
      const lastCol = columns[columns.length - 1];
      const lastCell = lastCol.cells[lastCol.cells.length - 1];
      lastCell.ties = (lastCell.ties || 0) + 1;
      return;
    }
    const lastCol = columns[columns.length - 1];
    if(lastCol && lastCol.winner === result){
      lastCol.cells.push({ ties: 0 });
    } else {
      columns.push({ winner: result, cells: [{ ties: 0 }] });
    }
  });
  return columns;
}
function bacRenderHistory(){
  const el = document.getElementById('bacHistory');
  if(!el) return;
  const columns = bacBuildBigRoad(bacHistory);
  el.innerHTML = columns.map(col => {
    const cellsHtml = col.cells.map((cell, i) => {
      const isLast = i === col.cells.length - 1;
      const tieBadge = (cell.ties > 0) ? `<span class="bac-bigroad-tie">${cell.ties > 1 ? cell.ties : ''}</span>` : '';
      const cls = col.winner === 'P' ? 'bac-bigroad-p' : (col.winner === 'B' ? 'bac-bigroad-b' : 'bac-bigroad-t');
      return `<div class="bac-bigroad-cell ${cls}">${col.winner === 'T' ? 'T' : (col.winner === 'P' ? 'P' : 'B')}${tieBadge}</div>`;
    }).join('');
    return `<div class="bac-bigroad-col">${cellsHtml}</div>`;
  }).join('');
  // Always scrolled to the most recent column, same as a real scoreboard
  // reading left-to-right with "now" on the right edge.
  el.scrollLeft = el.scrollWidth;
  bacUpdateStreakBanner();
}
// Win streak — current run of the same winner from the tail of
// bacHistory, ties skipped (a tie doesn't break a streak, same
// convention Big Road itself uses for not moving position on a tie).
// Escalates visually/audibly the longer it goes.
function bacCurrentStreak(history){
  let streak = 0, winner = null;
  for(let i = history.length - 1; i >= 0; i--){
    const r = history[i];
    if(r === 'T') continue;
    if(winner === null){ winner = r; streak = 1; }
    else if(r === winner){ streak++; }
    else break;
  }
  return { winner, streak };
}
let bacLastStreakTier = null;
function bacUpdateStreakBanner(){
  const banner = document.getElementById('bacStreakBanner');
  if(!banner) return;
  const { winner, streak } = bacCurrentStreak(bacHistory);
  if(!winner || streak < 3){ banner.style.display = 'none'; bacLastStreakTier = null; return; }
  const who = winner === 'P' ? 'PLAYER' : 'BANKER';
  const tier = streak >= 7 ? 'epic' : (streak >= 5 ? 'hot' : 'warm');
  banner.className = 'bac-streak-banner bac-streak-' + tier;
  banner.textContent = (tier === 'epic' ? '🔥🔥🔥 ' : tier === 'hot' ? '🔥🔥 ' : '🔥 ') + `${who} on a ${streak}-streak!`;
  banner.style.display = 'block';
  if(tier !== bacLastStreakTier){
    // Only fires on the hand that actually crosses into a new tier, not
    // every hand the streak continues at the same level — otherwise a
    // long streak would replay the same celebration over and over.
    bjPlayChime(true);
    if(tier === 'epic') bjLaunchConfetti(banner, 35);
    bacLastStreakTier = tier;
  }
}
async function bacResolve(){
  const playerTotal = bacHandTotal(bacPlayerHand);
  const bankerTotal = bacHandTotal(bacBankerHand);
  const isNatural = (bacPlayerHand.length === 2 && playerTotal >= 8) || (bacBankerHand.length === 2 && bankerTotal >= 8);
  const betType = bacBetTypeLocked, bet = bacBetAmountLocked;

  let winner = playerTotal > bankerTotal ? 'player' : (bankerTotal > playerTotal ? 'banker' : 'tie');
  let outcome, delta;
  const naturalTag = isNatural ? ` — Natural ${Math.max(playerTotal, bankerTotal)}!` : '';
  if(betType === winner){
    if(betType === 'tie'){ outcome = `Tie wins!${naturalTag} 8:1 payout`; delta = bet * 8; }
    else if(betType === 'banker'){ outcome = `Banker wins${naturalTag} — you win`; delta = bet; }
    else { outcome = `Player wins${naturalTag} — you win`; delta = bet; }
  } else if(winner === 'tie'){
    outcome = `Tie${naturalTag} — Player/Banker bets push`; delta = 0;
  } else {
    outcome = `${winner === 'player' ? 'Player' : 'Banker'} wins${naturalTag} — you lose`; delta = -bet;
  }

  const outcomeEl = document.getElementById('bacOutcomeMsg');
  const isJackpot = betType === 'tie' && winner === 'tie';
  outcomeEl.textContent = `${outcome} (${delta >= 0 ? '+' : ''}${delta} XP)`;
  outcomeEl.style.color = isJackpot ? '' : (delta > 0 ? 'var(--win)' : (delta < 0 ? 'var(--loss)' : 'var(--muted)'));
  outcomeEl.classList.add(isJackpot ? 'bj-outcome-jackpot' : 'bj-outcome-pop');
  document.getElementById('bacNewHandBtn').style.display = 'inline-block';
  bacLastBet = { betType, amount: bet };
  document.getElementById('bacSameBetBtn').disabled = false;

  bacHistory.push(winner === 'player' ? 'P' : (winner === 'banker' ? 'B' : 'T'));
  bacRenderHistory();

  const tableEl = document.getElementById('bacTableArea');
  if(isNatural){
    // A Natural is a genuinely special moment in baccarat regardless of
    // which side it favoured — its own distinct layered sound, on top
    // of whatever the win/loss chime below already plays.
    if(typeof slotsPlayCoinCascade === 'function') slotsPlayCoinCascade(false);
  }
  if(delta > 0){
    bjPlayChime(true);
    tableEl.classList.remove('pc-flash-gold'); void tableEl.offsetWidth; tableEl.classList.add('pc-flash-gold');
    bjLaunchConfetti(outcomeEl, isJackpot ? 42 : 22);
    setTimeout(() => tableEl.classList.remove('pc-flash-gold'), 700);
  } else if(delta < 0){
    bjPlayChime(false);
    tableEl.classList.add('pc-shake', 'pc-flash-red');
    setTimeout(() => tableEl.classList.remove('pc-shake', 'pc-flash-red'), 700);
  }

  if(delta !== 0) await awardXP(delta, delta > 0 ? 'Baccarat win' : 'Baccarat loss', { silent: true, detail: { type: 'cards', playerCards: bacPlayerHand, bankerCards: bacBankerHand, playerTotal, bankerTotal } });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
}
function bacNewHand(){
  document.getElementById('bacBetPanel').style.display = 'block';
  document.getElementById('bacTableArea').style.display = 'none';
}
document.getElementById('bacDealBtn').addEventListener('click', bacDeal);
// Restores both the last bet TYPE (Player/Banker/Tie) and amount in one
// tap — real-clicks the correct spot button so its active styling and
// bacSelectedBet stay in sync the same way a manual tap would.
document.getElementById('bacSameBetBtn').addEventListener('click', () => {
  if(!bacLastBet) return;
  const targetBtn = document.querySelector(`.bet-spot-btn[data-bac-bet="${bacLastBet.betType}"]`);
  if(targetBtn) targetBtn.click();
  const betInput = document.getElementById('bacBetInput');
  betInput.value = bacLastBet.amount;
  betInput.dispatchEvent(new Event('input'));
  bjPlayChipSound();
});
document.getElementById('bacHitBtn').addEventListener('click', bacHit);
document.getElementById('bacNewHandBtn').addEventListener('click', bacNewHand);
document.getElementById('bacBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('bacChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
});
// Click the chip to type any custom amount — same pattern every other
// game's main bet chip already uses. Guarded on the bet panel still being
// visible (rather than a dedicated hand-active flag, which this game
// doesn't have) — same "can't change your bet mid-hand" intent as Deal
// already enforces by hiding this panel the moment a hand starts.
document.getElementById('bacChipDisplay').addEventListener('click', async () => {
  const panel = document.getElementById('bacBetPanel');
  if(panel && panel.style.display === 'none') return;
  const input = document.getElementById('bacBetInput');
  const amount = await openChipAmountModal(input.value || '50', 'Bet amount (XP)');
  if(amount == null) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
});

// ---- Auto Play — repeats whatever bet is currently active (type +
// amount, exactly what's selected/entered right now, same as a manual
// Deal would use) hand after hand, up to a chosen count. Baccarat has
// no bonus feature to stop early for the way Slots does, so this simply
// runs the count down, pausing between each reveal so a hand is
// actually watchable rather than a blur, and stops early on a genuine
// bet-validation failure (insufficient balance, etc.) instead of
// hammering the same error repeatedly.
let bacAutoPlayCount = 10;
let bacAutoPlayRemaining = 0;
let bacAutoPlayRunning = false;
document.querySelectorAll('#bacAutoPlayCountRow .craps-winmode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if(bacAutoPlayRunning) return;
    bacAutoPlayCount = parseInt(btn.dataset.auto, 10) || 10;
    document.querySelectorAll('#bacAutoPlayCountRow .craps-winmode-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});
async function bacRunAutoPlay(){
  bacAutoPlayRemaining = bacAutoPlayCount;
  const btn = document.getElementById('bacAutoPlayBtn');
  const errEl = document.getElementById('bacBetError');
  while(bacAutoPlayRunning && bacAutoPlayRemaining > 0){
    if(errEl) errEl.textContent = '';
    btn.textContent = `⏹ Stop (${bacAutoPlayRemaining} left)`;
    await bacDeal(); // starts the hand, reveals the first card
    if(errEl && errEl.textContent) break; // bet validation failed — stop rather than repeat the same error
    // Keep revealing cards, same as tapping Hit repeatedly, with a
    // pause between each so it's actually watchable.
    while(bacStep !== 'done'){
      await bjWait(550);
      await bacHit();
    }
    await bjWait(1000); // let the outcome/celebration actually be seen
    bacAutoPlayRemaining--;
  }
  bacAutoPlayRunning = false;
  if(btn){ btn.textContent = '🔄 Auto Play'; btn.classList.remove('slots-auto-running'); }
}
document.getElementById('bacAutoPlayBtn').addEventListener('click', () => {
  const btn = document.getElementById('bacAutoPlayBtn');
  if(bacAutoPlayRunning){
    bacAutoPlayRunning = false; // stops after the hand currently in flight finishes
    return;
  }
  bacAutoPlayRunning = true;
  btn.classList.add('slots-auto-running');
  bacRunAutoPlay();
});
