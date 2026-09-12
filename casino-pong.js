// ---- Pong — the first of what's meant to be a small "arcade zone"
// alongside the luck-based casino games: skill decides the outcome here,
// not odds, so it can't use the same stake-and-payout model. Instead,
// same convention as Daily Spin/Weekly Bonus: a once-per-day cap. You
// can replay as many times as you want, but only your BEST score each
// day (AEST) ever converts to XP, and only the newly-crossed tiers pay
// out on a later run — this is the whole abuse-prevention mechanism,
// since an endlessly-replayable skill game would otherwise be a wide-
// open XP-farming exploit if every run paid out.
const PONG_TIERS = [
  { threshold: 5,  xp: 5000 },
  { threshold: 15, xp: 15000 },
  { threshold: 30, xp: 40000 },
  { threshold: 50, xp: 100000 },
  { threshold: 75, xp: 200000 }
];
let pongBuilt = false;
let pongBestToday = 0;
let pongAllTimeBest = 0;
let pongRunning = false;
let pongScore = 0;
let pongAnimId = null;
let pongState = null; // { player:{y}, cpu:{y,aimError}, ball:{x,y,vx,vy,trail}, speedTier }
// Bumped bigger once per request, but it didn't fit on-screen (canvas
// overflowed past the phone viewport — a real CSS bug, see dashboard.css
// notes on .pong-arena-wrap) — reverted back to the original size per
// follow-up request rather than chase the responsive fix under time
// pressure. Speed/aim constants below are back to their matching
// originals too.
const PONG_W = 340, PONG_H = 220, PONG_PADDLE_H = 40, PONG_PADDLE_W = 7, PONG_BALL_R = 5;
// Difficulty now steps up in distinct jumps every 5 returns, rather than
// a smooth per-hit multiplier — a real "stage 2 starts now" moment
// instead of something only noticeable in hindsight. Each tier bumps
// both the ball's base speed and the CPU's own max tracking speed, so
// the CPU staying capped (see pongStep) is what actually makes each new
// tier a genuine step up in difficulty, not just a faster-looking ball.
const PONG_RETURNS_PER_TIER = 5;
const PONG_MAX_SPEED_TIER = 8; // caps the escalation so very long runs stay genuinely playable rather than becoming physically unbeatable
function pongSpeedTierFor(score){
  return Math.min(PONG_MAX_SPEED_TIER, 1 + Math.floor(score / PONG_RETURNS_PER_TIER));
}
function pongBallSpeedForTier(tier){ return 2.3 + (tier - 1) * 0.42; }
function pongCpuMaxSpeedForTier(tier){ return 3.0 + (tier - 1) * 0.34; }

