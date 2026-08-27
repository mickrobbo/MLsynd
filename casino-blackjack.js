// ---- Blackjack ----
let bjDeck = [], bjPlayerHand = [], bjDealerHand = [], bjCurrentBet = 0, bjHandActive = false;
let bjLastBet = null; // snapshot of the last hand's bet (+ Perfect Pairs), for the Same Bet button
let bjHistory = []; // 'W'/'L'/'P' per completed hand — net result, not per-split-hand
let bjAudioCtx = null;
function bjGetAudioCtx(){
  if(!bjAudioCtx){ try{ bjAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){} }
  if(bjAudioCtx && bjAudioCtx.state === 'suspended'){ bjAudioCtx.resume().catch(() => {}); }
  return bjAudioCtx;
}
// All sounds are synthesized (no audio files to host/serve) — a short
// filtered noise burst for a card flick, a couple of layered high triangle
// blips for a chip click, and a small ascending/descending chime for
// win/lose so the table has real audio feedback without adding assets.
function bjPlayCardSound(){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const dur = 0.07;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.2);
  const noise = ctx.createBufferSource(); noise.buffer = buffer;
  const filter = ctx.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 1400;
  const gain = ctx.createGain(); gain.gain.value = 0.22;
  noise.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  noise.start();
}
function bjPlayChipSound(){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const now = ctx.currentTime;
  [0, 0.05, 0.1].forEach((t, idx) => {
    const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 1900 + idx * 350;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now + t);
    gain.gain.exponentialRampToValueAtTime(0.16, now + t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.1);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now + t); osc.stop(now + t + 0.12);
  });
}
function bjPlayChime(ascending){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const now = ctx.currentTime;
  const notes = ascending ? [523.25, 659.25, 783.99] : [440, 349.23, 293.66];
  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now + idx * 0.1);
    gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.1 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.1 + 0.32);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now + idx * 0.1); osc.stop(now + idx * 0.1 + 0.36);
  });
}
// A descending filtered-noise rattle for the roulette spin — synthesized
// like everything else here, no audio file involved. Frequency sweeps down
// over ~2s to suggest the ball losing momentum, even though the visual
// spin itself runs longer (4.2s) — the sound doesn't need to cover the
// full duration to sell the moment, it just needs to mark the launch.
// A short bright "ding" for side-bet wins (Perfect Pairs / Pairs) — kept
// deliberately distinct from bjPlayChime's fuller 3-note fanfare so a side
// bet hitting doesn't feel like it's duplicating the main hand's own win
// celebration, which still gets the bigger sound a moment later.
function bjPlaySideBetDing(){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 880;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + 0.4);
}
function bjPlaySpinSound(){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const dur = 2.1;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource(); noise.buffer = buffer;
  const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(2200, ctx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.14, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.015, ctx.currentTime + dur);
  noise.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  noise.start(); noise.stop(ctx.currentTime + dur);
}
function bjWait(ms){ return new Promise(res => setTimeout(res, ms)); }

// Lightweight DOM confetti (not canvas) — each piece is a small fixed-position
// div, angled and timed from here, animated purely by the CSS confettiFall
// keyframe. Cheap enough for a mobile browser, self-removing so nothing
// piles up in the DOM across repeated hands.
function bjLaunchConfetti(originEl, count){
  const rect = originEl.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const colors = ['var(--brass)', 'var(--brass-light)', 'var(--win)', '#FFF3C4', '#ffffff'];
  for(let i = 0; i < count; i++){
    const piece = document.createElement('div');
    piece.className = 'bj-confetti-piece';
    const angle = Math.random() * Math.PI * 2;
    const dist = 70 + Math.random() * 170;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist - 70; // biased upward on launch, gravity added below
    piece.style.setProperty('--cx', originX + 'px');
    piece.style.setProperty('--cy', originY + 'px');
    piece.style.setProperty('--tx', (originX + tx) + 'px');
    piece.style.setProperty('--ty', (originY + ty + 240) + 'px'); // falls back down to finish
    piece.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animation = `confettiFall ${0.9 + Math.random() * 0.5}s cubic-bezier(.2,.7,.3,1) ${Math.random() * 0.12}s forwards`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 1800);
  }
}

