// ---- Casino War ----
// One card each, higher card wins (Ace high). A tie offers Go to War
// (double the stake: burn 3 cards, deal one more each, higher of THIS
// round wins) or Surrender (forfeit half the original bet immediately).
// House rule used here, stated plainly since real casinos vary: winning
// the war pays 1:1 on the ORIGINAL bet (the raise is simply returned,
// i.e. pushed) — losing the war loses BOTH the original bet and the raise.
// A second tie during the war is a full push (everything returned).
let warDeck = [];
let warOriginalBet = 0;
let warLastBet = null; // snapshot of the last hand's bet + Pairs side bet, for the Same Bet button
let warPlayerCard = null, warDealerCard = null;
let warHistory = []; // 'W'/'L'/'T' — T only ever appears if the same tie repeats through a full war exchange to a push
function warCardValue(c){ if(c.rank === 'A') return 14; if(c.rank === 'K') return 13; if(c.rank === 'Q') return 12; if(c.rank === 'J') return 11; return Number(c.rank); }
function warRenderSingle(containerId, card){
  const el = document.getElementById(containerId);
  el.innerHTML = bjRenderCards([card], true);
}
let warDealing = false; // guards a fast double-tap on Deal — same class fixed for Craps/Blackjack/Slots/Daily Spin
async function warDeal(){
  if(warDealing) return;
  warDealing = true;
  const dealBtn = document.getElementById('warDealBtn');
  if(dealBtn) dealBtn.disabled = true;
  try{
    await warDealInner();
  } finally {
    warDealing = false;
    if(dealBtn) dealBtn.disabled = false;
  }
}
async function warDealInner(){
  const errEl = document.getElementById('warBetError');
  errEl.textContent = '';
  const bet = parseInt(document.getElementById('warBetInput').value, 10);
  const ppOn = document.getElementById('warPerfectPairsCheck').checked;
  const ppBet = parseInt(document.getElementById('warPerfectPairsAmount').value, 10) || 0;
  const balance = await getXPBalance();
  const totalStake = bet + (ppOn ? ppBet : 0);
  if(!bet || bet < 5){ errEl.textContent = 'Minimum bet is 5 XP.'; return; }
  if(ppOn && ppBet < 5){ errEl.textContent = 'Minimum Pairs side bet is 5 XP.'; return; }
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(totalStake > balance){ errEl.textContent = `You only have ${balance} XP.`; return; }

  warOriginalBet = bet;
  warDeck = bjFreshDeck();
  warPlayerCard = warDeck.pop();
  warDealerCard = warDeck.pop();

  document.getElementById('warBetPanel').style.display = 'none';
  document.getElementById('warTableArea').style.display = 'block';
  const outcomeEl = document.getElementById('warOutcomeMsg');
  outcomeEl.textContent = ''; outcomeEl.classList.remove('bj-outcome-pop', 'bj-outcome-jackpot');
  const ppEl = document.getElementById('warPPOutcomeMsg');
  ppEl.textContent = '';
  document.getElementById('warGoBtn').style.display = 'none';
  document.getElementById('warSurrenderBtn').style.display = 'none';
  document.getElementById('warNewHandBtn').style.display = 'none';

  warRenderSingle('warDealerCards', warDealerCard);
  warRenderSingle('warPlayerCards', warPlayerCard);
  bjPlayCardSound();

  if(ppOn){
    const isPair = warPlayerCard.rank === warDealerCard.rank;
    await bjWait(300);
    if(isPair){
      const win = ppBet * 10;
      ppEl.innerHTML = `<span style="color:var(--win); font-weight:700;">Pairs! +${win} XP</span>`;
      ppEl.classList.remove('bj-outcome-pop'); void ppEl.offsetWidth; ppEl.classList.add('bj-outcome-pop');
      bjPlaySideBetDing();
      bjLaunchConfetti(ppEl, 14);
      await awardXP(win, 'Casino War Pairs side bet', { silent: true });
    } else {
      ppEl.innerHTML = `<span style="color:var(--loss);">Pairs: no match (-${ppBet} XP)</span>`;
      await awardXP(-ppBet, 'Casino War Pairs side bet', { silent: true });
    }
    const bal = await getXPBalance();
    updateXPBalanceDisplay(bal);
  }

  await bjWait(400);
  const pv = warCardValue(warPlayerCard), dv = warCardValue(warDealerCard);
  if(pv === dv){
    outcomeEl.textContent = "It's a tie! Go to war, or surrender?";
    outcomeEl.style.color = 'var(--brass-light)';
    outcomeEl.classList.add('bj-outcome-pop');
    document.getElementById('warGoBtn').style.display = 'inline-block';
    document.getElementById('warSurrenderBtn').style.display = 'inline-block';
  } else {
    await warResolve(pv > dv ? bet : -bet, pv > dv ? 'You win' : 'Dealer wins', false);
  }
}
function warRenderHistory(){
  const el = document.getElementById('warHistory');
  if(!el) return;
  el.innerHTML = warHistory.slice(-10).reverse().map(r => {
    const bg = r === 'W' ? 'var(--win)' : (r === 'L' ? 'var(--loss)' : 'rgb(91,141,190)');
    return `<div class="roulette-history-chip" style="background:${bg};">${r}</div>`;
  }).join('');
}
async function warResolve(delta, label, wasWar){
  const outcomeEl = document.getElementById('warOutcomeMsg');
  outcomeEl.textContent = `${label} (${delta >= 0 ? '+' : ''}${delta} XP)`;
  outcomeEl.style.color = delta > 0 ? 'var(--win)' : (delta < 0 ? 'var(--loss)' : 'var(--muted)');
  outcomeEl.classList.remove('bj-outcome-pop'); void outcomeEl.offsetWidth; outcomeEl.classList.add('bj-outcome-pop');
  document.getElementById('warGoBtn').style.display = 'none';
  document.getElementById('warSurrenderBtn').style.display = 'none';
  document.getElementById('warNewHandBtn').style.display = 'inline-block';
  warLastBet = { amount: warOriginalBet, ppOn: document.getElementById('warPerfectPairsCheck').checked, ppAmount: parseInt(document.getElementById('warPerfectPairsAmount').value, 10) || 0 };
  document.getElementById('warSameBetBtn').disabled = false;

  warHistory.push(delta > 0 ? 'W' : (delta < 0 ? 'L' : 'T'));
  warRenderHistory();

  const tableEl = document.getElementById('warTableArea');
  if(delta > 0){
    bjPlayChime(true);
    tableEl.classList.remove('pc-flash-gold'); void tableEl.offsetWidth; tableEl.classList.add('pc-flash-gold');
    bjLaunchConfetti(outcomeEl, wasWar ? 42 : 22);
    setTimeout(() => tableEl.classList.remove('pc-flash-gold'), 700);
  } else if(delta < 0){
    bjPlayChime(false);
    tableEl.classList.add('pc-shake', 'pc-flash-red');
    setTimeout(() => tableEl.classList.remove('pc-shake', 'pc-flash-red'), 700);
  }

  if(delta !== 0) await awardXP(delta, delta > 0 ? 'Casino War win' : 'Casino War loss', { silent: true, detail: { type: 'cards', playerCards: [warPlayerCard], bankerCards: [warDealerCard] } });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
}
async function warGoToWar(){
  const balance = await getXPBalance();
  // Same principle as Blackjack's Double Down/Split — going to war doubles
  // the total at risk (the original bet stays live, plus a matching
  // raise), so this needs balance for both, or a loss could take someone
  // negative. This one had no balance check at all before now; Surrender
  // remains available either way as the lower-risk option.
  if(balance == null || balance < warOriginalBet * 2){
    const errEl = document.getElementById('warOutcomeMsg');
    if(errEl){ errEl.textContent = 'Not enough XP to go to war — try Surrender instead.'; errEl.style.color = 'var(--loss)'; }
    return;
  }
  document.getElementById('warGoBtn').style.display = 'none';
  document.getElementById('warSurrenderBtn').style.display = 'none';
  bjPlayChipSound();
  // burn three cards face down, matching the real-table ritual, then deal one more each
  warDeck.pop(); warDeck.pop(); warDeck.pop();
  await bjWait(350);
  warPlayerCard = warDeck.pop();
  warDealerCard = warDeck.pop();
  warRenderSingle('warDealerCards', warDealerCard);
  warRenderSingle('warPlayerCards', warPlayerCard);
  bjPlayCardSound();
  await bjWait(500);
  const pv = warCardValue(warPlayerCard), dv = warCardValue(warDealerCard);
  if(pv === dv){
    await warResolve(0, 'Tied again — everything pushes', true);
  } else if(pv > dv){
    await warResolve(warOriginalBet, 'You win the war!', true);
  } else {
    await warResolve(-warOriginalBet * 2, 'Dealer wins the war', true);
  }
}
async function warSurrender(){
  const delta = -Math.floor(warOriginalBet / 2);
  await warResolve(delta, 'Surrendered', false);
}
function warNewHand(){
  document.getElementById('warBetPanel').style.display = 'block';
  document.getElementById('warTableArea').style.display = 'none';
}
document.getElementById('warDealBtn').addEventListener('click', warDeal);
document.getElementById('warSameBetBtn').addEventListener('click', () => {
  if(!warLastBet) return;
  const betInput = document.getElementById('warBetInput');
  betInput.value = warLastBet.amount;
  betInput.dispatchEvent(new Event('input'));
  const ppCheck = document.getElementById('warPerfectPairsCheck');
  if(ppCheck.checked !== warLastBet.ppOn) document.getElementById('warPerfectPairsToggle').click();
  if(warLastBet.ppOn){
    const ppInput = document.getElementById('warPerfectPairsAmount');
    ppInput.value = warLastBet.ppAmount;
    ppInput.dispatchEvent(new Event('input'));
  }
  bjPlayChipSound();
});
document.getElementById('warGoBtn').addEventListener('click', warGoToWar);
document.getElementById('warSurrenderBtn').addEventListener('click', warSurrender);
document.getElementById('warNewHandBtn').addEventListener('click', warNewHand);
document.getElementById('warBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('warChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
});
