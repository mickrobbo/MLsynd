// ---- Video Poker (Tens or Better) ----
const VP_PAYTABLE = [
  { key:'royal',    label:'Royal Flush',      mult:250 },
  { key:'straightf',label:'Straight Flush',   mult:40  },
  { key:'quads',    label:'Four of a Kind',   mult:20  },
  { key:'fullhouse',label:'Full House',       mult:6   },
  { key:'flush',    label:'Flush',            mult:5   },
  { key:'straight', label:'Straight',         mult:4   },
  { key:'trips',    label:'Three of a Kind',  mult:3   },
  { key:'twopair',  label:'Two Pair',         mult:2   },
  { key:'jacks',    label:'Tens or Better',    mult:1   }
];
let vpBuilt = false;
let vpDeck = [];
let vpHand = [];
let vpHeld = [false, false, false, false, false];
let vpStage = 'idle'; // idle | dealt
let vpLastBet = null; // snapshot of the last hand's bet amount, for the Same Bet button

// ---- Multi-hand mode — the signature real-video-poker feature: deal
// ONE base hand, hold whichever cards you like, and every additional
// hand draws its OWN independent replacement cards for the non-held
// positions from its own separate deck (so hands can and do diverge
// after the draw) while sharing the exact same held cards throughout.
// Bet is per-hand — 3-hand mode costs 3x, 5-hand mode costs 5x.
let vpHandCount = 1;
let vpExtraHands = []; // [{ hand: [5 cards] }, ...] — length vpHandCount-1, all drawing from the shared vpDeck
let vpPlayDealer = false;
document.getElementById('vpPlayDealerBtn').addEventListener('click', () => {
  if(vpStage !== 'idle') return; // can't change mid-hand
  vpPlayDealer = !vpPlayDealer;
  const btn = document.getElementById('vpPlayDealerBtn');
  btn.textContent = `🎩 Play the Dealer: ${vpPlayDealer ? 'On' : 'Off'}`;
  btn.classList.toggle('slots-auto-running', vpPlayDealer);
});
document.querySelectorAll('#vpHandCountRow .craps-winmode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if(vpStage !== 'idle') return; // can't change mid-hand
    vpHandCount = parseInt(btn.dataset.hands, 10) || 1;
    document.querySelectorAll('#vpHandCountRow .craps-winmode-btn').forEach(b => b.classList.toggle('active', b === btn));
    vpUpdateTotalBetHint();
  });
});
function vpUpdateTotalBetHint(){
  const el = document.getElementById('vpTotalBetHint');
  if(!el) return;
  const perHand = parseInt(document.getElementById('vpBetInput').value, 10) || 0;
  el.textContent = vpHandCount > 1 ? `${perHand} XP/hand × ${vpHandCount} hands — total bet ${perHand * vpHandCount} XP` : '';
}
function vpBuildPaytable(){
  const table = document.getElementById('vpPaytable');
  table.innerHTML = VP_PAYTABLE.map(p => `<tr id="vpPayRow_${p.key}"><td>${p.label}</td><td style="text-align:right;">${p.mult}:1</td></tr>`).join('');
  vpBuilt = true;
}
function vpRenderIdleHand(){
  document.getElementById('vpHandRow').innerHTML = [0,1,2,3,4].map(() =>
    `<div class="vp-card-col"><div class="playing-card pc-back" style="width:56px;height:80px;"></div><span class="vp-hold-pill" style="visibility:hidden;">Hold</span></div>`).join('');
}
const VP_RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function vpRankValue(r){ return VP_RANK_ORDER.indexOf(r) + 2; }
// ---- Play the Dealer: a full hand-strength comparator, distinct from
// vpEvaluateHand above — that one only cares whether a hand qualifies
// for a PAYTABLE line (Tens or Better and up, returns null otherwise),
// which isn't enough to judge "did the player beat the dealer" when
// either hand could be a low pair or nothing at all. This ranks any
// 5-card hand from High Card through Royal Flush with proper
// tiebreakers, for a genuine head-to-head comparison.
const VP_HAND_CATEGORY_LABELS = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush'];
function vpRankHandForCompare(hand){
  const ranks = hand.map(c => vpRankValue(c.rank)).sort((a, b) => b - a);
  const suits = hand.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const counts = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  const countVals = Object.entries(counts).map(([r, c]) => [Number(r), c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniqueRanksDesc = Object.keys(counts).map(Number).sort((a, b) => b - a);
  let isStraight = false, straightHigh = ranks[0];
  if(uniqueRanksDesc.length === 5){
    isStraight = uniqueRanksDesc[0] - uniqueRanksDesc[4] === 4;
    if(!isStraight && uniqueRanksDesc.join(',') === '14,5,4,3,2'){ isStraight = true; straightHigh = 5; } // wheel: A-2-3-4-5
  }
  const isRoyal = isFlush && isStraight && uniqueRanksDesc[0] === 14 && straightHigh === 14;
  let category, tiebreak;
  if(isRoyal){ category = 9; tiebreak = [14]; }
  else if(isStraight && isFlush){ category = 8; tiebreak = [straightHigh]; }
  else if(countVals[0][1] === 4){ category = 7; tiebreak = [countVals[0][0], countVals[1][0]]; }
  else if(countVals[0][1] === 3 && countVals[1] && countVals[1][1] === 2){ category = 6; tiebreak = [countVals[0][0], countVals[1][0]]; }
  else if(isFlush){ category = 5; tiebreak = ranks; }
  else if(isStraight){ category = 4; tiebreak = [straightHigh]; }
  else if(countVals[0][1] === 3){ category = 3; tiebreak = [countVals[0][0], ...uniqueRanksDesc.filter(r => r !== countVals[0][0])]; }
  else if(countVals[0][1] === 2 && countVals[1] && countVals[1][1] === 2){
    const pairRanks = [countVals[0][0], countVals[1][0]].sort((a, b) => b - a);
    const kicker = uniqueRanksDesc.find(r => !pairRanks.includes(r));
    category = 2; tiebreak = [...pairRanks, kicker];
  }
  else if(countVals[0][1] === 2){ category = 1; tiebreak = [countVals[0][0], ...uniqueRanksDesc.filter(r => r !== countVals[0][0])]; }
  else { category = 0; tiebreak = ranks; }
  return { category, tiebreak, label: VP_HAND_CATEGORY_LABELS[category] };
}
// >0 means a beats b, <0 means b beats a, 0 means an exact tie (push)
function vpCompareHands(a, b){
  if(a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for(let i = 0; i < len; i++){
    const av = a.tiebreak[i] || 0, bv = b.tiebreak[i] || 0;
    if(av !== bv) return av - bv;
  }
  return 0;
}
function vpEvaluateHand(hand){
  const ranks = hand.map(c => vpRankValue(c.rank)).sort((a,b) => a - b);
  const suits = hand.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const countVals = Object.values(counts).sort((a,b) => b - a);
  const uniqueRanks = Object.keys(counts).map(Number).sort((a,b) => a - b);
  let isStraight = false;
  if(uniqueRanks.length === 5){
    isStraight = (uniqueRanks[4] - uniqueRanks[0] === 4);
    // Ace-low straight: A-2-3-4-5 (ranks stored as 14,2,3,4,5 → sorted 2,3,4,5,14)
    if(!isStraight && uniqueRanks.join(',') === '2,3,4,5,14') isStraight = true;
  }
  const isRoyal = isFlush && isStraight && uniqueRanks.includes(10) && uniqueRanks.includes(14) && uniqueRanks[0] === 10;

  if(isRoyal) return { key:'royal', label:'Royal Flush' };
  if(isStraight && isFlush) return { key:'straightf', label:'Straight Flush' };
  if(countVals[0] === 4) return { key:'quads', label:'Four of a Kind' };
  if(countVals[0] === 3 && countVals[1] === 2) return { key:'fullhouse', label:'Full House' };
  if(isFlush) return { key:'flush', label:'Flush' };
  if(isStraight) return { key:'straight', label:'Straight' };
  if(countVals[0] === 3) return { key:'trips', label:'Three of a Kind' };
  if(countVals[0] === 2 && countVals[1] === 2) return { key:'twopair', label:'Two Pair' };
  if(countVals[0] === 2){
    const pairRank = Number(Object.keys(counts).find(r => counts[r] === 2));
    if(pairRank >= 10) return { key:'jacks', label:'Tens or Better' };
  }
  return null;
}
// Distinct short tick for toggling Hold — pitched up when holding, down
// when releasing, so the two states are audibly different at a glance.
function vpPlayHoldClick(held){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = held ? 720 : 420;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.11, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.1);
}
// animateIdx: which card positions should deal-in-animate this render —
// defaults to every card (initial Deal). On Draw, only the freshly-drawn
// (non-held) positions are passed, so held cards visibly stay put instead
// of re-dealing themselves, which is what a real video poker draw looks
// and sounds like.
function vpRenderHand(animate, animateIdx){
  const animateSet = animateIdx || [0,1,2,3,4];
  document.getElementById('vpHandRow').innerHTML = vpHand.map((c, i) => {
    const isRed = c.suit === '♥' || c.suit === '♦';
    const willAnimate = animate && animateSet.includes(i);
    const orderInAnim = animateSet.indexOf(i);
    const delay = willAnimate ? Math.max(0, orderInAnim) * 450 : 0;
    if(willAnimate) setTimeout(bjPlayCardSound, delay);
    const heldGlow = vpHeld[i] ? ' pc-held-glow' : '';
    return `<div class="vp-card-col">
      <div class="playing-card ${isRed ? 'pc-red' : 'pc-black'}${willAnimate ? ' pc-dealt' : ''}${heldGlow}" style="animation-delay:${delay}ms;">${bjPipHtml(c)}</div>
      <button type="button" class="vp-hold-pill${vpHeld[i] ? ' held' : ''}" data-idx="${i}">${vpHeld[i] ? 'Held' : 'Hold'}</button>
    </div>`;
  }).join('');
  document.querySelectorAll('#vpHandRow .vp-hold-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      if(vpStage !== 'dealt') return;
      const idx = parseInt(btn.dataset.idx, 10);
      vpHeld[idx] = !vpHeld[idx];
      vpPlayHoldClick(vpHeld[idx]);
      vpRenderHand(false);
      const cardEl = document.querySelectorAll('#vpHandRow .playing-card')[idx];
      if(cardEl){ cardEl.classList.remove('pc-hold-pop'); void cardEl.offsetWidth; cardEl.classList.add('pc-hold-pop'); }
    });
  });
}
// Additional hands render read-only, no Hold pills of their own — holds
// are shared with the base hand (vpHeld), the actual point of multi-
// hand poker: one decision, judged in parallel across every hand, all
// drawing from the one shared deck (see vpDraw). Each hand still gets
// its own small result label once Draw resolves, so a win on hand 3
// while hands 1/2 miss is clearly visible per-hand, not just folded
// into one combined total.
function vpRenderExtraHands(animate){
  const area = document.getElementById('vpMultiHandsArea');
  if(!area) return;
  if(vpExtraHands.length === 0){ area.innerHTML = ''; return; }
  area.innerHTML = vpExtraHands.map((eh, hi) => {
    const cardsHtml = eh.hand.map((c, i) => {
      const isRed = c.suit === '♥' || c.suit === '♦';
      const delay = animate ? i * 450 : 0;
      if(animate) setTimeout(bjPlayCardSound, delay);
      return `<div class="playing-card ${isRed ? 'pc-red' : 'pc-black'}${animate ? ' pc-dealt' : ''} vp-extra-card" style="animation-delay:${delay}ms;">${bjPipHtml(c)}</div>`;
    }).join('');
    return `<div class="vp-extra-hand-row"><div class="vp-extra-hand-cards">${cardsHtml}</div><span class="vp-extra-hand-result" id="vpExtraResult${hi}"></span></div>`;
  }).join('');
}
function vpHighlightPayout(key){
  VP_PAYTABLE.forEach(p => document.getElementById('vpPayRow_' + p.key).classList.remove('vp-hit'));
  if(key) document.getElementById('vpPayRow_' + key).classList.add('vp-hit');
}
async function vpDeal(){
  const dealBtn = document.getElementById('vpDealBtn');
  if(dealBtn.disabled) return;
  dealBtn.disabled = true;
  const errEl = document.getElementById('vpBetError');
  errEl.textContent = '';
  const amount = parseInt(document.getElementById('vpBetInput').value, 10) || 0;
  if(amount <= 0){ errEl.textContent = 'Add some chips first.'; dealBtn.disabled = false; return; }
  const totalBet = amount * vpHandCount;
  if(totalBet > CASINO_MAX_BET_PER_HAND){ errEl.textContent = `Maximum total bet is ${CASINO_MAX_BET_PER_HAND.toLocaleString()} XP (${amount.toLocaleString()} × ${vpHandCount} hands = ${totalBet.toLocaleString()}).`; dealBtn.disabled = false; return; }
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; dealBtn.disabled = false; return; }
  if(totalBet > balance){ errEl.textContent = `You only have ${balance} XP (total bet: ${totalBet}).`; dealBtn.disabled = false; return; }

  vpDeck = bjFreshDeck();
  vpHand = vpDeck.splice(0, 5);
  vpHeld = [false, false, false, false, false];
  vpStage = 'dealt';
  document.getElementById('vpOutcomeMsg').textContent = '';
  document.getElementById('vpOutcomeMsg').classList.remove('bj-outcome-pop', 'bj-outcome-jackpot');
  document.getElementById('vpOutcomeMsg').style.color = '';
  vpHighlightPayout(null);
  const dealerAreaReset = document.getElementById('vpDealerArea');
  if(dealerAreaReset) dealerAreaReset.style.display = 'none';
  vpRenderHand(true);
  // Every extra hand starts as an exact copy of the base hand's 5 cards
  // (same physical deal, parallel realities). Holds are shared with the
  // base hand (see vpHeld) — one decision, judged in parallel, the
  // actual point of multi-hand poker. All replacement cards for every
  // hand come from vpDeck, the ONE deck already dealing the base hand —
  // each hand's replacements are drawn sequentially further into that
  // same deck at Draw time, so no card can ever repeat across the whole
  // table (guaranteed by a single depleting deck, not by artificially
  // filtering separate ones).
  vpExtraHands = [];
  for(let i = 1; i < vpHandCount; i++){
    vpExtraHands.push({ hand: vpHand.map(c => ({ ...c })) });
  }
  vpRenderExtraHands(true);
  document.getElementById('vpDealBtn').style.display = 'none';
  document.getElementById('vpDrawBtn').style.display = 'inline-block';
  document.getElementById('vpChipRail').style.pointerEvents = 'none';
  document.getElementById('vpChipRail').style.opacity = '.5';
  document.querySelectorAll('#vpHandCountRow .craps-winmode-btn').forEach(b => { b.disabled = true; });
}
async function vpDraw(){
  scrollIntoViewSmooth('vpTableRail');
  const amount = parseInt(document.getElementById('vpBetInput').value, 10) || 0;
  const totalBet = amount * vpHandCount;
  document.getElementById('vpDrawBtn').disabled = true;
  const drawnIdx = vpHeld.map((h, i) => h ? -1 : i).filter(i => i !== -1);
  vpHand = vpHand.map((c, i) => vpHeld[i] ? c : vpDeck.shift());
  vpRenderHand(true, drawnIdx);
  // Every extra hand replaces its non-held positions using the SAME
  // shared hold decision as the base hand (vpHeld — holds are shared
  // again, the actual point of multi-hand poker), drawing sequentially
  // further into the same vpDeck the base hand already drew from. One
  // real deck, continuously depleting across the whole table — no two
  // hands can ever show a duplicate card.
  vpExtraHands.forEach(eh => {
    eh.hand = eh.hand.map((c, i) => vpHeld[i] ? c : vpDeck.shift());
  });
  vpRenderExtraHands(true);
  await bjWait(drawnIdx.length * 450 + 500);
  // A brief suspenseful pause before the result actually lands — the
  // reveal itself already happened, but announcing the result instantly
  // undercut the moment; this gives it a beat to breathe first.
  if(typeof slotsPlayAnticipationRiser === 'function') slotsPlayAnticipationRiser();
  await bjWait(350);

  const result = vpEvaluateHand(vpHand);
  const outcomeEl = document.getElementById('vpOutcomeMsg');
  const panelEl = document.getElementById('casinoGameVideoPoker');
  let totalDelta = 0;
  let baseIsBigHand = false;
  if(result){
    const pay = VP_PAYTABLE.find(p => p.key === result.key);
    const delta = amount * pay.mult;
    totalDelta += delta;
    vpHighlightPayout(result.key);
    baseIsBigHand = result.key === 'royal' || result.key === 'straightf';
  } else {
    totalDelta -= amount;
  }
  // Each extra hand evaluates and pays independently, its own small
  // result label so a win on one hand among several is clearly visible,
  // not just buried in the combined total.
  const extraLabels = [];
  vpExtraHands.forEach((eh, hi) => {
    const r = vpEvaluateHand(eh.hand);
    const labelEl = document.getElementById('vpExtraResult' + hi);
    if(r){
      const pay = VP_PAYTABLE.find(p => p.key === r.key);
      const delta = amount * pay.mult;
      totalDelta += delta;
      extraLabels.push(`Hand ${hi + 2}: ${r.label} +${delta}`);
      if(labelEl){ labelEl.textContent = `${r.label} +${delta}`; labelEl.style.color = 'var(--win)'; }
    } else {
      totalDelta -= amount;
      extraLabels.push(`Hand ${hi + 2}: No win`);
      if(labelEl){ labelEl.textContent = 'No win'; labelEl.style.color = 'var(--muted)'; }
    }
  });

  // Play the Dealer — dealt from the SAME vpDeck, further into it after
  // every player hand has already drawn, so it can never repeat a card
  // any player hand is holding or just drew. Compared against every
  // player hand independently; beating the dealer adds a flat bonus
  // (equal to that hand's own bet) on top of whatever the paytable
  // already paid — a free bonus condition, not an extra stake, so
  // there's no additional risk for turning this on.
  const dealerArea = document.getElementById('vpDealerArea');
  let dealerBonusParts = [];
  if(vpPlayDealer){
    const dealerHand = vpDeck.splice(0, 5);
    const dealerRow = document.getElementById('vpDealerHandRow');
    if(dealerRow){
      dealerRow.innerHTML = dealerHand.map((c, i) => {
        const isRed = c.suit === '♥' || c.suit === '♦';
        const delay = i * 220;
        setTimeout(bjPlayCardSound, delay);
        return `<div class="vp-card-col"><div class="playing-card ${isRed ? 'pc-red' : 'pc-black'} pc-dealt vp-extra-card" style="animation-delay:${delay}ms;">${bjPipHtml(c)}</div></div>`;
      }).join('');
    }
    if(dealerArea) dealerArea.style.display = 'block';
    const dealerRank = vpRankHandForCompare(dealerHand);
    const dealerResultEl = document.getElementById('vpDealerResult');
    if(dealerResultEl) dealerResultEl.textContent = `Dealer: ${dealerRank.label}`;

    const baseRank = vpRankHandForCompare(vpHand);
    if(vpCompareHands(baseRank, dealerRank) > 0){
      totalDelta += amount;
      dealerBonusParts.push(`Beat dealer (Hand 1) +${amount}`);
    }
    vpExtraHands.forEach((eh, hi) => {
      const r = vpRankHandForCompare(eh.hand);
      if(vpCompareHands(r, dealerRank) > 0){
        totalDelta += amount;
        dealerBonusParts.push(`Beat dealer (Hand ${hi + 2}) +${amount}`);
      }
    });
  } else if(dealerArea){
    dealerArea.style.display = 'none';
  }

  const baseLabel = result ? `${result.label} +${amount * VP_PAYTABLE.find(p => p.key === result.key).mult}` : 'No win';
  const allParts = [vpHandCount > 1 ? `Hand 1: ${baseLabel}` : baseLabel, ...extraLabels, ...dealerBonusParts];
  outcomeEl.textContent = (vpHandCount > 1 || dealerBonusParts.length > 0 ? allParts.join(' · ') + ' — ' : '') + `Total: ${totalDelta >= 0 ? '+' : ''}${totalDelta} XP`;

  // Big Win escalation — tiered by total win relative to the total bet
  // across every hand, same convention as Slots/Roulette. A Royal Flush
  // trivially clears EPIC on its own (250x), so this naturally replaces
  // the old flat "jackpot" treatment rather than needing a separate
  // carve-out for it.
  const winRatio = totalBet > 0 ? totalDelta / totalBet : 0;
  let bigWinTier = null;
  if(totalDelta > 0){
    if(winRatio >= 40) bigWinTier = 'EPIC';
    else if(winRatio >= 15) bigWinTier = 'SUPER';
    else if(winRatio >= 5) bigWinTier = 'BIG';
  }
  if(bigWinTier){
    outcomeEl.style.color = '';
    outcomeEl.classList.add('bj-outcome-jackpot');
    casinoShowBigWinBanner('vp', bigWinTier, totalDelta);
    if(baseIsBigHand && typeof slotsPlayCoinCascade === 'function') slotsPlayCoinCascade(true);
  } else if(totalDelta > 0){
    outcomeEl.style.color = '';
    outcomeEl.classList.add('bj-outcome-pop');
    bjPlayChime(true);
    if(typeof slotsPlayCoinCascade === 'function') slotsPlayCoinCascade(false);
    bjLaunchConfetti(outcomeEl, 20);
    panelEl.classList.remove('pc-flash-gold'); void panelEl.offsetWidth; panelEl.classList.add('pc-flash-gold');
    setTimeout(() => panelEl.classList.remove('pc-flash-gold'), 700);
  } else {
    outcomeEl.style.color = 'var(--loss)';
    outcomeEl.classList.add('bj-outcome-pop');
    bjPlayChime(false);
    panelEl.classList.add('pc-shake'); setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
  }

  if(totalDelta > 0){
    // Offered instead of immediately awarding the win — collecting (or
    // busting) in the gamble screen is what actually credits it, same
    // pattern Slots' own gamble feature already uses.
    vpOfferGamble(totalDelta);
  } else if(totalDelta < 0){
    await awardXP(totalDelta, 'Video Poker loss', { silent: true });
    const bal = await getXPBalance();
    updateXPBalanceDisplay(bal);
  }

  vpStage = 'idle';
  document.getElementById('vpDrawBtn').disabled = false;
  document.getElementById('vpDrawBtn').style.display = 'none';
  document.getElementById('vpDealBtn').disabled = false;
  document.getElementById('vpDealBtn').style.display = 'inline-block';
  document.getElementById('vpChipRail').style.pointerEvents = '';
  document.getElementById('vpChipRail').style.opacity = '';
  document.querySelectorAll('#vpHandCountRow .craps-winmode-btn').forEach(b => { b.disabled = false; });
  vpLastBet = amount;
  document.getElementById('vpSameBetBtn').disabled = false;
}
document.getElementById('vpDealBtn').addEventListener('click', vpDeal);
document.getElementById('vpSameBetBtn').addEventListener('click', () => {
  if(!vpLastBet) return;
  const betInput = document.getElementById('vpBetInput');
  betInput.value = vpLastBet;
  betInput.dispatchEvent(new Event('input'));
  bjPlayChipSound();
});
document.getElementById('vpDrawBtn').addEventListener('click', vpDraw);
document.getElementById('vpBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('vpChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
  vpUpdateTotalBetHint();
});
// Click the chip to type any custom amount — same pattern Mines already
// uses (minesChipDisplay), added here per request. No round-active guard
// needed: unlike Mines, this bet input was never locked/disabled mid-hand
// in the first place, so this is exactly as free to edit as it already
// was via the number input itself.
document.getElementById('vpChipDisplay').addEventListener('click', async () => {
  const input = document.getElementById('vpBetInput');
  const amount = await openChipAmountModal(input.value || '50', 'Bet amount (XP)');
  if(amount == null) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
});

