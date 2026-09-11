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
  { threshold: 5,  xp: 500 },
  { threshold: 15, xp: 1500 },
  { threshold: 30, xp: 4000 },
  { threshold: 50, xp: 10000 },
  { threshold: 75, xp: 20000 }
];
let pongBuilt = false;
let pongBestToday = 0;
let pongRunning = false;
let pongScore = 0;
let pongAnimId = null;
let pongState = null; // { player:{y}, cpu:{y}, ball:{x,y,vx,vy}, speedMult }
const PONG_W = 320, PONG_H = 200, PONG_PADDLE_H = 36, PONG_PADDLE_W = 6, PONG_BALL_R = 4;

function pongBuildTierTable(){
  const table = document.getElementById('pongTierTable');
  if(!table) return;
  table.innerHTML = PONG_TIERS.map(t => `<tr><td>${t.threshold}+ returns</td><td style="text-align:right;">+${t.xp.toLocaleString()} XP</td></tr>`).join('');
}
async function pongInit(){
  pongBuilt = true;
  pongBuildTierTable();
  await pongFetchBestToday();
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
function pongResetVisual(){
  const canvas = document.getElementById('pongCanvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  pongDrawFrame(ctx, { player: { y: PONG_H / 2 - PONG_PADDLE_H / 2 }, cpu: { y: PONG_H / 2 - PONG_PADDLE_H / 2 }, ball: { x: PONG_W / 2, y: PONG_H / 2 } });
  const scoreEl = document.getElementById('pongCurrentScoreVal');
  if(scoreEl) scoreEl.textContent = '0';
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
function pongStart(){
  if(pongRunning) return;
  pongRunning = true;
  pongScore = 0;
  document.getElementById('pongGameOverOverlay').style.display = 'none';
  document.getElementById('pongCurrentScoreVal').textContent = '0';
  document.getElementById('pongStartBtn').style.display = 'none';
  scrollIntoViewSmooth('pongTableRail');
  const angle = (Math.random() * 0.6 - 0.3);
  pongState = {
    player: { y: PONG_H / 2 - PONG_PADDLE_H / 2 },
    cpu: { y: PONG_H / 2 - PONG_PADDLE_H / 2, aimError: 0 },
    ball: { x: PONG_W / 2, y: PONG_H / 2, vx: (Math.random() < 0.5 ? -1 : 1) * 2.1, vy: angle * 3 },
    speedMult: 1
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
  // Bounce off top/bottom walls
  if(b.y - PONG_BALL_R < 0){ b.y = PONG_BALL_R; b.vy = Math.abs(b.vy); }
  if(b.y + PONG_BALL_R > PONG_H){ b.y = PONG_H - PONG_BALL_R; b.vy = -Math.abs(b.vy); }

  // CPU tracks the ball with a capped speed and a per-approach aim
  // error — this, combined with the ball speeding up over time, is
  // what makes it beatable rather than a flawless wall. Re-rolled each
  // time the ball turns back toward the CPU, not every frame, so it
  // reads as a genuine (if imperfect) read on the shot rather than
  // jitter.
  if(b.vx > 0){
    if(s.cpu.aimError === 0) s.cpu.aimError = (Math.random() * 26 - 13);
    const targetY = b.y + s.cpu.aimError - PONG_PADDLE_H / 2;
    const cpuMaxSpeed = 3.1;
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
      s.speedMult = Math.min(2.6, s.speedMult * 1.045);
      const speed = 2.1 * s.speedMult;
      b.vx = Math.abs(speed);
      b.vy = hitPos * 3.2;
      b.x = PONG_PADDLE_W + 2 + PONG_BALL_R;
      pongScore++;
      document.getElementById('pongCurrentScoreVal').textContent = pongScore.toLocaleString();
      pongPlayHitBeep(220);
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
      b.vx = -Math.abs(2.1 * s.speedMult);
      b.vy = hitPos * 3.2;
      b.x = PONG_W - PONG_PADDLE_W - 2 - PONG_BALL_R;
      pongPlayHitBeep(330);
    } else if(b.x + PONG_BALL_R > PONG_W){
      pongScore += 3;
      document.getElementById('pongCurrentScoreVal').textContent = pongScore.toLocaleString();
      pongPlayHitBeep(440);
      b.x = PONG_W / 2; b.y = PONG_H / 2;
      b.vx = -Math.abs(2.1 * s.speedMult);
      b.vy = (Math.random() * 0.6 - 0.3) * 3;
    }
  }
}
function pongDrawFrame(ctx, s){
  ctx.clearRect(0, 0, PONG_W, PONG_H);
  // Centre dashed line
  ctx.strokeStyle = 'rgba(255,214,120,.25)'; ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
  ctx.beginPath(); ctx.moveTo(PONG_W / 2, 0); ctx.lineTo(PONG_W / 2, PONG_H); ctx.stroke();
  ctx.setLineDash([]);
  // Paddles
  ctx.fillStyle = '#FFE078';
  ctx.fillRect(2, s.player.y, PONG_PADDLE_W, PONG_PADDLE_H);
  ctx.fillRect(PONG_W - PONG_PADDLE_W - 2, s.cpu.y, PONG_PADDLE_W, PONG_PADDLE_H);
  // Ball
  ctx.beginPath(); ctx.arc(s.ball.x, s.ball.y, PONG_BALL_R, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
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