function pongBuildTierTable(){
  const table = document.getElementById('pongTierTable');
  if(!table) return;
  table.innerHTML = PONG_TIERS.map(t => `<tr><td>${t.threshold}+ returns</td><td style="text-align:right;">+${t.xp.toLocaleString()} XP</td></tr>`).join('');
}
async function pongInit(){
  pongBuilt = true;
  pongBuildTierTable();
  await pongFetchBestToday();
  await pongFetchAllTimeBest();
  await pongFetchLeaderboard();
  pongResetVisual();
}
async function pongFetchBestToday(){
  const todayKey = currentAestDateKey();
  try{
    const res = await authedFetch(`/games/pong/${currentUserUid}.json`);
    const data = await res.json();
    pongBestToday = (data && data.date === todayKey) ? (data.bestScore || 0) : 0;
  }catch(e){
    pongBestToday = 0;
  }
  const el = document.getElementById('pongBestTodayVal');
  if(el) el.textContent = pongBestToday.toLocaleString();
}
// All-time personal best — separate from pongBestToday (which resets
// daily and only exists to gate XP payouts). Kept as its own node
// rather than reusing /games/pong/{uid} so the daily-reset XP logic
// above is never touched by this.
async function pongFetchAllTimeBest(){
  try{
    const res = await authedFetch(`/games/pongAllTime/${currentUserUid}.json`);
    const data = await res.json();
    pongAllTimeBest = (data && data.bestScore) || 0;
  }catch(e){
    pongAllTimeBest = 0;
  }
}
// Group-wide "best rounds" leaderboard for the CPU challenge — a flat
// node keyed by uid so it's cheap to fetch as one object and sort
// client-side; names resolved live via nameForUid() rather than stored,
// so a rename always shows correctly without needing to touch old entries.
async function pongFetchLeaderboard(){
  let entries = [];
  try{
    const res = await authedFetch('/games/pongLeaderboard.json');
    const data = await res.json();
    if(data){
      entries = Object.keys(data).map(uid => ({ uid, bestScore: (data[uid] && data[uid].bestScore) || 0 }));
      entries.sort((a, b) => b.bestScore - a.bestScore);
    }
  }catch(e){}
  pongRenderLeaderboard(entries);
}
function pongRenderLeaderboard(entries){
  const table = document.getElementById('pongLeaderboardTable');
  if(!table) return;
  if(!entries.length){
    table.innerHTML = '<tr><td style="text-align:center; color:var(--muted); padding:10px 0;">No runs on the board yet — be the first.</td></tr>';
    return;
  }
  table.innerHTML = entries.slice(0, 10).map((e, i) => {
    const mine = e.uid === currentUserUid;
    const style = mine ? ' style="color:var(--brass-light); font-weight:700;"' : '';
    return `<tr${style}><td>${i + 1}</td><td>${nameForUid(e.uid)}</td><td style="text-align:right;">${e.bestScore.toLocaleString()}</td></tr>`;
  }).join('');
}
function pongResetVisual(){
  const canvas = document.getElementById('pongCanvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  pongDrawFrame(ctx, { player: { y: PONG_H / 2 - PONG_PADDLE_H / 2 }, cpu: { y: PONG_H / 2 - PONG_PADDLE_H / 2 }, ball: { x: PONG_W / 2, y: PONG_H / 2, trail: [] } });
  const scoreEl = document.getElementById('pongCurrentScoreVal');
  if(scoreEl) scoreEl.textContent = '0';
  const tierEl = document.getElementById('pongSpeedTierVal');
  if(tierEl) tierEl.textContent = '1';
}
function pongPlayHitBeep(freq){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.08);
}
// A brief rising sweep for the moment a new speed tier actually kicks
// in — distinct from the flat hit-beep, so stepping up a difficulty
// level is heard as well as seen (the level-up flash).
function pongPlayLevelUpSweep(){
  const ctx = bjGetAudioCtx(); if(!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator(); osc.type = 'triangle';
  osc.frequency.setValueAtTime(320, now);
  osc.frequency.exponentialRampToValueAtTime(720, now + 0.18);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.13, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(now); osc.stop(now + 0.24);
}
function pongStart(){
  if(pongRunning) return;
  pongRunning = true;
  pongScore = 0;
  document.getElementById('pongGameOverOverlay').style.display = 'none';
  document.getElementById('pongCurrentScoreVal').textContent = '0';
  document.getElementById('pongSpeedTierVal').textContent = '1';
  document.getElementById('pongStartBtn').style.display = 'none';
  scrollIntoViewSmooth('pongTableRail');
  const angle = (Math.random() * 0.6 - 0.3);
  const startSpeed = pongBallSpeedForTier(1);
  pongState = {
    player: { y: PONG_H / 2 - PONG_PADDLE_H / 2 },
    cpu: { y: PONG_H / 2 - PONG_PADDLE_H / 2, aimError: 0 },
    ball: { x: PONG_W / 2, y: PONG_H / 2, vx: (Math.random() < 0.5 ? -1 : 1) * startSpeed, vy: angle * 3, trail: [] },
    speedTier: 1
  };
  const canvas = document.getElementById('pongCanvas');
  const ctx = canvas.getContext('2d');
  const loop = () => {
    if(!pongRunning) return;
    pongStep();
    pongDrawFrame(ctx, pongState);
    pongAnimId = requestAnimationFrame(loop);
  };
  pongAnimId = requestAnimationFrame(loop);
}
function pongStep(){
  const s = pongState;
  const b = s.ball;
  b.x += b.vx; b.y += b.vy;
  // Trail: a short fading history of recent ball positions, purely
  // cosmetic — gives the ball a genuine sense of speed and motion
  // instead of reading as a dot silently teleporting frame to frame.
  b.trail.push({ x: b.x, y: b.y });
  if(b.trail.length > 8) b.trail.shift();

  // Bounce off top/bottom walls
  if(b.y - PONG_BALL_R < 0){ b.y = PONG_BALL_R; b.vy = Math.abs(b.vy); }
  if(b.y + PONG_BALL_R > PONG_H){ b.y = PONG_H - PONG_BALL_R; b.vy = -Math.abs(b.vy); }

  // CPU tracks the ball with a capped speed (tied to the current speed
  // tier — see PONG_RETURNS_PER_TIER) and a per-approach aim error —
  // this, combined with the tier escalation, is what makes each step up
  // in difficulty genuine rather than cosmetic: the CPU's own max speed
  // only rises a little each tier, while the ball's rises faster,
  // widening the gap it has to cover. Re-rolled each time the ball turns
  // back toward the CPU, not every frame, so it reads as a genuine (if
  // imperfect) read on the shot rather than jitter.
  if(b.vx > 0){
    if(s.cpu.aimError === 0) s.cpu.aimError = (Math.random() * 26 - 13);
    const targetY = b.y + s.cpu.aimError - PONG_PADDLE_H / 2;
    const cpuMaxSpeed = pongCpuMaxSpeedForTier(s.speedTier);
    const diff = targetY - s.cpu.y;
    s.cpu.y += Math.max(-cpuMaxSpeed, Math.min(cpuMaxSpeed, diff));
  } else {
    s.cpu.aimError = 0;
  }
  s.cpu.y = Math.max(0, Math.min(PONG_H - PONG_PADDLE_H, s.cpu.y));

  // Player paddle hit (left side)
  if(b.vx < 0 && b.x - PONG_BALL_R <= PONG_PADDLE_W + 2){
    if(b.y >= s.player.y && b.y <= s.player.y + PONG_PADDLE_H){
      const hitPos = (b.y - (s.player.y + PONG_PADDLE_H / 2)) / (PONG_PADDLE_H / 2); // -1..1
      pongScore++;
      const newTier = pongSpeedTierFor(pongScore);
      const tierJustIncreased = newTier > s.speedTier;
      s.speedTier = newTier;
      const speed = pongBallSpeedForTier(s.speedTier);
      b.vx = Math.abs(speed);
      b.vy = hitPos * (2.6 + s.speedTier * 0.25);
      b.x = PONG_PADDLE_W + 2 + PONG_BALL_R;
      document.getElementById('pongCurrentScoreVal').textContent = pongScore.toLocaleString();
      document.getElementById('pongSpeedTierVal').textContent = s.speedTier.toLocaleString();
      pongPlayHitBeep(220);
      if(tierJustIncreased){
        pongPlayLevelUpSweep();
        const flash = document.getElementById('pongLevelUpFlash');
        if(flash){ flash.style.display = 'block'; flash.classList.remove('pong-levelup-flash'); void flash.offsetWidth; flash.classList.add('pong-levelup-flash'); setTimeout(() => { flash.style.display = 'none'; }, 500); }
      }
    } else if(b.x - PONG_BALL_R < 0){
      pongGameOver();
      return;
    }
  }
  // CPU paddle hit (right side) — a CPU miss is a good outcome for the
  // player (it couldn't keep up), not a fail condition: award a small
  // bonus and re-serve toward the player rather than ending the run.
  if(b.vx > 0 && b.x + PONG_BALL_R >= PONG_W - PONG_PADDLE_W - 2){
    if(b.y >= s.cpu.y && b.y <= s.cpu.y + PONG_PADDLE_H){
      const hitPos = (b.y - (s.cpu.y + PONG_PADDLE_H / 2)) / (PONG_PADDLE_H / 2);
      b.vx = -Math.abs(pongBallSpeedForTier(s.speedTier));
      b.vy = hitPos * (2.6 + s.speedTier * 0.25);
      b.x = PONG_W - PONG_PADDLE_W - 2 - PONG_BALL_R;
      pongPlayHitBeep(330);
    } else if(b.x + PONG_BALL_R > PONG_W){
      pongScore += 3;
      document.getElementById('pongCurrentScoreVal').textContent = pongScore.toLocaleString();
      pongPlayHitBeep(440);
      b.x = PONG_W / 2; b.y = PONG_H / 2; b.trail = [];
      b.vx = -Math.abs(pongBallSpeedForTier(s.speedTier));
      b.vy = (Math.random() * 0.6 - 0.3) * 3;
    }
  }
}
function pongDrawFrame(ctx, s){
  ctx.clearRect(0, 0, PONG_W, PONG_H);
  // Subtle MLSYND wordmark, drawn first so it sits behind everything —
  // same idea as the DOM .craps-table-wordmark treatment on the felt
  // tables, but this has to be baked into the canvas draw itself since
  // Pong's table is a <canvas>, not a DOM background a watermark div
  // could show through.
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#FFE078';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(PONG_H * 0.26)}px 'Barlow Condensed', sans-serif`;
  ctx.fillText('MLSYND', PONG_W / 2, PONG_H / 2 - PONG_H * 0.08);
  ctx.font = `700 ${Math.round(PONG_H * 0.08)}px 'Barlow Condensed', sans-serif`;
  ctx.fillText('C A S I N O', PONG_W / 2, PONG_H / 2 + PONG_H * 0.13);
  ctx.restore();
  // Subtle centre dashed line
  ctx.strokeStyle = 'rgba(255,214,120,.22)'; ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
  ctx.beginPath(); ctx.moveTo(PONG_W / 2, 0); ctx.lineTo(PONG_W / 2, PONG_H); ctx.stroke();
  ctx.setLineDash([]);
  // Paddles — rounded ends + a soft glow instead of a flat rectangle
  ctx.shadowColor = 'rgba(255,214,120,.65)'; ctx.shadowBlur = 8;
  ctx.fillStyle = '#FFE078';
  pongRoundedRect(ctx, 2, s.player.y, PONG_PADDLE_W, PONG_PADDLE_H, 3);
  pongRoundedRect(ctx, PONG_W - PONG_PADDLE_W - 2, s.cpu.y, PONG_PADDLE_W, PONG_PADDLE_H, 3);
  ctx.shadowBlur = 0;
  // Ball trail — fading, shrinking circles behind the ball's current
  // position, purely cosmetic but gives real motion presence.
  if(s.ball.trail){
    s.ball.trail.forEach((p, i) => {
      const t = (i + 1) / s.ball.trail.length;
      ctx.globalAlpha = t * 0.35;
      ctx.beginPath(); ctx.arc(p.x, p.y, PONG_BALL_R * t, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    });
    ctx.globalAlpha = 1;
  }
  // Ball itself, with a soft glow matching the paddles'
  ctx.shadowColor = 'rgba(255,255,255,.8)'; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.arc(s.ball.x, s.ball.y, PONG_BALL_R, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.shadowBlur = 0;
}
function pongRoundedRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}
async function pongGameOver(){
  pongRunning = false;
  if(pongAnimId) cancelAnimationFrame(pongAnimId);
  document.getElementById('pongStartBtn').style.display = 'inline-block';
  const overlay = document.getElementById('pongGameOverOverlay');
  const scoreEl = document.getElementById('pongOverlayScore');
  const msgEl = document.getElementById('pongOverlayXpMsg');
  scoreEl.textContent = pongScore.toLocaleString();
  bjPlayChime(false);

  let xpAwarded = 0;
  if(pongScore > pongBestToday){
    PONG_TIERS.forEach(t => {
      if(pongScore >= t.threshold && pongBestToday < t.threshold) xpAwarded += t.xp;
    });
    pongBestToday = pongScore;
    document.getElementById('pongBestTodayVal').textContent = pongBestToday.toLocaleString();
    const todayKey = currentAestDateKey();
    try{
      await authedFetch(`/games/pong/${currentUserUid}.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: todayKey, bestScore: pongBestToday })
      });
    }catch(e){}
    if(xpAwarded > 0){
      await awardXP(xpAwarded, 'Pong new best score', { silent: true });
      const bal = await getXPBalance();
      updateXPBalanceDisplay(bal);
      bjPlayChime(true);
      bjLaunchConfetti(scoreEl, 30);
      msgEl.textContent = `New best today! +${xpAwarded.toLocaleString()} XP`;
      msgEl.style.color = 'var(--win)';
    } else {
      msgEl.textContent = 'New best today, but no new tier crossed yet.';
      msgEl.style.color = 'var(--muted)';
    }
  } else {
    msgEl.textContent = `Best today is still ${pongBestToday.toLocaleString()} — beat that to earn more XP.`;
    msgEl.style.color = 'var(--muted)';
  }

  // All-time leaderboard — separate from the XP/tier logic above, and
  // deliberately not gated behind pongScore > pongBestToday: a player
  // could already be behind their own today-best from an earlier run
  // this session while still being nowhere near their real all-time
  // best (freshly reset daily), so this checks independently.
  if(pongScore > pongAllTimeBest){
    pongAllTimeBest = pongScore;
    try{
      await authedFetch(`/games/pongAllTime/${currentUserUid}.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bestScore: pongAllTimeBest, ts: Date.now() })
      });
      await authedFetch(`/games/pongLeaderboard/${currentUserUid}.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bestScore: pongAllTimeBest, ts: Date.now() })
      });
    }catch(e){}
    await pongFetchLeaderboard();
  }
  overlay.style.display = 'flex';
}
document.getElementById('pongStartBtn').addEventListener('click', pongStart);
document.getElementById('pongPlayAgainBtn').addEventListener('click', pongStart);
(function(){
  const canvas = document.getElementById('pongCanvas');
  if(!canvas) return;
  const movePaddle = (clientY) => {
    if(!pongRunning) return;
    const rect = canvas.getBoundingClientRect();
    const scale = PONG_H / rect.height;
    const y = (clientY - rect.top) * scale - PONG_PADDLE_H / 2;
    pongState.player.y = Math.max(0, Math.min(PONG_H - PONG_PADDLE_H, y));
  };
  canvas.addEventListener('touchmove', (e) => { e.preventDefault(); movePaddle(e.touches[0].clientY); }, { passive: false });
  canvas.addEventListener('touchstart', (e) => { movePaddle(e.touches[0].clientY); }, { passive: true });
  canvas.addEventListener('mousemove', (e) => { movePaddle(e.clientY); });
})();

// ==================================================================
// ---- Multiplayer Pong — Stage 1: matchmaking & stake agreement ----
// This stage deliberately does NOT move any real XP and does NOT play
// any actual live rally — it only lets two members find each other,
// agree a stake, and lock the match in as "accepted", ready for the
// live-gameplay stages (deterministic lockstep physics + a settlement
// function) to be built on top of. Keeping this stage free of real XP
// movement means there's nothing at risk if the later stages take a
// while, or if the design changes before gameplay actually ships.
//
// Data model: /pongMatches/{pushId} = {
//   challengerUid, opponentUid, stake, status, createdAt
// }
// status: 'pending' -> 'accepted' | 'declined' | 'cancelled'
// (a later stage will add 'in_progress' / 'completed' + a result block)
// ==================================================================
let pongMpPollInterval = null;
let pongMpMode = 'cpu'; // 'cpu' | 'multiplayer' — which sub-view is showing

function pongMpPopulateOpponentSelect(){
  const sel = document.getElementById('pongOpponentSelect');
  if(!sel || !currentState || !Array.isArray(currentState.members)) return;
  const others = currentState.members.filter(m => m.linkedUid && m.linkedUid !== currentUserUid);
  sel.innerHTML = others.length
    ? others.map(m => `<option value="${m.linkedUid}">${m.name}</option>`).join('')
    : '<option value="">No other linked members yet</option>';
}

async function pongMpSendChallenge(){
  const btn = document.getElementById('pongSendChallengeBtn');
  const errEl = document.getElementById('pongChallengeError');
  errEl.textContent = '';
  const opponentUid = document.getElementById('pongOpponentSelect').value;
  const stake = parseInt(document.getElementById('pongStakeInput').value, 10) || 0;
  if(!opponentUid){ errEl.textContent = 'Pick an opponent first.'; return; }
  if(stake <= 0){ errEl.textContent = 'Enter a stake above 0 XP.'; return; }
  if(stake > CASINO_MAX_BET_PER_HAND){ errEl.textContent = `Max stake is ${CASINO_MAX_BET_PER_HAND.toLocaleString()} XP.`; return; }
  btn.disabled = true;
  try{
    // A courtesy check only — not an enforcement point. Nothing is
    // actually escrowed at this stage, so this can't be relied on as a
    // guarantee by the time a match is later accepted; it just avoids
    // sending an obviously-doomed challenge.
    const balance = await getXPBalance();
    if(balance != null && stake > balance){
      errEl.textContent = `You only have ${balance.toLocaleString()} XP.`;
      return;
    }
    const res = await authedFetch('/pongMatches.json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengerUid: currentUserUid, opponentUid, stake, status: 'pending', createdAt: Date.now() })
    });
    if(!res.ok){ errEl.textContent = 'Could not send the challenge — try again.'; return; }
    document.getElementById('pongStakeInput').value = '';
    await pongMpRefresh();
  }catch(e){
    errEl.textContent = 'Could not send the challenge — check your connection.';
  }finally{
    btn.disabled = false;
  }
}

async function pongMpRespondToChallenge(matchId, accept){
  try{
    await authedFetch(`/pongMatches/${matchId}/status.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accept ? 'accepted' : 'declined')
    });
  }catch(e){}
  await pongMpRefresh();
}