// ================= /Casino / XP system =================

async function checkForUpdate(){

  try{
    const res = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
    const data = await res.json();
    if(data.version && data.version !== APP_VERSION){ showUpdateBanner(); return; }
    // Deployed version matches what's running here — safe to show its
    // changelog if this device hasn't acknowledged it yet.
    maybeShowChangelogBanner(data);
  }catch(e){}
}
checkForUpdate();
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') checkForUpdate(); });
setInterval(checkForUpdate, 45000);

const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i;

function escapeHtml(str){
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
}
function polishedEmptyState(icon, message, cta){
  return `<div class="empty-state">
    <div class="empty-state-icon">${icon}</div>
    <div class="empty-state-msg">${message}</div>
    ${cta ? `<div class="empty-state-cta">${escapeHtml(cta)}</div>` : ''}
  </div>`;
}
function fmtMoney(n){
  const v = Number(n) || 0;
  const sign = v > 0 ? '+' : (v < 0 ? '-' : '');
  return sign + '$' + Math.abs(v).toFixed(2);
}
function animateValue(id, newVal, formatFn){
  const el = document.getElementById(id);
  if(!el) return;
  const startVal = (el._rawVal != null) ? el._rawVal : newVal;
  el._rawVal = newVal;
  if(el._animId) cancelAnimationFrame(el._animId);
  if(Math.abs(startVal - newVal) < 0.005){ el.textContent = formatFn(newVal); return; }
  const duration = 700;
  const t0 = performance.now();
  function tick(now){
    const t = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = formatFn(startVal + (newVal - startVal) * eased);
    if(t < 1){ el._animId = requestAnimationFrame(tick); }
    else{
      el._animId = null;
      el.classList.remove('value-pulse');
      void el.offsetWidth;
      el.classList.add('value-pulse');
    }
  }
  el._animId = requestAnimationFrame(tick);
}

