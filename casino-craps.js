// ---- Craps (full table: Pass/Don't Pass, Odds, Come/Don't Come, Place,
// Field, Hardways, one-roll Props) ----
// State model: "live" bets are already riding from a previous roll (the
// balance was never touched for them — same house style as every other
// game here, XP only moves via awardXP at actual resolution, not at
// staking time). "Staged" bets are new chips placed since the last roll
// that haven't been rolled for yet. Roll() commits staged into live (or
// resolves it immediately, same rules either way), then resolves
// everything live against the new total, and finally nets out ONE
// awardXP call for the whole roll — mirrors Roulette's "stake several
// spots, one net settle" pattern rather than a payout call per bet type.
let crapsBuilt = false;
let crapsWinMode = 'takedown'; // 'takedown' | 'ride' | 'press' — applies to Place & Hardway wins from here on
let crapsPoint = null; // null (come-out) or 4/5/6/8/9/10
let crapsLive = { pass: 0, dontpass: 0 };
let crapsPassOdds = 0, crapsDontPassOdds = 0; // odds riding behind the Pass/Don't Pass line — only ever live while a point's on
let crapsComePoints = {};      // { [num]: amount } — Come bets already assigned a point
let crapsDontComePoints = {};  // { [num]: amount } — Don't Come bets already assigned a point
let crapsPlace = { 4: 0, 5: 0, 6: 0, 8: 0, 9: 0, 10: 0 };   // Place bets — live across rolls until it hits or a 7 shows
let crapsHardway = { 4: 0, 6: 0, 8: 0, 10: 0 };             // Hardway bets — live across rolls until hard/easy/7
let crapsStaged = {
  pass: 0, dontpass: 0, come: 0, dontcome: 0, field: 0, passodds: 0, dontpassodds: 0,
  place: { 4: 0, 5: 0, 6: 0, 8: 0, 9: 0, 10: 0 }, hardway: { 4: 0, 6: 0, 8: 0, 10: 0 },
  prop: { any7: 0, anycraps: 0, 2: 0, 3: 0, 11: 0, 12: 0 }
};
const CRAPS_FIELD_PAYOUT = { 2: 2, 3: 1, 4: 1, 9: 1, 10: 1, 11: 1, 12: 3 };
// True odds — no house edge on any of these, same math a real table uses.
const CRAPS_PASS_ODDS_MULT = { 4: 2, 5: 1.5, 6: 1.2, 8: 1.2, 9: 1.5, 10: 2 };
const CRAPS_DONTPASS_ODDS_MULT = { 4: 0.5, 5: 2 / 3, 6: 5 / 6, 8: 5 / 6, 9: 2 / 3, 10: 0.5 };
const CRAPS_PLACE_MULT = { 4: 9 / 5, 5: 7 / 5, 6: 7 / 6, 8: 7 / 6, 9: 7 / 5, 10: 9 / 5 };
const CRAPS_HARDWAY_MULT = { 4: 7, 6: 9, 8: 9, 10: 7 };
const CRAPS_PROP_MULT = { any7: 4, anycraps: 7, 2: 30, 3: 15, 11: 15, 12: 30 };
function crapsSumObj(o){ return Object.values(o).reduce((s, v) => s + v, 0); }
function crapsSumStaged(){
  return crapsStaged.pass + crapsStaged.dontpass + crapsStaged.come + crapsStaged.dontcome + crapsStaged.field
    + crapsStaged.passodds + crapsStaged.dontpassodds + crapsSumObj(crapsStaged.place) + crapsSumObj(crapsStaged.hardway) + crapsSumObj(crapsStaged.prop);
}
function crapsTotalAtRisk(){
  const comeSum = crapsSumObj(crapsComePoints);
  const dontComeSum = crapsSumObj(crapsDontComePoints);
  return crapsLive.pass + crapsLive.dontpass + crapsPassOdds + crapsDontPassOdds + comeSum + dontComeSum
    + crapsSumObj(crapsPlace) + crapsSumObj(crapsHardway) + crapsSumStaged();
}
let crapsHistory = []; // recent roll totals, coloured by what they meant (natural/point/craps/seven-out)
function crapsRenderHistory(){
  const el = document.getElementById('crapsHistory');
  el.innerHTML = crapsHistory.slice(-12).reverse().map(h => {
    const bg = h.kind === 'sevenout' ? '#8c2a22' : (h.kind === 'point' ? '#1f7a4a' : '#3a3a3a');
    return `<div class="craps-history-chip" style="background:${bg};">${h.total}</div>`;
  }).join('');
}
function crapsInit(){
  crapsBuilt = true;
  crapsRenderBetSpots();
  crapsBuildDieCube('crapsDie1');
  crapsBuildDieCube('crapsDie2');
  crapsSetFrontFace('crapsDie1', 1);
  crapsSetFrontFace('crapsDie2', 1);
  document.getElementById('crapsTotalMsg').textContent = '';
}
function crapsRenderPuck(){
  const puck = document.getElementById('crapsPuck');
  if(crapsPoint == null){ puck.textContent = 'OFF'; puck.classList.remove('on'); puck.classList.add('off'); }
  else { puck.textContent = crapsPoint; puck.classList.remove('off'); puck.classList.add('on'); }
  // Pass/Don't Pass only placeable pre-point; Odds only once a matching
  // line bet is already riding; Come/Don't Come only once the point's on
  // — mirrors a real table's puck-driven betting windows. Place, Hardway
  // and Props work anytime, so they're never toggled here.
  document.querySelectorAll('#crapsBetGrid [data-craps-bet="pass"], #crapsBetGrid [data-craps-bet="dontpass"]').forEach(el => {
    el.classList.toggle('disabled', crapsPoint != null || crapsLive.pass > 0 || crapsLive.dontpass > 0);
  });
  document.querySelector('#crapsBetGrid [data-craps-bet="passodds"]').classList.toggle('disabled', !(crapsPoint != null && crapsLive.pass > 0));
  document.querySelector('#crapsBetGrid [data-craps-bet="dontpassodds"]').classList.toggle('disabled', !(crapsPoint != null && crapsLive.dontpass > 0));
  document.querySelectorAll('#crapsBetGrid [data-craps-bet="come"], #crapsBetGrid [data-craps-bet="dontcome"]').forEach(el => {
    el.classList.toggle('disabled', crapsPoint == null);
  });
}
function crapsDiePipLayout(n){
  // 3x3 pip grid, classic die-face layouts, indices 0-8 (row-major)
  const layouts = {
    1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
  };
  const on = new Set(layouts[n] || []);
  return Array.from({ length: 9 }, (_, i) => `<div class="craps-die-pip${on.has(i) ? ' on' : ''}"></div>`).join('');
}
// Builds the actual 6-face cube once per die (front/back/left/right/top/
// bottom, real translateZ geometry — see the .craps-die-face-* CSS). Only
// the front face is ever authoritative; the other 5 get fixed decorative
// pip counts (a valid opposite-faces-sum-7 arrangement built around
// front=1) purely so the cube reads as solid mid-tumble.
function crapsBuildDieCube(dieId){
  const die = document.getElementById(dieId);
  if(!die || die.querySelector('.craps-die-cube')) return; // already built
  const faceDefs = [['front', 1], ['back', 6], ['right', 2], ['left', 5], ['top', 3], ['bottom', 4]];
  die.innerHTML = `<div class="craps-die-cube">${
    faceDefs.map(([name, n]) => `<div class="craps-die-face craps-die-face-${name}">${crapsDiePipLayout(n)}</div>`).join('')
  }</div>`;
}
function crapsSetFrontFace(dieId, n){
  const front = document.querySelector(`#${dieId} .craps-die-face-front`);
  if(front) front.innerHTML = crapsDiePipLayout(n);
}
// A real toss: the CSS tumble (genuine 3D cube rotation + bounce, see
// .craps-die-cube.tumbling) runs for its own duration while the FRONT
// face's pips flicker through random values every ~70ms, landing on the
// true result only right at the end — same "reveal only at the last
// moment" feel as the roulette ball's spin rather than an instant number
// swap. The cube's own rotation is purely decorative motion; correctness
// always comes from the front face's content, set directly.
async function crapsAnimateRoll(finalA, finalB){
  const c1 = document.querySelector('#crapsDie1 .craps-die-cube'), c2 = document.querySelector('#crapsDie2 .craps-die-cube');
  [c1, c2].forEach(c => { c.classList.remove('tumbling'); void c.offsetWidth; c.classList.add('tumbling'); });
  const stepMs = 70, totalFlickerMs = 1680;
  const steps = Math.floor(totalFlickerMs / stepMs);
  for(let i = 0; i < steps; i++){
    crapsSetFrontFace('crapsDie1', 1 + Math.floor(Math.random() * 6));
    crapsSetFrontFace('crapsDie2', 1 + Math.floor(Math.random() * 6));
    await bjWait(stepMs);
  }
  crapsSetFrontFace('crapsDie1', finalA);
  crapsSetFrontFace('crapsDie2', finalB);
  await bjWait(420); // let the tumble's own settle tail finish before anything reads the result — 1680 + 420 = 2.1s total, matching the CSS tumble duration
  [c1, c2].forEach(c => c.classList.remove('tumbling'));
}
function crapsFmtChip(n){ return n >= 1000 ? (n % 1000 === 0 ? (n / 1000) + 'k' : (n / 1000).toFixed(1) + 'k') : String(n); }
// Generic setter — handles both simple spots (key === amt-id, e.g. "pass")
// and per-number spots (amt-id is "place-4", live/staged looked up by
// number within the relevant object). Renders actual chip-pill tokens
// (a solid gold "live" chip already riding, a dashed ghost "+N" chip for
// this round's not-yet-rolled stake) instead of a plain text line — the
// ghost chip doubles as a per-spot "remove this new bet" control, wired
// once via delegation in the click handler below.
function crapsSetSpotAmt(amtKey, spotSelector, live, staged){
  const el = document.querySelector(`[data-amt="${amtKey}"]`);
  const spot = document.querySelector(spotSelector);
  if(!el || !spot) return;
  const total = live + staged;
  let html = '';
  if(live > 0) html += `<span class="craps-chip-pill craps-chip-live">${crapsFmtChip(live)}</span>`;
  if(staged > 0) html += `<span class="craps-chip-pill craps-chip-new" data-clear-key="${amtKey}" title="Remove this bet">+${crapsFmtChip(staged)} ✕</span>`;
  el.innerHTML = html;
  spot.classList.toggle('has-live', total > 0);
}
function crapsRenderBetSpots(){
  crapsSetSpotAmt('pass', '[data-craps-bet="pass"]', crapsLive.pass, crapsStaged.pass);
  crapsSetSpotAmt('dontpass', '[data-craps-bet="dontpass"]', crapsLive.dontpass, crapsStaged.dontpass);
  crapsSetSpotAmt('passodds', '[data-craps-bet="passodds"]', crapsPassOdds, crapsStaged.passodds);
  crapsSetSpotAmt('dontpassodds', '[data-craps-bet="dontpassodds"]', crapsDontPassOdds, crapsStaged.dontpassodds);
  const comeSum = crapsSumObj(crapsComePoints);
  const dontComeSum = crapsSumObj(crapsDontComePoints);
  crapsSetSpotAmt('come', '[data-craps-bet="come"]', comeSum, crapsStaged.come);
  crapsSetSpotAmt('dontcome', '[data-craps-bet="dontcome"]', dontComeSum, crapsStaged.dontcome);
  crapsSetSpotAmt('field', '[data-craps-bet="field"]', 0, crapsStaged.field);
  [4, 5, 6, 8, 9, 10].forEach(n => {
    crapsSetSpotAmt(`place-${n}`, `[data-craps-bet="place"][data-craps-num="${n}"]`, crapsPlace[n], crapsStaged.place[n]);
  });
  [4, 6, 8, 10].forEach(n => {
    crapsSetSpotAmt(`hardway-${n}`, `[data-craps-bet="hardway"][data-craps-num="${n}"]`, crapsHardway[n], crapsStaged.hardway[n]);
  });
  ['any7', 'anycraps', 2, 3, 11, 12].forEach(k => {
    crapsSetSpotAmt(`prop-${k}`, `[data-craps-bet="prop"][data-craps-num="${k}"]`, 0, crapsStaged.prop[k]);
  });

  const liveBits = [];
  Object.entries(crapsComePoints).forEach(([n, amt]) => liveBits.push(`Come (${n}): ${amt.toLocaleString()}`));
  Object.entries(crapsDontComePoints).forEach(([n, amt]) => liveBits.push(`Don't Come (${n}): ${amt.toLocaleString()}`));
  Object.entries(crapsPlace).forEach(([n, amt]) => { if(amt > 0) liveBits.push(`Place ${n}: ${amt.toLocaleString()}`); });
  Object.entries(crapsHardway).forEach(([n, amt]) => { if(amt > 0) liveBits.push(`Hard ${n}: ${amt.toLocaleString()}`); });
  document.getElementById('crapsLiveSummary').textContent = liveBits.join('  ·  ');
  crapsRenderPuck();
}
// Single delegated handler across all four bet sections — reads the bet
// type from data-craps-bet and (for Place/Hardway/Prop) the specific
// number from data-craps-num, so one listener covers every spot on the
// table instead of one per bet type.
document.querySelectorAll('#crapsBetGrid .craps-bet-spot, #crapsPlaceGrid .craps-place-spot, #crapsHardwayGrid .craps-hardway-spot, .craps-props-box .craps-prop-spot').forEach(spot => {
  spot.addEventListener('click', (e) => {
    if(spot.classList.contains('disabled')) return;
    // Tapping a "ghost" (staged-but-not-yet-rolled) chip pill removes just
    // that one bet instead of adding another chip on top of it — checked
    // first since the pill sits inside the spot and the click bubbles up.
    const ghostPill = e.target.closest('.craps-chip-new');
    if(ghostPill){
      const amtKey = ghostPill.dataset.clearKey;
      const [clearType, clearNum] = amtKey.includes('-') ? amtKey.split(/-(.+)/) : [amtKey, null];
      if(clearType === 'place' || clearType === 'hardway' || clearType === 'prop'){
        crapsStaged[clearType][clearNum] = 0;
      } else {
        crapsStaged[clearType] = 0;
      }
      crapsRenderBetSpots();
      bjPlayChipSound();
      return;
    }
    const type = spot.dataset.crapsBet;
    const num = spot.dataset.crapsNum;
    const chip = parseInt(document.getElementById('crapsBetInput').value, 10) || 0;
    if(chip <= 0) return;
    if(type === 'place' || type === 'hardway' || type === 'prop'){
      crapsStaged[type][num] += chip;
    } else {
      crapsStaged[type] += chip;
    }
    crapsRenderBetSpots();
    bjPlayChipSound();
    spot.classList.remove('pc-chip-tap'); void spot.offsetWidth; spot.classList.add('pc-chip-tap');
  });
});
const CRAPS_WINMODE_HINTS = {
  takedown: 'A Place/Hardway win pays out and clears the spot.',
  ride: 'A Place/Hardway win pays out — the bet itself stays working at the same amount.',
  press: "A Place/Hardway win adds straight onto the bet instead of paying out — it grows, still working."
};
document.querySelectorAll('#crapsWinModeRow .craps-winmode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    crapsWinMode = btn.dataset.mode;
    document.querySelectorAll('#crapsWinModeRow .craps-winmode-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('crapsWinModeHint').textContent = CRAPS_WINMODE_HINTS[crapsWinMode];
  });
});
document.getElementById('crapsClearStagedBtn').addEventListener('click', crapsClearStaged);
document.getElementById('crapsClearStagedTopBtn').addEventListener('click', crapsClearStaged);
function crapsClearStaged(){
  crapsStaged = {
    pass: 0, dontpass: 0, come: 0, dontcome: 0, field: 0, passodds: 0, dontpassodds: 0,
    place: { 4: 0, 5: 0, 6: 0, 8: 0, 9: 0, 10: 0 }, hardway: { 4: 0, 6: 0, 8: 0, 10: 0 },
    prop: { any7: 0, anycraps: 0, 2: 0, 3: 0, 11: 0, 12: 0 }
  };
  document.getElementById('crapsBetError').textContent = '';
  crapsRenderBetSpots();
  // Unambiguous confirmation this actually did something — same brief
  // gold flash the table already uses elsewhere for a state change, so
  // "nothing visibly happened" can't be mistaken for "button's broken".
  const railEl = document.getElementById('crapsTableRail');
  if(railEl){ railEl.classList.remove('pc-flash-gold'); void railEl.offsetWidth; railEl.classList.add('pc-flash-gold'); }
}
document.getElementById('crapsBetInput').addEventListener('input', (e) => {
  const chip = document.getElementById('crapsChipDisplay');
  if(!chip) return;
  chip.textContent = e.target.value || '0';
  chip.classList.remove('pc-chip-pulse'); void chip.offsetWidth; chip.classList.add('pc-chip-pulse');
});
// Tap the chip readout to type any amount — the 10/25/50/100/250 buttons
// are quick-pick shortcuts, not a ceiling; there's no house limit here.
document.getElementById('crapsChipDisplay').addEventListener('click', () => {
  const input = document.getElementById('crapsBetInput');
  const entry = prompt('Bet amount (XP):', input.value || '50');
  if(entry === null) return;
  const amount = Math.floor(Number(entry));
  if(!(amount > 0)) return;
  input.value = amount;
  input.dispatchEvent(new Event('input'));
  document.querySelectorAll('#crapsBetPanel .table-chip').forEach(c => c.classList.remove('active-chip'));
});

