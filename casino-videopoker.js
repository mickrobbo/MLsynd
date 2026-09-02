// ---- Video Poker (Tens or Better) ----
const VP_PAYTABLE = [
  { key:'royal',    label:'Royal Flush',      mult:250 },
  { key:'straightf',label:'Straight Flush',   mult:50  },
  { key:'quads',    label:'Four of a Kind',   mult:25  },
  { key:'fullhouse',label:'Full House',       mult:9   },
  { key:'flush',    label:'Flush',            mult:6   },
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
    const delay = willAnimate ? Math.max(0, orderInAnim) * 130 : 0;
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
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; dealBtn.disabled = false; return; }
  if(amount > balance){ errEl.textContent = `You only have ${balance} XP.`; dealBtn.disabled = false; return; }

  vpDeck = bjFreshDeck();
  vpHand = vpDeck.splice(0, 5);
  vpHeld = [false, false, false, false, false];
  vpStage = 'dealt';
  document.getElementById('vpOutcomeMsg').textContent = '';
  vpHighlightPayout(null);
  vpRenderHand(true);
  document.getElementById('vpDealBtn').style.display = 'none';
  document.getElementById('vpDrawBtn').style.display = 'inline-block';
  document.getElementById('vpChipRail').style.pointerEvents = 'none';
  document.getElementById('vpChipRail').style.opacity = '.5';
}
async function vpDraw(){
  const amount = parseInt(document.getElementById('vpBetInput').value, 10) || 0;
  document.getElementById('vpDrawBtn').disabled = true;
  const drawnIdx = vpHeld.map((h, i) => h ? -1 : i).filter(i => i !== -1);
  vpHand = vpHand.map((c, i) => vpHeld[i] ? c : vpDeck.shift());
  vpRenderHand(true, drawnIdx);
  await bjWait(drawnIdx.length * 130 + 250);

  const result = vpEvaluateHand(vpHand);
  const outcomeEl = document.getElementById('vpOutcomeMsg');
  const panelEl = document.getElementById('casinoGameVideoPoker');
  let delta;
  if(result){
    const pay = VP_PAYTABLE.find(p => p.key === result.key);
    delta = amount * pay.mult;
    vpHighlightPayout(result.key);
    outcomeEl.textContent = `${result.label}!  +${delta} XP`;
    outcomeEl.style.color = '';
    const isBigWin = result.key === 'royal' || result.key === 'straightf';
    outcomeEl.classList.add(isBigWin ? 'bj-outcome-jackpot' : 'bj-outcome-pop');
    bjPlayChime(true);
    slotsPlayCoinCascade(isBigWin || result.key === 'quads');
    bjLaunchConfetti(outcomeEl, isBigWin ? 42 : 20);
    panelEl.classList.remove('pc-flash-gold'); void panelEl.offsetWidth; panelEl.classList.add('pc-flash-gold');
    setTimeout(() => panelEl.classList.remove('pc-flash-gold'), 700);
  } else {
    delta = -amount;
    outcomeEl.textContent = `No pair of Tens or better — ${delta} XP`;
    outcomeEl.style.color = 'var(--loss)';
    outcomeEl.classList.add('bj-outcome-pop');
    bjPlayChime(false);
    panelEl.classList.add('pc-shake'); setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
  }
  await awardXP(delta, delta > 0 ? `Video Poker — ${result.label}` : 'Video Poker loss', { silent: true });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();

  vpStage = 'idle';
  document.getElementById('vpDrawBtn').disabled = false;
  document.getElementById('vpDrawBtn').style.display = 'none';
  document.getElementById('vpDealBtn').disabled = false;
  document.getElementById('vpDealBtn').style.display = 'inline-block';
  document.getElementById('vpChipRail').style.pointerEvents = '';
  document.getElementById('vpChipRail').style.opacity = '';
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
});
// Click the chip to type any custom amount — same pattern Mines already
// uses (minesChipDisplay), added here per request. No round-active guard
// needed: unlike Mines, this bet input was never locked/disabled mid-hand
// in the first place, so this is exactly as free to edit as it already
// was via the number input itself.
document.getElementById('vpChipDisplay').addEventListener('click', () => {
  const input = document.getElementById('vpBetInput');
  const entry = prompt('Bet amount (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
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
