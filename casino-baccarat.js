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
  if(!bet || bet < 5){ errEl.textContent = 'Minimum bet is 5 XP.'; return; }
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
function bacRenderHistory(){
  const el = document.getElementById('bacHistory');
  if(!el) return;
  // Traditional baccarat scoreboard colours — blue Player, red Banker,
  // green Tie — not this app's usual win/loss green/red, since this
  // strip tracks who WON the hand, not whether the player personally won.
  el.innerHTML = bacHistory.slice(-10).reverse().map(r => {
    const bg = r === 'P' ? 'rgb(91,141,190)' : (r === 'B' ? '#8c2a22' : '#1f7a4a');
    return `<div class="roulette-history-chip" style="background:${bg};">${r}</div>`;
  }).join('');
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
  renderXPLog();
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