async function pongMpCancelChallenge(matchId){
  try{
    await authedFetch(`/pongMatches/${matchId}/status.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify('cancelled')
    });
  }catch(e){}
  await pongMpRefresh();
}

function pongMpMatchRow(matchId, m, opponentUidField, actionsHtml){
  const opponentUid = m[opponentUidField];
  const stakeStr = (m.stake || 0).toLocaleString();
  return `<div class="mines-status-row" style="margin-bottom:6px;">
    <div class="mines-status-cell" style="flex:1; text-align:left;">
      <span class="lbl">${opponentUidField === 'opponentUid' ? 'From' : 'To'}</span>
      <span class="val" style="font-size:14px;">${nameForUid(opponentUid)}</span>
    </div>
    <div class="mines-status-cell"><span class="lbl">Stake</span><span class="val">${stakeStr} XP</span></div>
    ${actionsHtml}
  </div>`;
}

async function pongMpRefresh(){
  if(!currentUserUid) return;
  let matches = {};
  try{
    const res = await authedFetch('/pongMatches.json');
    matches = (await res.json()) || {};
  }catch(e){
    matches = {};
  }
  const entries = Object.keys(matches).map(id => ({ id, ...matches[id] }));

  const incoming = entries.filter(m => m.opponentUid === currentUserUid && m.status === 'pending');
  const outgoing = entries.filter(m => m.challengerUid === currentUserUid && m.status === 'pending');
  const accepted = entries.filter(m => m.status === 'accepted' && (m.challengerUid === currentUserUid || m.opponentUid === currentUserUid));

  const incomingEl = document.getElementById('pongIncomingChallenges');
  if(incomingEl){
    incomingEl.innerHTML = incoming.length ? incoming.map(m => pongMpMatchRow(m.id, m, 'challengerUid',
      `<div class="mines-status-cell" style="gap:6px; display:flex;">
        <button type="button" class="pill-btn pill-btn-action" style="padding:6px 12px;" onclick="pongMpRespondToChallenge('${m.id}', true)">Accept</button>
        <button type="button" class="pill-btn" style="padding:6px 12px;" onclick="pongMpRespondToChallenge('${m.id}', false)">Decline</button>
      </div>`)).join('') : '<div class="empty">No pending challenges.</div>';
  }
  const outgoingEl = document.getElementById('pongOutgoingChallenges');
  if(outgoingEl){
    outgoingEl.innerHTML = outgoing.length ? outgoing.map(m => pongMpMatchRow(m.id, m, 'opponentUid',
      `<div class="mines-status-cell"><button type="button" class="pill-btn" style="padding:6px 12px;" onclick="pongMpCancelChallenge('${m.id}')">Cancel</button></div>`)).join('') : '<div class="empty">Nothing sent yet.</div>';
  }
  const acceptedEl = document.getElementById('pongAcceptedMatches');
  if(acceptedEl){
    acceptedEl.innerHTML = accepted.length ? accepted.map(m => {
      const opponentField = m.challengerUid === currentUserUid ? 'opponentUid' : 'challengerUid';
      return pongMpMatchRow(m.id, m, opponentField, `<div class="mines-status-cell"><span class="lbl">Status</span><span class="val" style="color:var(--win);">Locked in</span></div>`);
    }).join('') : '<div class="empty">No accepted matches yet.</div>';
  }
}

function pongMpSetMode(mode){
  pongMpMode = mode;
  const cpuBtn = document.getElementById('pongModeCpuBtn');
  const mpBtn = document.getElementById('pongModeMultiplayerBtn');
  const cpuWrap = document.getElementById('pongCpuModeWrap');
  const mpWrap = document.getElementById('pongMultiplayerWrap');
  const statusRow = document.getElementById('pongCpuStatusRow');
  const modeHint = document.getElementById('pongModeHint');
  if(cpuBtn) cpuBtn.classList.toggle('active', mode === 'cpu');
  if(mpBtn) mpBtn.classList.toggle('active', mode === 'multiplayer');
  if(cpuWrap) cpuWrap.style.display = mode === 'cpu' ? '' : 'none';
  if(mpWrap) mpWrap.style.display = mode === 'multiplayer' ? '' : 'none';
  if(statusRow) statusRow.style.display = mode === 'cpu' ? '' : 'none';
  if(modeHint) modeHint.textContent = mode === 'cpu'
    ? 'Rally against the CPU for as long as you can — the ball speeds up in steps every 5 returns, and the CPU can only track it so fast. One miss ends the run. No stake, no risk — only your best score each day earns XP, so practice as much as you like.'
    : 'Challenge another member with a stake on the line. Matchmaking is live — head-to-head gameplay is still being built.';

  // Only poll for challenges while this sub-view is actually visible —
  // same "don't do work off-screen" convention as everywhere else in
  // this app (e.g. Craps/Plinko only build on first open).
  if(mode === 'multiplayer'){
    pongMpPopulateOpponentSelect();
    pongMpRefresh();
    if(!pongMpPollInterval) pongMpPollInterval = setInterval(pongMpRefresh, 5000);
  } else if(pongMpPollInterval){
    clearInterval(pongMpPollInterval);
    pongMpPollInterval = null;
  }
}
document.getElementById('pongModeCpuBtn').addEventListener('click', () => pongMpSetMode('cpu'));
document.getElementById('pongModeMultiplayerBtn').addEventListener('click', () => pongMpSetMode('multiplayer'));
document.getElementById('pongSendChallengeBtn').addEventListener('click', pongMpSendChallenge);