let crapsRolling = false; // guards against a double-tap firing two overlapping rolls — the real cause of "bets only half-clear" reports (see crapsRoll)
async function crapsRoll(){
  // Everything above this line is synchronous — the button is disabled and
  // the guard flag set BEFORE the first await, so a rapid double-tap can't
  // start a second overlapping roll while the balance check or animation
  // is still in flight. The previous version disabled the button only
  // after awaiting the balance check, leaving a real window where two
  // rolls could run concurrently and race on the same shared bet state —
  // exactly the "place bets on 4 and 5, only one clears after rolling"
  // symptom reported from live testing.
  if(crapsRolling) return;
  crapsRolling = true;
  const rollBtn = document.getElementById('crapsRollBtn');
  const clearBtn = document.getElementById('crapsClearStagedBtn');
  const rollBtnTop = document.getElementById('crapsRollTopBtn');
  const clearBtnTop = document.getElementById('crapsClearStagedTopBtn');
  rollBtn.disabled = true;
  clearBtn.disabled = true;
  if(rollBtnTop) rollBtnTop.disabled = true;
  if(clearBtnTop) clearBtnTop.disabled = true;
  try{
    await crapsRollInner();
  } finally {
    rollBtn.disabled = false;
    clearBtn.disabled = false;
    if(rollBtnTop) rollBtnTop.disabled = false;
    if(clearBtnTop) clearBtnTop.disabled = false;
    crapsRolling = false;
  }
}
async function crapsRollInner(){
  const errEl = document.getElementById('crapsBetError');
  errEl.textContent = '';
  const stagedTotal = crapsSumStaged();
  const alreadyLive = crapsTotalAtRisk() - stagedTotal;
  if(stagedTotal === 0 && alreadyLive === 0){ errEl.textContent = 'Place at least one bet first.'; return; }
  const balance = await getXPBalance();
  if(balance == null){ errEl.textContent = 'Could not check your XP balance — try again.'; return; }
  if(crapsTotalAtRisk() > balance){ errEl.textContent = `You only have ${balance} XP (at risk: ${crapsTotalAtRisk()}).`; return; }

  scrollIntoViewSmooth('crapsTableRail');
  bjPlayChipSound();
  croupierSay('crapsCroupierMsg', crapsPoint == null ? CROUPIER_LINES.crapsComeOut : CROUPIER_LINES.crapsRolling);

  const a = 1 + Math.floor(Math.random() * 6);
  const b = 1 + Math.floor(Math.random() * 6);
  const total = a + b;
  const isHardRoll = a === b;
  bjPlaySpinSound();
  await crapsAnimateRoll(a, b);

  // Commit staged Pass/Don't Pass onto the felt if a point isn't already
  // riding (mutually exclusive with the disabled state in the UI, but
  // guarded here too). Place/Hardway commit unconditionally — they work
  // regardless of come-out or point phase.
  if(crapsPoint == null){
    crapsLive.pass += crapsStaged.pass;
    crapsLive.dontpass += crapsStaged.dontpass;
  }
  if(crapsPoint != null && crapsLive.pass > 0) crapsPassOdds += crapsStaged.passodds;
  if(crapsPoint != null && crapsLive.dontpass > 0) crapsDontPassOdds += crapsStaged.dontpassodds;
  [4, 5, 6, 8, 9, 10].forEach(n => { crapsPlace[n] += crapsStaged.place[n]; });
  [4, 6, 8, 10].forEach(n => { crapsHardway[n] += crapsStaged.hardway[n]; });

  let delta = 0;
  const wonSpots = [], lostSpots = [];

  const isComeOut = crapsPoint == null;
  if(isComeOut){
    // ---- Come-out roll ----
    if(total === 7 || total === 11){
      if(crapsLive.pass > 0){ delta += crapsLive.pass; wonSpots.push('Pass Line'); crapsLive.pass = 0; }
      if(crapsLive.dontpass > 0){ delta -= crapsLive.dontpass; lostSpots.push("Don't Pass"); crapsLive.dontpass = 0; }
    } else if(total === 2 || total === 3 || total === 12){
      if(crapsLive.pass > 0){ delta -= crapsLive.pass; lostSpots.push('Pass Line'); crapsLive.pass = 0; }
      if(crapsLive.dontpass > 0){
        if(total === 12){ /* bar 12 — push, bet simply returned, no delta */ }
        else { delta += crapsLive.dontpass; wonSpots.push("Don't Pass"); }
        crapsLive.dontpass = 0;
      }
    } else {
      crapsPoint = total; // point established — Pass/Don't Pass now ride until it resolves
    }
    // Come/Don't Come/Odds can't be freshly staged pre-point (UI disables
    // the spots), so nothing further to resolve here.
  } else {
    // ---- Point phase ----
    if(total === 7){
      // Seven-out: Pass/Don't Pass (+ their Odds), every Come point, every
      // Don't Come point all resolve at once, then the puck goes back OFF.
      if(crapsLive.pass > 0){ delta -= crapsLive.pass; lostSpots.push('Pass Line'); }
      if(crapsPassOdds > 0){ delta -= crapsPassOdds; lostSpots.push('Odds — Pass'); }
      if(crapsLive.dontpass > 0){ delta += crapsLive.dontpass; wonSpots.push("Don't Pass"); }
      if(crapsDontPassOdds > 0){ delta += Math.round(crapsDontPassOdds * CRAPS_DONTPASS_ODDS_MULT[crapsPoint]); wonSpots.push("Odds — Don't Pass"); }
      Object.entries(crapsComePoints).forEach(([n, amt]) => { delta -= amt; lostSpots.push(`Come (${n})`); });
      Object.entries(crapsDontComePoints).forEach(([n, amt]) => { delta += amt; wonSpots.push(`Don't Come (${n})`); });
      crapsLive.pass = 0; crapsLive.dontpass = 0; crapsPassOdds = 0; crapsDontPassOdds = 0;
      crapsComePoints = {}; crapsDontComePoints = {};
      crapsPoint = null;
    } else {
      if(total === crapsPoint){
        if(crapsLive.pass > 0){ delta += crapsLive.pass; wonSpots.push('Pass Line'); crapsLive.pass = 0; }
        if(crapsPassOdds > 0){ delta += Math.round(crapsPassOdds * CRAPS_PASS_ODDS_MULT[crapsPoint]); wonSpots.push('Odds — Pass'); crapsPassOdds = 0; }
        if(crapsLive.dontpass > 0){ delta -= crapsLive.dontpass; lostSpots.push("Don't Pass"); crapsLive.dontpass = 0; }
        if(crapsDontPassOdds > 0){ delta -= crapsDontPassOdds; lostSpots.push("Odds — Don't Pass"); crapsDontPassOdds = 0; }
        crapsPoint = null; // point made — new come-out round begins
      }
      if(crapsComePoints[total]){ delta += crapsComePoints[total]; wonSpots.push(`Come (${total})`); delete crapsComePoints[total]; }
      if(crapsDontComePoints[total]){ delta -= crapsDontComePoints[total]; lostSpots.push(`Don't Come (${total})`); delete crapsDontComePoints[total]; }
    }
    // Freshly staged Come/Don't Come this roll resolve exactly like a
    // come-out roll would, just for that individual bet.
    if(crapsStaged.come > 0){
      if(total === 7 || total === 11){ delta += crapsStaged.come; wonSpots.push('Come'); }
      else if(total === 2 || total === 3 || total === 12){ delta -= crapsStaged.come; lostSpots.push('Come'); }
      else { crapsComePoints[total] = (crapsComePoints[total] || 0) + crapsStaged.come; }
    }
    if(crapsStaged.dontcome > 0){
      if(total === 2 || total === 3){ delta += crapsStaged.dontcome; wonSpots.push("Don't Come"); }
      else if(total === 7 || total === 11){ delta -= crapsStaged.dontcome; lostSpots.push("Don't Come"); }
      else if(total === 12){ /* bar 12 — push */ }
      else { crapsDontComePoints[total] = (crapsDontComePoints[total] || 0) + crapsStaged.dontcome; }
    }
  }

  // ---- Place bets — work every roll regardless of come-out/point phase.
  // A 7 wipes every live Place bet. Hitting a placed number's payout
  // depends on crapsWinMode: Take Down pays out and clears the spot
  // (default, re-place it to keep it working); Let It Ride pays out but
  // leaves the same amount riding; Press skips the payout and adds the
  // win straight onto the bet instead, growing it — same real-table
  // options as backing a Place bet down or building it up.
  const winModeTag = crapsWinMode === 'ride' ? ' (riding)' : (crapsWinMode === 'press' ? ' (pressed)' : '');
  if(total === 7){
    [4, 5, 6, 8, 9, 10].forEach(n => { if(crapsPlace[n] > 0){ delta -= crapsPlace[n]; lostSpots.push(`Place ${n}`); crapsPlace[n] = 0; } });
  } else if(crapsPlace[total]){
    const winAmt = Math.round(crapsPlace[total] * CRAPS_PLACE_MULT[total]);
    wonSpots.push(`Place ${total}${winModeTag}`);
    if(crapsWinMode === 'press'){ crapsPlace[total] += winAmt; }
    else { delta += winAmt; if(crapsWinMode === 'takedown') crapsPlace[total] = 0; }
  }

  // ---- Hardways — also work every roll. A 7 wipes them all; the SAME
  // number rolled the easy (non-double) way loses just that one; rolled
  // as a double pays out (subject to crapsWinMode, same as Place above);
  // anything else leaves it riding.
  if(total === 7){
    [4, 6, 8, 10].forEach(n => { if(crapsHardway[n] > 0){ delta -= crapsHardway[n]; lostSpots.push(`Hard ${n}`); crapsHardway[n] = 0; } });
  } else {
    [4, 6, 8, 10].forEach(n => {
      if(crapsHardway[n] > 0 && total === n){
        if(isHardRoll){
          const winAmt = crapsHardway[n] * CRAPS_HARDWAY_MULT[n];
          wonSpots.push(`Hard ${n}${winModeTag}`);
          if(crapsWinMode === 'press'){ crapsHardway[n] += winAmt; }
          else { delta += winAmt; if(crapsWinMode === 'takedown') crapsHardway[n] = 0; }
        }
        else { delta -= crapsHardway[n]; lostSpots.push(`Hard ${n} (easy way)`); crapsHardway[n] = 0; }
      }
    });
  }

  // ---- Field — always resolves, every roll, come-out or point phase ----
  if(crapsStaged.field > 0){
    const mult = CRAPS_FIELD_PAYOUT[total];
    if(mult){ delta += crapsStaged.field * mult; wonSpots.push('Field'); }
    else { delta -= crapsStaged.field; lostSpots.push('Field'); }
  }

  // ---- One-roll props — resolve immediately, every roll, never carry over ----
  const PROP_LABELS = { any7: 'Any 7', anycraps: 'Any Craps', 2: 'Prop 2', 3: 'Prop 3', 11: 'Prop 11', 12: 'Prop 12' };
  const propWins = (key, t) => {
    if(key === 'any7') return t === 7;
    if(key === 'anycraps') return t === 2 || t === 3 || t === 12;
    return t === Number(key);
  };
  Object.keys(crapsStaged.prop).forEach(key => {
    const amt = crapsStaged.prop[key];
    if(amt <= 0) return;
    if(propWins(key, total)){ delta += amt * CRAPS_PROP_MULT[key]; wonSpots.push(PROP_LABELS[key]); }
    else { delta -= amt; lostSpots.push(PROP_LABELS[key]); }
  });

  crapsStaged = {
    pass: 0, dontpass: 0, come: 0, dontcome: 0, field: 0, passodds: 0, dontpassodds: 0,
    place: { 4: 0, 5: 0, 6: 0, 8: 0, 9: 0, 10: 0 }, hardway: { 4: 0, 6: 0, 8: 0, 10: 0 },
    prop: { any7: 0, anycraps: 0, 2: 0, 3: 0, 11: 0, 12: 0 }
  };
  crapsRenderBetSpots();

  const resultEl = document.getElementById('crapsTotalMsg');
  const isSevenOut = !isComeOut && total === 7;
  let msg = `${a} + ${b} = ${total}`;
  if(isComeOut && total !== 7 && total !== 11 && total !== 2 && total !== 3 && total !== 12) msg += ` — point is ${total}`;
  else if(isSevenOut) msg += ' — seven out';
  else if(!isComeOut && crapsPoint == null && !isSevenOut) msg += ' — point made!';
  if(wonSpots.length || lostSpots.length){
    msg += `  |  ${[...wonSpots.map(s => `${s} won`), ...lostSpots.map(s => `${s} lost`)].join(', ')}`;
  }
  resultEl.textContent = `${msg}  —  ${delta >= 0 ? '+' : ''}${delta} XP`;
  resultEl.style.color = delta > 0 ? 'var(--win)' : (delta < 0 ? 'var(--loss)' : 'var(--muted)');
  resultEl.classList.remove('bj-outcome-pop'); void resultEl.offsetWidth; resultEl.classList.add('bj-outcome-pop');
  const isPointJustMade = !isComeOut && crapsPoint == null && !isSevenOut;
  const isPointJustSet = isComeOut && total !== 7 && total !== 11 && total !== 2 && total !== 3 && total !== 12;
  if(isSevenOut) croupierSay('crapsCroupierMsg', CROUPIER_LINES.crapsSevenOut);
  else if(isPointJustMade) croupierSay('crapsCroupierMsg', CROUPIER_LINES.crapsPointMade);
  else if(isPointJustSet) croupierSay('crapsCroupierMsg', CROUPIER_LINES.crapsPointSet);
  else if(delta >= 500) croupierSay('crapsCroupierMsg', CROUPIER_LINES.crapsBigRoll);
  else if(wonSpots.some(s => s.startsWith('Field'))) croupierSay('crapsCroupierMsg', CROUPIER_LINES.crapsFieldWin);

  crapsHistory.push({ total, kind: isSevenOut ? 'sevenout' : ((!isComeOut && crapsPoint == null) ? 'point' : 'roll') });
  crapsRenderHistory();

  const panelEl = document.getElementById('casinoGameCraps');
  if(delta > 0){
    bjPlayChime(true);
    bjLaunchConfetti(resultEl, 22);
  } else if(delta < 0){
    bjPlayChime(false);
    panelEl.classList.add('pc-shake');
    setTimeout(() => panelEl.classList.remove('pc-shake'), 700);
  }

  if(delta !== 0) await awardXP(delta, delta > 0 ? 'Craps win' : 'Craps loss', { silent: true, detail: { type: 'dice', a, b, total } });
  const bal = await getXPBalance();
  updateXPBalanceDisplay(bal);
  renderXPLog();
}