// ---- Double or Nothing — classic video poker feature, mirroring the
// proven structure of Slots' own gamble feature closely (same card-face
// element pattern, same round cap reasoning) rather than reinventing it,
// but as its own dedicated implementation since mixing state between
// two different games' gamble systems risks real bugs.
let vpGamblePot = 0;
let vpGambleRound = 0;
let vpGambleBusy = false;
const VP_GAMBLE_MAX_ROUNDS = 5;
function vpOfferGamble(winAmount){
  vpGamblePot = winAmount;
  vpGambleRound = 0;
  vpGambleBusy = false;
  const betPanel = document.getElementById('vpBetPanel');
  const gambleArea = document.getElementById('vpGambleArea');
  if(betPanel) betPanel.style.display = 'none';
  if(gambleArea) gambleArea.style.display = 'block';
  document.getElementById('vpGambleCardFace').textContent = '';
  vpGambleUpdateDisplay();
  vpGambleSetButtonsDisabled(false);
}
function vpGambleUpdateDisplay(){
  document.getElementById('vpGamblePotVal').textContent = vpGamblePot.toLocaleString();
  const hintEl = document.getElementById('vpGambleRoundHint');
  if(hintEl){
    hintEl.textContent = vpGambleRound >= VP_GAMBLE_MAX_ROUNDS
      ? 'Max streak reached — collect to bank it'
      : `Round ${vpGambleRound + 1} of ${VP_GAMBLE_MAX_ROUNDS}`;
  }
}
function vpGambleSetButtonsDisabled(disabled){
  const redBtn = document.getElementById('vpGambleRedBtn');
  const blackBtn = document.getElementById('vpGambleBlackBtn');
  const collectBtn = document.getElementById('vpGambleCollectBtn');
  if(redBtn) redBtn.disabled = disabled;
  if(blackBtn) blackBtn.disabled = disabled;
  if(collectBtn) collectBtn.disabled = disabled;
  const atCap = vpGambleRound >= VP_GAMBLE_MAX_ROUNDS;
  if(redBtn) redBtn.style.display = atCap ? 'none' : '';
  if(blackBtn) blackBtn.style.display = atCap ? 'none' : '';
}
async function vpGambleGuess(color){
  if(vpGambleBusy) return;
  vpGambleBusy = true;
  vpGambleSetButtonsDisabled(true);
  const statusEl = document.getElementById('vpGambleStatus');
  if(statusEl) statusEl.textContent = '';
  const cardEl = document.getElementById('vpGambleCard');
  const faceEl = document.getElementById('vpGambleCardFace');
  const isRed = Math.random() < 0.5;
  const actualColor = isRed ? 'red' : 'black';
  const won = color === actualColor;
  const suit = isRed ? (Math.random() < 0.5 ? '♥' : '♦') : (Math.random() < 0.5 ? '♠' : '♣');
  cardEl.classList.remove('slots-gamble-flip'); void cardEl.offsetWidth; cardEl.classList.add('slots-gamble-flip');
  bjPlayChipSound();
  await bjWait(600);
  faceEl.textContent = suit;
  faceEl.style.color = isRed ? '#e05a4e' : 'var(--chalk)';
  const panelEl = document.getElementById('casinoGameVideoPoker');
  if(won){
    vpGamblePot *= 2;
    vpGambleRound++;
    vpGambleUpdateDisplay();
    bjPlayChime(true);
    panelEl.classList.remove('pc-flash-gold'); void panelEl.offsetWidth; panelEl.classList.add('pc-flash-gold');
    setTimeout(() => panelEl.classList.remove('pc-flash-gold'), 700);
    if(statusEl) statusEl.textContent = `Correct! Doubled to ${vpGamblePot.toLocaleString()} XP.`;
    vpGambleBusy = false;
    vpGambleSetButtonsDisabled(false);
  } else {
    bjPlayChime(false);
    panelEl.classList.add('pc-shake'); setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
    if(statusEl) statusEl.textContent = `Wrong — lost the lot.`;
    vpGamblePot = 0;
    await bjWait(900);
    await vpGambleClose();
  }
}
async function vpGambleCollect(){
  if(vpGambleBusy) return;
  vpGambleBusy = true;
  vpGambleSetButtonsDisabled(true);
  const statusEl = document.getElementById('vpGambleStatus');
  if(statusEl) statusEl.textContent = '';
  try{
    if(vpGamblePot > 0){
      await awardXP(vpGamblePot, 'Video Poker gamble collect', { silent: true });
    }
    await vpGambleClose(); // clears vpGambleBusy on success
  }catch(e){
    console.error('Video Poker gamble collect failed:', e);
    if(statusEl) statusEl.textContent = 'Could not collect — check your connection and try again.';
    vpGambleBusy = false;
    vpGambleSetButtonsDisabled(false);
  }
}
async function vpGambleClose(){
  const gambleArea = document.getElementById('vpGambleArea');
  const betPanel = document.getElementById('vpBetPanel');
  if(gambleArea) gambleArea.style.display = 'none';
  if(betPanel) betPanel.style.display = 'block';
  vpGambleBusy = false;
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
}
document.getElementById('vpGambleRedBtn').addEventListener('click', () => vpGambleGuess('red'));
document.getElementById('vpGambleBlackBtn').addEventListener('click', () => vpGambleGuess('black'));
document.getElementById('vpGambleCollectBtn').addEventListener('click', vpGambleCollect);