function bjFreshDeck(){
  const suits = ['♠','♥','♦','♣'];
  const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck = [];
  suits.forEach(s => ranks.forEach(r => deck.push({ rank: r, suit: s })));
  for(let i = deck.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function bjCardValue(card){ return card.rank === 'A' ? 11 : (['J','Q','K'].includes(card.rank) ? 10 : Number(card.rank)); }
function bjHandTotal(hand){
  let total = hand.reduce((s,c) => s + bjCardValue(c), 0);
  let aces = hand.filter(c => c.rank === 'A').length;
  while(total > 21 && aces > 0){ total -= 10; aces--; }
  return total;
}
function bjPipHtml(c){
  return `<div class="pc-pip pc-pip-tl">${c.rank}<span class="pc-suit-mini">${c.suit}</span></div>
    <div class="pc-suit-big">${c.suit}</div>
    <div class="pc-pip pc-pip-br">${c.rank}<span class="pc-suit-mini">${c.suit}</span></div>`;
}
// Renders a batch of cards as already-revealed faces, each staggered with
// its own deal-in animation delay and a card-flick sound timed to match.
function bjRenderCards(hand, animate, delayMs){
  const stagger = delayMs || 130;
  return hand.map((c, i) => {
    const isRed = c.suit === '♥' || c.suit === '♦';
    const delay = animate ? i * stagger : 0;
    if(animate) setTimeout(bjPlayCardSound, delay);
    return `<div class="playing-card ${isRed ? 'pc-red' : 'pc-black'}${animate ? ' pc-dealt' : ''}" style="animation-delay:${delay}ms;">${bjPipHtml(c)}</div>`;
  }).join('');
}
function bjRenderFlipWrap(id, card){
  const isRed = card.suit === '♥' || card.suit === '♦';
  return `<div class="pc-flip-wrap" id="${id}">
    <div class="pc-flip-inner">
      <div class="pc-flip-face pc-flip-front playing-card pc-back"></div>
      <div class="pc-flip-face pc-flip-back playing-card ${isRed ? 'pc-red' : 'pc-black'}">${bjPipHtml(card)}</div>
    </div>
  </div>`;
}
function bjRenderTable(animate){
  document.getElementById('bjPlayerCards').innerHTML = bjRenderCards(bjPlayerHand, animate);
  document.getElementById('bjPlayerTotal').textContent = `Total: ${bjHandTotal(bjPlayerHand)}`;
  // Dealer's up-card shows normally; the hole card is a flip-wrap so the
  // later reveal is a real flip animation, not a swap of DOM content.
  const upCardHtml = bjRenderCards([bjDealerHand[0]], animate);
  const holeCardDelay = animate ? 130 : 0;
  if(animate) setTimeout(bjPlayCardSound, holeCardDelay);
  document.getElementById('bjDealerCards').innerHTML = upCardHtml + bjRenderFlipWrap('bjHoleCardWrap', bjDealerHand[1]);
  document.getElementById('bjDealerTotal').textContent = '';
}
function bjIsRedCard(c){ return c.suit === '♥' || c.suit === '♦'; }
// Perfect Pairs paytable adjusted for a genuine single 52-card deck: a
// same-rank+same-suit "perfect" pair is mathematically impossible here
// (only one of each card exists), so that tier is deliberately left off
// rather than offering a bet that can never pay out. Colored (same rank,
// same colour, different suit) and Mixed (same rank, different colour)
// are both real, achievable outcomes in a single deck.
function bjEvaluatePerfectPairs(hand){
  if(hand.length < 2 || hand[0].rank !== hand[1].rank) return null;
  const sameColor = bjIsRedCard(hand[0]) === bjIsRedCard(hand[1]);
  return sameColor ? { label: 'Colored Pair', mult: 12 } : { label: 'Mixed Pair', mult: 6 };
}

// ---- Split Pairs state ----
// Kept as a parallel [hand0, hand1] track rather than reworking the whole
// game around always-two-hands, since the vast majority of hands are never
// split — bjPlayerHand/bjCurrentBet stay the single-hand source of truth
// until bjSplit() actually runs, at which point bjIsSplit flips on and the
// split-aware branches in bjHit/bjStand/bjResolveHand take over. Simplified
// rule set, stated plainly in the Rules sheet: no re-splitting a split hand
// and no doubling down after a split — every casino varies on both, so
// rather than guess at "the" rule this picks the simplest consistent one.
let bjIsSplit = false;
let bjSplitHands = [[], []];
let bjSplitBets = [0, 0];
let bjSplitHandDone = [false, false];
let bjActiveHandIdx = 0;

let bjStarting = false; // guards a fast double-tap on Deal from starting two hands at once — same bug class fixed in Craps' Roll button
async function bjStartHand(){
  if(bjHandActive || bjStarting) return;
  bjStarting = true;
  const dealBtn = document.getElementById('bjDealBtn');
  if(dealBtn) dealBtn.disabled = true;
  try{
    await bjStartHandInner();
  } finally {
    bjStarting = false;
    if(dealBtn) dealBtn.disabled = false;
  }
}
async function bjStartHandInner(){
  const betInput = document.getElementById('bjBetInput');
  const errEl = document.getElementById('bjBetError');
  errEl.textContent = '';
  const bet = parseInt(betInput.value, 10);
  const ppOn = document.getElementById('bjPerfectPairsCheck').checked;
  const ppBet = parseInt(document.getElementById('bjPerfectPairsAmount').value, 10) || 0;
  const balance = await getXPBalance();
  const totalStake = bet + (ppOn ? ppBet : 0);
  if(!bet || bet < 5){ errEl.textContent = 'Minimum bet is 5 XP.'; return; }
  if(ppOn && ppBet < 5){ errEl.textContent = 'Minimum Perfect Pairs side bet is 5 XP.'; return; }
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(totalStake > balance){ errEl.textContent = `You only have ${balance} XP.`; return; }

  bjPlayChipSound();
  croupierSay('bjCroupierMsg', CROUPIER_LINES.bjShuffle);
  bjCurrentBet = bet;
  bjDeck = bjFreshDeck();
  bjPlayerHand = [bjDeck.pop(), bjDeck.pop()];
  bjDealerHand = [bjDeck.pop(), bjDeck.pop()];
  bjHandActive = true;
  bjIsSplit = false;
  document.getElementById('bjPlayerBox2').style.display = 'none';
  document.getElementById('bjPlayerBox1').classList.remove('active-hand');
  document.getElementById('bjPlayerBox2').classList.remove('active-hand');

  document.getElementById('bjBetPanel').style.display = 'none';
  document.getElementById('bjTableArea').style.display = 'block';
  const outcomeEl = document.getElementById('bjOutcomeMsg');
  outcomeEl.textContent = '';
  outcomeEl.classList.remove('bj-outcome-pop', 'bj-outcome-jackpot');
  const ppOutcomeEl = document.getElementById('bjPPOutcomeMsg');
  ppOutcomeEl.textContent = '';
  const insOutcomeEl = document.getElementById('bjInsuranceOutcomeMsg');
  insOutcomeEl.textContent = '';
  document.getElementById('bjNewHandBtn').style.display = 'none';
  bjRenderTable(true);

  if(ppOn){
    const pp = bjEvaluatePerfectPairs(bjPlayerHand);
    if(pp){
      const win = ppBet * pp.mult;
      ppOutcomeEl.innerHTML = `<span style="color:var(--win); font-weight:700;">${pp.label}! +${win} XP</span>`;
      ppOutcomeEl.classList.remove('bj-outcome-pop'); void ppOutcomeEl.offsetWidth; ppOutcomeEl.classList.add('bj-outcome-pop');
      bjPlaySideBetDing();
      bjLaunchConfetti(ppOutcomeEl, 14);
      await awardXP(win, `Blackjack Perfect Pairs (${pp.label})`, { silent: true });
    } else {
      ppOutcomeEl.innerHTML = `<span style="color:var(--loss);">Perfect Pairs: no pair (-${ppBet} XP)</span>`;
      await awardXP(-ppBet, 'Blackjack Perfect Pairs (no pair)', { silent: true });
    }
    const bal = await getXPBalance();
    updateXPBalanceDisplay(bal);
  }

  // Insurance is offered before the player's first real decision, and only
  // when the dealer's up-card is an Ace — bjOfferInsurance shows/hides the
  // Hit/Stand/Double/Split row itself once the insurance question (and, if
  // the dealer turns out to actually have Blackjack, the whole hand) is
  // resolved, so nothing else needs to branch on it below.
  const dealerShowsAce = bjDealerHand[0].rank === 'A';
  if(dealerShowsAce){
    await bjOfferInsurance();
  } else {
    bjShowPlayDecisionButtons();
    if(bjHandTotal(bjPlayerHand) === 21){ await bjWait(500); await bjResolveHand(); }
  }
}
function bjShowPlayDecisionButtons(){
  document.getElementById('bjHitBtn').style.display = 'inline-block';
  document.getElementById('bjStandBtn').style.display = 'inline-block';
  document.getElementById('bjDoubleBtn').style.display = 'inline-block';
  const canSplit = bjCardValue(bjPlayerHand[0]) === bjCardValue(bjPlayerHand[1]);
  document.getElementById('bjSplitBtn').style.display = canSplit ? 'inline-block' : 'none';
}
// Insurance — a separate side wager costing half the original bet, offered
// once, only when the dealer shows an Ace. Pays 2:1 (net +1x the insurance
// stake) if the dealer turns out to have Blackjack; lost entirely
// otherwise. Either way the normal Hit/Stand/Double/Split flow resumes
// afterward — UNLESS the dealer actually has Blackjack, which ends the
// hand immediately via the same bjResolveHand() every other path uses, so
// the push-if-player-also-has-21 / lose-otherwise logic doesn't need to be
// duplicated here.
function bjOfferInsurance(){
  return new Promise(resolve => {
    const panel = document.getElementById('bjInsurancePanel');
    const costEl = document.getElementById('bjInsuranceCost');
    const insuranceCost = Math.floor(bjCurrentBet / 2);
    costEl.textContent = insuranceCost;
    panel.style.display = 'block';

    const yesBtn = document.getElementById('bjInsuranceYesBtn');
    const noBtn = document.getElementById('bjInsuranceNoBtn');
    const cleanup = () => {
      panel.style.display = 'none';
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
    };
    const onYes = async () => {
      cleanup();
      const balance = await getXPBalance();
      // Checked against balance minus the main bet, not raw balance — the
      // main bet is still fully at risk in this same hand (nothing gets
      // deducted until resolution), so validating Insurance against the
      // full balance let someone take on more than they actually had:
      // lose Insurance, then also lose the main hand, and the two losses
      // together could exceed what they started with.
      if(balance == null || balance < bjCurrentBet + insuranceCost){
        const insEl = document.getElementById('bjInsuranceOutcomeMsg');
        insEl.textContent = 'Not enough XP for Insurance — skipped.';
        insEl.style.color = 'var(--loss)';
        await bjResolveInsuranceOutcome(false, 0);
      } else {
        await bjResolveInsuranceOutcome(true, insuranceCost);
      }
      resolve();
    };
    const onNo = async () => {
      cleanup();
      await bjResolveInsuranceOutcome(false, 0);
      resolve();
    };
    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
  });
}
async function bjResolveInsuranceOutcome(taken, insuranceCost){
  const dealerBJ = bjDealerHand.length === 2 && bjHandTotal(bjDealerHand) === 21;
  // A dedicated message area, separate from bjOutcomeMsg — that element
  // gets overwritten with the main hand's own result the moment
  // bjResolveHand() runs below, which would otherwise silently clobber
  // whatever this function just wrote to it (found via testing: taking
  // insurance against a dealer Blackjack showed only "Lose", the
  // insurance win message never visible at all).
  const insEl = document.getElementById('bjInsuranceOutcomeMsg');
  if(taken){
    if(dealerBJ){
      const win = insuranceCost * 2;
      insEl.textContent = `Dealer has Blackjack — Insurance pays 2:1 (+${win} XP)`;
      insEl.style.color = 'var(--win)';
      await awardXP(win, 'Blackjack Insurance win', { silent: true });
    } else {
      insEl.textContent = `No dealer Blackjack — Insurance lost (-${insuranceCost} XP)`;
      insEl.style.color = 'var(--loss)';
      await awardXP(-insuranceCost, 'Blackjack Insurance lost', { silent: true });
    }
    const bal = await getXPBalance();
    updateXPBalanceDisplay(bal);
    renderXPLog();
  }
  if(dealerBJ){
    await bjWait(400);
    await bjResolveHand();
  } else {
    bjShowPlayDecisionButtons();
    if(bjHandTotal(bjPlayerHand) === 21){ await bjWait(500); await bjResolveHand(); }
  }
}

function bjAppendCardTo(areaId, totalId, hand, card){
  bjPlayCardSound();
  const isRed = card.suit === '♥' || card.suit === '♦';
  const el = document.createElement('div');
  el.className = `playing-card ${isRed ? 'pc-red' : 'pc-black'} pc-dealt`;
  el.innerHTML = bjPipHtml(card);
  document.getElementById(areaId).appendChild(el);
  document.getElementById(totalId).textContent = `Total: ${bjHandTotal(hand)}`;
}

async function bjHit(){
  if(!bjHandActive || bjActionBusy) return;
  document.getElementById('bjDoubleBtn').style.display = 'none'; // doubling is a first-decision-only move
  document.getElementById('bjSplitBtn').style.display = 'none'; // splitting is also first-decision-only
  if(bjIsSplit){
    const hand = bjSplitHands[bjActiveHandIdx];
    hand.push(bjDeck.pop());
    const areaId = bjActiveHandIdx === 0 ? 'bjPlayerCards' : 'bjPlayerCards2';
    const totalId = bjActiveHandIdx === 0 ? 'bjPlayerTotal' : 'bjPlayerTotal2';
    bjAppendCardTo(areaId, totalId, hand, hand[hand.length - 1]);
    const t = bjHandTotal(hand);
    if(t > 21){ await bjAdvanceOrFinishHand(); }
    else if(t === 21){
      // Auto-stand on a made 21 — but that's a real ~450ms window where
      // Hit/Stand are still sitting there tappable before the auto-resolve
      // actually fires. A second tap on Hit in that gap would otherwise
      // still pass the bjHandActive check (only bjResolveHand/
      // bjAdvanceOrFinishHand clear it) and could sneak an illegal extra
      // card onto an already-made 21 — hide them now, the decision's over.
      document.getElementById('bjHitBtn').style.display = 'none';
      document.getElementById('bjStandBtn').style.display = 'none';
      await bjWait(450); await bjAdvanceOrFinishHand();
    }
  } else {
    bjPlayerHand.push(bjDeck.pop());
    bjAppendCardTo('bjPlayerCards', 'bjPlayerTotal', bjPlayerHand, bjPlayerHand[bjPlayerHand.length - 1]);
    const t = bjHandTotal(bjPlayerHand);
    if(t > 21){ await bjResolveHand(); }
    else if(t === 21){
      // Same reasoning as the split branch above.
      document.getElementById('bjHitBtn').style.display = 'none';
      document.getElementById('bjStandBtn').style.display = 'none';
      await bjWait(450); await bjResolveHand();
    }
  }
}
function bjStand(){
  if(!bjHandActive || bjActionBusy) return;
  if(bjIsSplit) bjAdvanceOrFinishHand();
  else bjResolveHand();
}
// Split-only: the active hand is done (stood/busted) — move to hand 2, or
// if both hands are already finished, go straight to the dealer.
async function bjAdvanceOrFinishHand(){
  bjSplitHandDone[bjActiveHandIdx] = true;
  if(bjActiveHandIdx === 0 && !bjSplitHandDone[1]){
    bjActiveHandIdx = 1;
    document.getElementById('bjPlayerBox1').classList.remove('active-hand');
    document.getElementById('bjPlayerBox2').classList.add('active-hand');
    if(bjHandTotal(bjSplitHands[1]) === 21){ await bjWait(400); await bjAdvanceOrFinishHand(); return; }
  } else {
    await bjResolveHand();
  }
}
// Only ever valid on the very first decision (exactly two cards, nothing
// hit yet) — doubles the bet, takes exactly one more card, then goes
// straight to the dealer's resolution regardless of the result. Not
// offered at all after a split, to keep the split-hand rules simple.
let bjActionBusy = false; // guards Double/Split's balance-check await — same double-tap race class fixed for Deal
async function bjDoubleDown(){
  if(!bjHandActive || bjIsSplit || bjPlayerHand.length !== 2 || bjActionBusy) return;
  bjActionBusy = true;
  try{
    const balance = await getXPBalance();
    // Checked against double the current bet, not just the extra half —
    // the original bet is still fully at risk in this same hand, so
    // doubling needs balance for BOTH the amount already at risk and the
    // matching amount being added, or a loss could take someone negative.
    if(balance == null || balance < bjCurrentBet * 2){
      const errEl = document.getElementById('bjOutcomeMsg');
      errEl.textContent = 'Not enough XP to double down.';
      errEl.style.color = 'var(--loss)';
      return;
    }
    document.getElementById('bjDoubleBtn').style.display = 'none';
    document.getElementById('bjHitBtn').style.display = 'none';
    document.getElementById('bjSplitBtn').style.display = 'none';
    bjCurrentBet *= 2;
    bjPlayerHand.push(bjDeck.pop());
    bjAppendCardTo('bjPlayerCards', 'bjPlayerTotal', bjPlayerHand, bjPlayerHand[bjPlayerHand.length - 1]);
    await bjWait(500);
    bjResolveHand();
  } finally {
    bjActionBusy = false;
  }
}
// Splits your first two cards (same rank) into two independent hands, each
// getting one new card immediately and each carrying the same bet as the
// original — so the total at risk doubles, same principle as Double Down.
// You play hand 1 to completion (Hit/Stand) before hand 2 unlocks; the
// dealer then plays once and is compared against both hands separately.
async function bjSplit(){
  if(!bjHandActive || bjIsSplit || bjPlayerHand.length !== 2 || bjCardValue(bjPlayerHand[0]) !== bjCardValue(bjPlayerHand[1]) || bjActionBusy) return;
  bjActionBusy = true;
  try{
    const balance = await getXPBalance();
    // Same reasoning as Double Down — the original bet is still fully at
    // risk, and the second hand needs a matching bet of its own, so this
    // needs balance for both, not just one more bjCurrentBet on top of an
    // already-spent-looking balance.
    if(balance == null || balance < bjCurrentBet * 2){
      const errEl = document.getElementById('bjOutcomeMsg');
      errEl.textContent = 'Not enough XP to split.';
      errEl.style.color = 'var(--loss)';
      return;
    }
    bjPlayChipSound();
    document.getElementById('bjSplitBtn').style.display = 'none';
    document.getElementById('bjDoubleBtn').style.display = 'none';

    bjIsSplit = true;
    bjSplitBets = [bjCurrentBet, bjCurrentBet];
    bjSplitHandDone = [false, false];
    bjActiveHandIdx = 0;
    bjSplitHands = [
      [bjPlayerHand[0], bjDeck.pop()],
      [bjPlayerHand[1], bjDeck.pop()]
    ];

    document.getElementById('bjPlayerBox2').style.display = 'block';
    document.getElementById('bjPlayerBox1').classList.add('active-hand');
    document.getElementById('bjPlayerCards').innerHTML = bjRenderCards(bjSplitHands[0], true);
    document.getElementById('bjPlayerTotal').textContent = `Total: ${bjHandTotal(bjSplitHands[0])}`;
    document.getElementById('bjPlayerCards2').innerHTML = bjRenderCards(bjSplitHands[1], true);
    document.getElementById('bjPlayerTotal2').textContent = `Total: ${bjHandTotal(bjSplitHands[1])}`;

    if(bjHandTotal(bjSplitHands[0]) === 21){ await bjWait(500); await bjAdvanceOrFinishHand(); }
  } finally {
    bjActionBusy = false;
  }
}
function bjRenderHistory(){
  const el = document.getElementById('bjHistory');
  if(!el) return;
  el.innerHTML = bjHistory.slice(-10).reverse().map(r => {
    const bg = r === 'W' ? 'var(--win)' : (r === 'L' ? 'var(--loss)' : 'rgb(91,141,190)');
    return `<div class="roulette-history-chip" style="background:${bg};">${r}</div>`;
  }).join('');
}
async function bjResolveHand(){
  bjHandActive = false;
  document.getElementById('bjHitBtn').style.display = 'none';
  document.getElementById('bjStandBtn').style.display = 'none';
  document.getElementById('bjDoubleBtn').style.display = 'none';
  document.getElementById('bjSplitBtn').style.display = 'none';
  document.getElementById('bjPlayerBox1').classList.remove('active-hand');
  document.getElementById('bjPlayerBox2').classList.remove('active-hand');

  const hands = bjIsSplit ? bjSplitHands : [bjPlayerHand];
  const bets = bjIsSplit ? bjSplitBets : [bjCurrentBet];
  const anyHandNeedsDealer = hands.some(h => bjHandTotal(h) <= 21);

  bjPlayCardSound();
  const flipWrap = document.getElementById('bjHoleCardWrap');
  if(flipWrap) flipWrap.classList.add('pc-flipped');
  await bjWait(600);
  document.getElementById('bjDealerTotal').textContent = `Total: ${bjHandTotal(bjDealerHand)}`;

  if(anyHandNeedsDealer){
    const dealerArea = document.getElementById('bjDealerCards');
    while(bjHandTotal(bjDealerHand) < 17){
      const c = bjDeck.pop();
      bjDealerHand.push(c);
      bjPlayCardSound();
      const isRed = c.suit === '♥' || c.suit === '♦';
      const card = document.createElement('div');
      card.className = `playing-card ${isRed ? 'pc-red' : 'pc-black'} pc-dealt`;
      card.innerHTML = bjPipHtml(c);
      dealerArea.appendChild(card);
      document.getElementById('bjDealerTotal').textContent = `Total: ${bjHandTotal(bjDealerHand)}`;
      await bjWait(450);
    }
  }

  const dealerTotal = bjHandTotal(bjDealerHand);
  const dealerBJ = bjDealerHand.length === 2 && dealerTotal === 21;
  let totalDelta = 0;
  let isJackpot = false;
  const parts = hands.map((hand, i) => {
    const playerTotal = bjHandTotal(hand);
    const bet = bets[i];
    // A hand reached via split never counts as a "natural" Blackjack even
    // if it lands on 21 with two cards — standard casino rule, since the
    // pair that got split was never a natural two-card 21 to begin with.
    const playerBJ = !bjIsSplit && hand.length === 2 && playerTotal === 21;
    let outcome, delta;
    if(playerTotal > 21){ outcome = 'Bust'; delta = -bet; }
    else if(playerBJ && !dealerBJ){ outcome = 'Blackjack! 3:2'; delta = Math.floor(bet * 1.5); isJackpot = true; }
    // A dealer's NATURAL blackjack beats any non-blackjack hand outright —
    // including a hard/soft 21 reached by hitting, which is otherwise the
    // same numeric total. Without this check, that exact matchup fell
    // through to the playerTotal === dealerTotal branch below and
    // incorrectly resolved as a push instead of a loss.
    else if(dealerBJ && !playerBJ){ outcome = 'Dealer blackjack \u2014 lose'; delta = -bet; }
    else if(dealerTotal > 21){ outcome = 'Dealer busts \u2014 win'; delta = bet; }
    else if(playerTotal > dealerTotal){ outcome = 'Win'; delta = bet; }
    else if(playerTotal === dealerTotal){ outcome = 'Push'; delta = 0; }
    else { outcome = 'Lose'; delta = -bet; }
    totalDelta += delta;
    // Colour is driven by delta, not the outcome label text, so it can't
    // drift out of sync with a new outcome string later — win green, loss
    // red (same --loss token as a Bust), push the same blue already used
    // for a Void result on the tipping ladder, for a consistent app-wide
    // meaning rather than inventing a new colour just for this screen.
    const color = delta > 0 ? 'var(--win)' : (delta < 0 ? 'var(--loss)' : 'rgb(91,141,190)');
    const label = bjIsSplit ? `Hand ${i + 1}: ${outcome} (${delta >= 0 ? '+' : ''}${delta})` : `${outcome} (${delta >= 0 ? '+' : ''}${delta} XP)`;
    return { label, color };
  });

  const outcomeEl = document.getElementById('bjOutcomeMsg');
  if(bjIsSplit){
    const totalColor = totalDelta > 0 ? 'var(--win)' : (totalDelta < 0 ? 'var(--loss)' : 'rgb(91,141,190)');
    outcomeEl.innerHTML = parts.map(p => `<span style="color:${p.color};">${escapeHtml(p.label)}</span>`).join('  <span style="color:var(--muted);">\u00b7</span>  ')
      + `  <span style="color:var(--muted);">\u2014</span>  <span style="color:${totalColor};">Total: ${totalDelta >= 0 ? '+' : ''}${totalDelta} XP</span>`;
    outcomeEl.style.color = '';
  } else {
    outcomeEl.textContent = parts[0].label;
    outcomeEl.style.color = isJackpot ? '' : parts[0].color;
  }
  outcomeEl.classList.remove('bj-outcome-pop', 'bj-outcome-jackpot');
  void outcomeEl.offsetWidth;
  outcomeEl.classList.add(isJackpot ? 'bj-outcome-jackpot' : 'bj-outcome-pop');
  document.getElementById('bjNewHandBtn').style.display = 'inline-block';
  // Snapshot the bet just played (main bet + Perfect Pairs, if it was on)
  // so Same Bet can restore the whole combo in one tap next hand, rather
  // than the player having to re-toggle the side bet and re-set its
  // amount by hand.
  bjLastBet = { amount: bjCurrentBet, ppOn: document.getElementById('bjPerfectPairsCheck').checked, ppAmount: parseInt(document.getElementById('bjPerfectPairsAmount').value, 10) || 0 };
  document.getElementById('bjSameBetBtn').disabled = false;

  bjHistory.push(totalDelta > 0 ? 'W' : (totalDelta < 0 ? 'L' : 'P'));
  bjRenderHistory();
  const bjLine0 = parts[0].label;
  if(bjLine0.startsWith('Blackjack')) croupierSay('bjCroupierMsg', CROUPIER_LINES.bjBlackjack);
  else if(bjLine0.startsWith('Bust')) croupierSay('bjCroupierMsg', CROUPIER_LINES.bjBust);
  else if(bjLine0.startsWith('Dealer busts')) croupierSay('bjCroupierMsg', CROUPIER_LINES.bjDealerBust);
  else if(bjLine0.startsWith('Push')) croupierSay('bjCroupierMsg', CROUPIER_LINES.bjPush);
  else if(totalDelta > 0) croupierSay('bjCroupierMsg', CROUPIER_LINES.bjWin);
  else if(totalDelta < 0) croupierSay('bjCroupierMsg', CROUPIER_LINES.bjLoss);

  const tableEl = document.getElementById('bjTableArea');
  if(totalDelta > 0){
    bjPlayChime(true);
    tableEl.classList.remove('pc-flash-gold'); void tableEl.offsetWidth; tableEl.classList.add('pc-flash-gold');
    bjLaunchConfetti(outcomeEl, isJackpot ? 42 : 22);
    setTimeout(() => tableEl.classList.remove('pc-flash-gold'), 700);
  } else if(totalDelta < 0){
    bjPlayChime(false);
    tableEl.classList.remove('pc-shake', 'pc-flash-red'); void tableEl.offsetWidth; tableEl.classList.add('pc-shake', 'pc-flash-red');
    setTimeout(() => tableEl.classList.remove('pc-shake', 'pc-flash-red'), 700);
  }

  if(totalDelta !== 0) await awardXP(totalDelta, totalDelta > 0 ? 'Blackjack win' : 'Blackjack loss', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
}
function bjNewHand(){
  document.getElementById('bjBetPanel').style.display = 'block';
  document.getElementById('bjTableArea').style.display = 'none';
  document.getElementById('bjPlayerBox2').style.display = 'none';
}
document.getElementById('bjBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('bjChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse');
  void chip.offsetWidth;
  chip.classList.add('pc-chip-pulse');
});
document.getElementById('bjDealBtn').addEventListener('click', bjStartHand);
// Restores the exact bet + Perfect Pairs combo from the last hand in one
// tap — sets the input values and simulates the real toggle click rather
// than just flipping the checkbox, so the pill's own active styling and
// the amount row's visibility stay in sync the same way they would from
// a real tap.
document.getElementById('bjSameBetBtn').addEventListener('click', () => {
  if(!bjLastBet) return;
  const betInput = document.getElementById('bjBetInput');
  betInput.value = bjLastBet.amount;
  betInput.dispatchEvent(new Event('input'));
  const ppCheck = document.getElementById('bjPerfectPairsCheck');
  if(ppCheck.checked !== bjLastBet.ppOn) document.getElementById('bjPerfectPairsToggle').click();
  if(bjLastBet.ppOn){
    const ppInput = document.getElementById('bjPerfectPairsAmount');
    ppInput.value = bjLastBet.ppAmount;
    ppInput.dispatchEvent(new Event('input'));
  }
  bjPlayChipSound();
});
document.getElementById('bjHitBtn').addEventListener('click', bjHit);
document.getElementById('bjDoubleBtn').addEventListener('click', bjDoubleDown);
document.getElementById('bjSplitBtn').addEventListener('click', bjSplit);
document.getElementById('bjStandBtn').addEventListener('click', bjStand);
document.getElementById('bjNewHandBtn').addEventListener('click', bjNewHand);
