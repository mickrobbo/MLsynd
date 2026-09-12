// ---- Mini Golf ----
// Single-player 18-hole course, practice against par — no per-round XP
// (unlike Pong's CPU-challenge tiers), just a live weekly leaderboard
// where whoever posts the best 18-hole round each week wins a flat
// 100,000 XP prize once the week rolls over. Ported from a standalone
// preview build (iterated on directly with the user across several
// rounds of hole-design fixes, physics polish, and visual polish)
// rather than built fresh here — the preview's approved gameplay and
// look are unchanged, only wired into this app's real Firebase/XP/UI
// conventions.
//
// Every top-level identifier here is prefixed mg* (constants MG_*),
// matching casino-pong.js's own pong*/PONG_* convention — this file
// shares one global scope with every other casino-*.js file loaded on
// the page, so generic names like `ball`, `moving`, `canvas`, `loop`,
// `W`/`H` would silently collide with Pong's own identically-generic
// physics variables. Confirmed by grep against the existing files
// before choosing this prefix, not assumed.

// ================= PHYSICS ENGINE =================
// Kept deliberately simple and self-contained for this preview — a
// fixed-size table (480x300, matching Pong's landscape convention so
// the two games sit visually consistently in the dashboard later),
// circle-vs-line-segment wall collision, and a generous cup capture
// radius so sinking a putt doesn't feel like a coin-flip.
const MG_W = 480, MG_H = 300;
const MG_BALL_R = 6;
const MG_WALL_THICKNESS = 7;
const MG_FRICTION = 0.986;
const MG_SAND_FRICTION = 0.935;
const MG_STOP_SPEED = 0.045;
const MG_WALL_RESTITUTION = 0.72;
const MG_BUMPER_RESTITUTION = 1.25;
const MG_MAX_DRAG_PX = 100; // full-power drag distance in on-screen pixels (scaled to mgCanvas internal size at read-time)
const MG_MAX_SHOT_SPEED = 9.2;

function mgDist(x1,y1,x2,y2){ return Math.hypot(x2-x1, y2-y1); }

function mgRoundRectPath(context, x, y, w, h, r){
  context.beginPath();
  context.moveTo(x+r, y);
  context.arcTo(x+w, y, x+w, y+h, r);
  context.arcTo(x+w, y+h, x, y+h, r);
  context.arcTo(x, y+h, x, y, r);
  context.arcTo(x, y, x+w, y, r);
  context.closePath();
}

// Reflects the mgBall off a thick line segment (a "wall"). Returns true
// if a collision happened this frame.
function mgCollideSegment(mgBall, mgSeg, restitution){
  const dx = mgSeg.x2-mgSeg.x1, dy = mgSeg.y2-mgSeg.y1;
  const len2 = dx*dx + dy*dy;
  let t = len2 ? ((mgBall.x-mgSeg.x1)*dx + (mgBall.y-mgSeg.y1)*dy)/len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = mgSeg.x1 + t*dx, cy = mgSeg.y1 + t*dy;
  const nx0 = mgBall.x-cx, ny0 = mgBall.y-cy;
  const d = Math.hypot(nx0, ny0);
  const minDist = mgBall.r + MG_WALL_THICKNESS/2;
  if(d < minDist && d > 0.0001){
    const nx = nx0/d, ny = ny0/d;
    const overlap = minDist - d;
    mgBall.x += nx*overlap; mgBall.y += ny*overlap;
    const vDotN = mgBall.vx*nx + mgBall.vy*ny;
    if(vDotN < 0){
      mgBall.vx -= (1+restitution)*vDotN*nx;
      mgBall.vy -= (1+restitution)*vDotN*ny;
    }
    return true;
  }
  return false;
}

function mgCollideBumper(mgBall, bumper){
  const d = mgDist(mgBall.x, mgBall.y, bumper.x, bumper.y);
  const minDist = mgBall.r + bumper.r;
  if(d < minDist && d > 0.0001){
    const nx = (mgBall.x-bumper.x)/d, ny = (mgBall.y-bumper.y)/d;
    mgBall.x = bumper.x + nx*minDist;
    mgBall.y = bumper.y + ny*minDist;
    const speed = Math.hypot(mgBall.vx, mgBall.vy);
    const kick = Math.max(speed, 1.5) * MG_BUMPER_RESTITUTION;
    mgBall.vx = nx*kick; mgBall.vy = ny*kick;
    return true;
  }
  return false;
}

function mgInZone(x, y, zone){
  if(zone.type === 'circle') return mgDist(x,y,zone.x,zone.y) <= zone.r;
  return x >= zone.x && x <= zone.x+zone.w && y >= zone.y && y <= zone.y+zone.h;
}

// Resolves one physics tick. `hole` carries walls/bumpers/sand/water/cup.
// `mgOnSplash` fires when the mgBall needs to reset to its last safe spot.
function mgStepPhysics(mgBall, hole, t, mgOnSplash){
  const speed = Math.hypot(mgBall.vx, mgBall.vy);

  // A slope is a constant per-tick acceleration in a fixed direction
  // (fx, fy) — the mini-golf equivalent of gravity pulling along an
  // incline. Checked before the "has the mgBall stopped" test below on
  // purpose: a real sloped green never lets a mgBall come to rest on
  // it, it just keeps creeping downhill until it rolls off — so while
  // inside a slope zone, the early-exit for "basically stopped" is
  // skipped entirely rather than letting the mgBall freeze mid-slope.
  let activeSlope = null;
  for(const sl of hole.slopes||[]) if(mgInZone(mgBall.x, mgBall.y, sl)){ activeSlope = sl; break; }

  if(speed < MG_STOP_SPEED && !activeSlope){ mgBall.vx = 0; mgBall.vy = 0; return { mgMoving:false, sunk:false }; }

  let inSand = false;
  for(const s of hole.sand||[]) if(mgInZone(mgBall.x, mgBall.y, s)) { inSand = true; break; }
  const f = inSand ? MG_SAND_FRICTION : MG_FRICTION;

  if(activeSlope){ mgBall.vx += activeSlope.fx; mgBall.vy += activeSlope.fy; }

  mgBall.x += mgBall.vx; mgBall.y += mgBall.vy;
  mgBall.vx *= f; mgBall.vy *= f;

  const walls = mgWallsForHole(hole, t);
  for(const mgSeg of walls) mgCollideSegment(mgBall, mgSeg, MG_WALL_RESTITUTION);
  for(const b of hole.bumpers||[]) mgCollideBumper(mgBall, b);

  for(const w of hole.water||[]){
    if(mgInZone(mgBall.x, mgBall.y, w)){ mgOnSplash(); return { mgMoving:false, sunk:false }; }
  }

  if(mgDist(mgBall.x, mgBall.y, hole.cup.x, hole.cup.y) <= hole.cupRadius){
    return { mgMoving:false, sunk:true };
  }

  return { mgMoving: Math.hypot(mgBall.vx, mgBall.vy) >= MG_STOP_SPEED || !!activeSlope, sunk:false };
}

// Border + any hole-specific static walls, plus a resolved snapshot of
// any mgMoving walls (e.g. Hole 14's rotating blade) at time t (ms).
function mgWallsForHole(hole, t){
  const list = hole.walls.slice();
  if(hole.movingWalls){
    for(const mw of hole.movingWalls) list.push(mw.resolve(t));
  }
  return list;
}

const MG_BORDER = { x:8, y:8, w:MG_W-16, h:MG_H-16 };
function mgBorderWalls(b){
  b = b || MG_BORDER;
  return [
    { x1:b.x, y1:b.y, x2:b.x+b.w, y2:b.y },
    { x1:b.x+b.w, y1:b.y, x2:b.x+b.w, y2:b.y+b.h },
    { x1:b.x+b.w, y1:b.y+b.h, x2:b.x, y2:b.y+b.h },
    { x1:b.x, y1:b.y+b.h, x2:b.x, y2:b.y }
  ];
}
function mgSeg(x1,y1,x2,y2){ return {x1,y1,x2,y2}; }

// ================= 18 HOLE LAYOUTS =================
// Fixed 480x300 table for every hole (matches Pong's landscape
// mgCanvas), with each hole's own internal walls/hazards laid out
// within it. Par distribution is deliberately front-loaded easy,
// building in variety (doglegs, sand, water, bumpers, a mgMoving
// obstacle) rather than just "longer = harder every time."
const MG_HOLES = [
  // 1 — straight tutorial shot
  { par:2, start:{x:60,y:150}, cup:{x:420,y:150}, cupRadius:11,
    walls:[...mgBorderWalls()] },

  // 2 — gentle bend via one angled wall, now with an uphill patch
  // fighting the approach — a soft putt won't have enough left in it
  // to clear the wall's gap anymore
  { par:2, start:{x:60,y:230}, cup:{x:420,y:70}, cupRadius:11,
    walls:[...mgBorderWalls(), mgSeg(240,300,240,120)],
    slopes:[{type:'rect', x:90,y:140,w:130,h:150, fx:-0.045, fy:0.02}] },

  // 3 — real L-shaped dogleg: the wall now actually sits across the
  // direct line between start and cup (previously it didn't — see the
  // reported screenshot), forcing a genuine detour below it before
  // turning toward the cup
  { par:3, start:{x:60,y:240}, cup:{x:420,y:60}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(200,8,200,220)] },

  // 4 — narrow chute, tightened from an 80px gap to 60px for more precision
  { par:3, start:{x:40,y:150}, cup:{x:440,y:150}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(180,8,180,120), mgSeg(180,180,180,292), mgSeg(300,8,300,120), mgSeg(300,180,300,292)] },

  // 5 — single mid-course bumper, now with a downhill patch right
  // before it — coming in too hot off the slope makes the bumper's
  // kick far less predictable
  { par:3, start:{x:50,y:270}, cup:{x:430,y:30}, cupRadius:10,
    walls:[...mgBorderWalls()], bumpers:[{x:240,y:150,r:20}],
    slopes:[{type:'circle', x:190,y:200,r:55, fx:0.035, fy:-0.03}] },

  // 6 — Bridge Crossing: replaced the plain sand patch with a real
  // water crossing and a single wood-plank bridge to putt across
  { par:3, start:{x:50,y:150}, cup:{x:430,y:150}, cupRadius:10,
    walls:[...mgBorderWalls()],
    water:[{type:'rect',x:190,y:8,w:120,h:107},{type:'rect',x:190,y:185,w:120,h:107}],
    bridges:[{x:190,y:115,w:120,h:70}] },

  // 7 — genuine S-turn: two full gates on alternating sides, replacing
  // the previous two disconnected floating walls that only grazed the
  // direct line by coincidence rather than reliably forcing a detour
  { par:4, start:{x:40,y:270}, cup:{x:440,y:60}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(180,8,180,210), mgSeg(340,110,340,292)] },

  // 8 — arc around a water hazard
  { par:3, start:{x:50,y:150}, cup:{x:430,y:150}, cupRadius:10,
    walls:[...mgBorderWalls()], water:[{type:'circle',x:240,y:150,r:55}] },

  // 9 — S-curve corridor, now with an uphill patch mid-curve stacking
  // on top of the existing precision demands
  { par:4, start:{x:40,y:40}, cup:{x:440,y:260}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(160,8,160,190), mgSeg(320,110,320,292)],
    slopes:[{type:'rect', x:210,y:90,w:90,h:110, fx:-0.03, fy:-0.03}] },

  // 10 — island green: FIXED — the water previously spanned the full
  // table height with no gap at all, making this hole genuinely
  // impossible to complete, not just hard. Now there's a real (and
  // tightened, for challenge) 70px bridge to putt through at each
  // crossing, with an actual wood-plank bridge rendered over each gap.
  { par:3, start:{x:50,y:150}, cup:{x:430,y:150}, cupRadius:11,
    walls:[...mgBorderWalls()],
    water:[
      {type:'rect',x:170,y:8,w:26,h:107}, {type:'rect',x:170,y:185,w:26,h:107},
      {type:'rect',x:340,y:8,w:26,h:107}, {type:'rect',x:340,y:185,w:26,h:107}
    ],
    bridges:[{x:170,y:115,w:26,h:70},{x:340,y:115,w:26,h:70}] },

  // 11 — pinball bumper cluster
  { par:4, start:{x:40,y:150}, cup:{x:440,y:150}, cupRadius:10,
    walls:[...mgBorderWalls()],
    bumpers:[{x:180,y:110,r:16},{x:180,y:190,r:16},{x:300,y:150,r:18}] },

  // 12 — narrow gate right before the cup, tightened from 60px to 40px
  { par:3, start:{x:50,y:150}, cup:{x:430,y:150}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(360,8,360,130), mgSeg(360,170,360,292)] },

  // 13 — big sand trap, half the hole, now with a downhill run-up
  // that makes entry speed much harder to control before you're
  // fighting the sand's friction on top of it
  { par:4, start:{x:40,y:150}, cup:{x:440,y:150}, cupRadius:10,
    walls:[...mgBorderWalls()], sand:[{type:'rect',x:220,y:8,w:180,h:284}],
    slopes:[{type:'rect', x:150,y:40,w:70,h:220, fx:0.05, fy:0}] },

  // 14 — Windmill Alley: a rotating blade you have to time
  { par:3, start:{x:50,y:150}, cup:{x:430,y:150}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(240,8,240,110), mgSeg(240,190,240,292)],
    movingWalls:[{
      resolve: (t) => {
        const angle = (t/650) % (Math.PI*2);
        const cx=240, cy=150, len=68;
        return mgSeg(cx+Math.cos(angle)*len, cy+Math.sin(angle)*len, cx-Math.cos(angle)*len, cy-Math.sin(angle)*len);
      }
    }] },

  // 15 — split path around a central block, now with a slope pulling
  // toward the block on BOTH routes — neither side is a free pass anymore
  { par:4, start:{x:40,y:150}, cup:{x:440,y:150}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(220,90,260,90), mgSeg(260,90,260,210), mgSeg(260,210,220,210), mgSeg(220,210,220,90)],
    slopes:[{type:'rect', x:220,y:8,w:40,h:82, fx:0, fy:0.04}, {type:'rect', x:220,y:218,w:40,h:74, fx:0, fy:-0.04}] },

  // 16 — the marathon hole: FIXED — previously the entire maze sat to
  // the right of a direct line that ran straight up the clear left
  // margin (same bug as the old Hole 3), so it was never actually
  // engaged. Now three full gates alternating low/high/low genuinely
  // force an S-shaped route across the whole table.
  { par:5, start:{x:40,y:30}, cup:{x:440,y:270}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(130,8,130,190), mgSeg(250,292,250,90), mgSeg(370,8,370,190)] },

  // 17 — risk/reward near the cup: FIXED — the bumper previously sat
  // dead-center in an already-narrow 60px gap, so there was no
  // reliable clean shot at all (any hit near center gets flung
  // unpredictably by the bumper's energetic bounce). Now the gate is
  // wider (90px) and the bumper sits low, off-center — a straight
  // putt through the middle clears it entirely; drifting low toward
  // the bumper is the optional risk, not a mandatory gauntlet.
  { par:3, start:{x:50,y:150}, cup:{x:430,y:150}, cupRadius:10,
    walls:[...mgBorderWalls(), mgSeg(340,8,340,105), mgSeg(340,195,340,292)],
    bumpers:[{x:340,y:180,r:12}] },

  // 18 — grand finale: water, sand, a dogleg, and now a downhill patch
  // right by the cup — the classic mini-golf finishing trap, where a
  // firm putt that would've been fine anywhere else on the table now
  // runs straight past the hole
  { par:5, start:{x:40,y:40}, cup:{x:440,y:270}, cupRadius:11,
    walls:[...mgBorderWalls(), mgSeg(200,8,200,150)],
    sand:[{type:'rect',x:280,y:170,w:150,h:60}],
    water:[{type:'circle',x:340,y:80,r:38}],
    slopes:[{type:'circle', x:390,y:220,r:45, fx:0.02, fy:0.025}] }
];

// ================= GAME STATE =================
let mgHoleIndex = 0;
let mgStrokesThisHole = 0;
let mgTotalStrokes = 0;
let mgScoreHistory = []; // {par, strokes} per completed hole
let mgBall = { x:0, y:0, vx:0, vy:0, r:MG_BALL_R, rollAngle:0 };
let mgBallTrail = []; // recent positions while mgMoving, for a fading motion trail
let mgLastSafe = { x:0, y:0 };
let mgMoving = false;
let mgAiming = false;
let mgAimStart = { x:0, y:0 };
let mgAimCurrent = { x:0, y:0 };
let mgAnimId = null;
let mgSinkAnim = null; // {startT, label} — the quick flash played right as a putt sinks

const mgCanvas = document.getElementById('mgCanvas');
const mgCtx = mgCanvas.getContext('2d');

// ---- Per-hole static texture, baked once into an offscreen mgCanvas ----
// Grass speckle and sand speckle are the same every frame for a given
// hole, so generating them with Math.random() inside mgDrawFrame would
// make the texture visibly crawl/flicker every tick (a new random
// pattern 60 times a second). Baking it once per hole load into an
// offscreen mgCanvas — using a small seeded PRNG so it's deterministic,
// same technique as pong-mp-engine.js's mgMulberry32 — fixes that and is
// also cheaper: one blit per frame instead of hundreds of fillRect
// calls.
function mgMulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let mgHoleTexture = null;
function mgBuildHoleTexture(hole, idx){
  const c = document.createElement('canvas');
  c.width = MG_W; c.height = MG_H;
  const tctx = c.getContext('2d');
  const rng = mgMulberry32(idx * 7919 + 11);

  // Base felt — a richer three-stop gradient (a flat 2-color fade
  // reads as flat CSS, not a lit surface) plus a soft vignette toward
  // the edges so the table has real depth rather than looking like a
  // flat green rectangle.
  const grad = tctx.createLinearGradient(0, 0, 0, MG_H);
  grad.addColorStop(0, '#2a5a3e'); grad.addColorStop(0.45, '#204a34'); grad.addColorStop(1, '#122a1e');
  tctx.fillStyle = grad; tctx.fillRect(0, 0, MG_W, MG_H);

  // A single directional "sun" glow (upper-left) instead of a purely
  // symmetric top-down fill — real, consistent light direction is
  // most of what separates a flat-looking render from a lit one.
  const sun = tctx.createRadialGradient(MG_W*0.22, MG_H*0.16, 10, MG_W*0.22, MG_H*0.16, MG_W*0.6);
  sun.addColorStop(0, 'rgba(255,255,255,0.11)');
  sun.addColorStop(1, 'rgba(255,255,255,0)');
  tctx.fillStyle = sun; tctx.fillRect(0, 0, MG_W, MG_H);

  const vignette = tctx.createRadialGradient(MG_W/2, MG_H*0.42, MG_H*0.25, MG_W/2, MG_H*0.5, MG_W*0.62);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.32)');
  tctx.fillStyle = vignette; tctx.fillRect(0, 0, MG_W, MG_H);

  // Rough vs. fairway — a real course isn't one uniform texture; a
  // darker band lines the inside of the border rail (the "rough"),
  // leaving the smoother, lighter body of the hole (the "fairway")
  // for the actual line of play. Baked as a simple inset frame so it
  // applies to every layout without per-hole tuning.
  tctx.save();
  tctx.strokeStyle = 'rgba(0,0,0,0.15)';
  tctx.lineWidth = 26;
  tctx.strokeRect(8+13, 8+13, MG_W-16-26, MG_H-16-26);
  tctx.restore();

  // mow stripes with alternating intensity, like a real cut fairway
  for(let x=0, i=0; x<MG_W; x+=32, i++){
    tctx.fillStyle = i%2===0 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.03)';
    tctx.fillRect(x, 0, 16, MG_H);
  }

  // Grass texture — short angled blade-like strokes rather than plain
  // square speckle dots, which reads much closer to actual turf at
  // this scale (a dot is a fleck of dirt; a short stroke is a blade).
  for(let i=0; i<190; i++){
    const gx = rng()*MG_W, gy = rng()*MG_H;
    const lean = -0.35 + rng()*0.7, len = 2.6 + rng()*3;
    tctx.strokeStyle = `rgba(255,255,255,${0.035+rng()*0.04})`;
    tctx.lineWidth = 1;
    tctx.beginPath();
    tctx.moveTo(gx, gy);
    tctx.lineTo(gx+Math.sin(lean)*len, gy-Math.cos(lean)*len);
    tctx.stroke();
  }
  for(let i=0; i<160; i++){
    const gx = rng()*MG_W, gy = rng()*MG_H;
    const lean = -0.35 + rng()*0.7, len = 2.6 + rng()*3;
    tctx.strokeStyle = `rgba(0,0,0,${0.035+rng()*0.04})`;
    tctx.lineWidth = 1;
    tctx.beginPath();
    tctx.moveTo(gx, gy);
    tctx.lineTo(gx+Math.sin(lean)*len, gy-Math.cos(lean)*len);
    tctx.stroke();
  }

  // sand zones baked in with their own speckle and a soft inset shadow
  // along the rim so they read as a shallow pit, not a flat sticker
  (hole.sand||[]).forEach(z => {
    tctx.save();
    tctx.beginPath();
    if(z.type === 'circle') tctx.arc(z.x, z.y, z.r, 0, Math.PI*2);
    else tctx.rect(z.x, z.y, z.w, z.h);
    tctx.clip();
    const bx = z.type === 'circle' ? z.x-z.r : z.x, by = z.type === 'circle' ? z.y-z.r : z.y;
    const bw = z.type === 'circle' ? z.r*2 : z.w, bh = z.type === 'circle' ? z.r*2 : z.h;
    const sgrad = tctx.createLinearGradient(bx, by, bx, by+bh);
    sgrad.addColorStop(0, '#e8d29c'); sgrad.addColorStop(1, '#cdb175');
    tctx.fillStyle = sgrad;
    tctx.fillRect(bx, by, bw, bh);
    for(let i=0; i<120; i++){
      tctx.fillStyle = `rgba(120,95,45,${0.15+rng()*0.2})`;
      tctx.fillRect(bx+rng()*bw, by+rng()*bh, 1.6, 1.6);
    }
    // inset rim shadow so the sand looks slightly recessed
    const rimGrad = z.type === 'circle'
      ? tctx.createRadialGradient(z.x, z.y, z.r*0.7, z.x, z.y, z.r)
      : tctx.createLinearGradient(bx, by, bx, by+bh);
    if(z.type === 'circle'){
      rimGrad.addColorStop(0, 'rgba(0,0,0,0)'); rimGrad.addColorStop(1, 'rgba(60,45,15,.35)');
      tctx.fillStyle = rimGrad; tctx.fillRect(bx, by, bw, bh);
    } else {
      tctx.fillStyle = 'rgba(60,45,15,.22)';
      tctx.fillRect(bx, by, bw, 6);
      tctx.fillRect(bx, by+bh-6, bw, 6);
    }
    tctx.restore();
  });

  // Slopes — shaded gradient (lighter uphill end, darker downhill
  // end) plus a grid of small chevrons pointing downhill, the same
  // visual language real mini-golf courses use so the direction is
  // legible before you ever putt into one.
  (hole.slopes||[]).forEach(sl => {
    const isCircle = sl.type === 'circle';
    const bx = isCircle ? sl.x-sl.r : sl.x, by = isCircle ? sl.y-sl.r : sl.y;
    const bw = isCircle ? sl.r*2 : sl.w, bh = isCircle ? sl.r*2 : sl.h;
    tctx.save();
    tctx.beginPath();
    if(isCircle) tctx.arc(sl.x, sl.y, sl.r, 0, Math.PI*2);
    else tctx.rect(sl.x, sl.y, sl.w, sl.h);
    tctx.clip();
    const flen = Math.hypot(sl.fx, sl.fy) || 1;
    const ux = sl.fx/flen, uy = sl.fy/flen; // unit downhill direction
    const cx = bx+bw/2, cy = by+bh/2, half = Math.max(bw,bh)/2;
    const shadeGrad = tctx.createLinearGradient(cx-ux*half, cy-uy*half, cx+ux*half, cy+uy*half);
    shadeGrad.addColorStop(0, 'rgba(255,255,255,0.07)'); // uphill = lighter, catching more light
    shadeGrad.addColorStop(1, 'rgba(0,0,0,0.14)'); // downhill = darker, in the "lee" of the slope
    tctx.fillStyle = shadeGrad;
    tctx.fillRect(bx, by, bw, bh);

    const angle = Math.atan2(sl.fy, sl.fx);
    const cols = Math.max(1, Math.round(bw/34));
    const rows = Math.max(1, Math.round(bh/34));
    tctx.strokeStyle = 'rgba(255,255,255,.28)';
    tctx.lineWidth = 1.4;
    tctx.lineCap = 'round';
    for(let r=0; r<rows; r++){
      for(let col=0; col<cols; col++){
        const px = bx + (col+0.5)*(bw/cols), py = by + (r+0.5)*(bh/rows);
        tctx.save();
        tctx.translate(px, py); tctx.rotate(angle);
        tctx.beginPath();
        tctx.moveTo(-5,-5); tctx.lineTo(3,0); tctx.lineTo(-5,5);
        tctx.stroke();
        tctx.restore();
      }
    }
    tctx.restore();
  });

  // Bridges — wood-plank crossing with brass side rails, always laid
  // over a gap deliberately left in a water zone (see the hole
  // definitions) so the "safe lane" reads as a real structure instead
  // of an unmarked patch of grass between two hazards.
  (hole.bridges||[]).forEach(br => {
    const horizontal = br.w >= br.h;
    tctx.save();
    tctx.beginPath(); tctx.rect(br.x, br.y, br.w, br.h); tctx.clip();
    const plankGrad = horizontal
      ? tctx.createLinearGradient(br.x, br.y, br.x, br.y+br.h)
      : tctx.createLinearGradient(br.x, br.y, br.x+br.w, br.y);
    plankGrad.addColorStop(0, '#a9814f'); plankGrad.addColorStop(0.5, '#8a6a3a'); plankGrad.addColorStop(1, '#6b5028');
    tctx.fillStyle = plankGrad;
    tctx.fillRect(br.x, br.y, br.w, br.h);
    const seamCount = Math.max(2, Math.floor((horizontal ? br.w : br.h) / 13));
    tctx.strokeStyle = 'rgba(0,0,0,.3)'; tctx.lineWidth = 1.3;
    for(let i=1; i<seamCount; i++){
      tctx.beginPath();
      if(horizontal){
        const sx = br.x + i*(br.w/seamCount);
        tctx.moveTo(sx, br.y); tctx.lineTo(sx, br.y+br.h);
      } else {
        const sy = br.y + i*(br.h/seamCount);
        tctx.moveTo(br.x, sy); tctx.lineTo(br.x+br.w, sy);
      }
      tctx.stroke();
    }
    tctx.restore();
    tctx.strokeStyle = '#c9a24b'; tctx.lineWidth = 3;
    if(horizontal){
      tctx.beginPath(); tctx.moveTo(br.x, br.y+2); tctx.lineTo(br.x+br.w, br.y+2); tctx.stroke();
      tctx.beginPath(); tctx.moveTo(br.x, br.y+br.h-2); tctx.lineTo(br.x+br.w, br.y+br.h-2); tctx.stroke();
    } else {
      tctx.beginPath(); tctx.moveTo(br.x+2, br.y); tctx.lineTo(br.x+2, br.y+br.h); tctx.stroke();
      tctx.beginPath(); tctx.moveTo(br.x+br.w-2, br.y); tctx.lineTo(br.x+br.w-2, br.y+br.h); tctx.stroke();
    }
  });

  // Contact shadows — a soft dark offset following every static wall
  // (border + interior), consistent with the upper-left light source
  // above, so walls read as objects actually sitting on the grass
  // rather than flat decals painted on top of it. The live wall
  // itself (drawn fresh every frame in mgDrawFrame, since it also has
  // to render the one mgMoving wall) covers most of this — only the
  // offset edge peeks out, which is exactly the effect wanted.
  tctx.save();
  tctx.strokeStyle = 'rgba(0,0,0,0.3)';
  tctx.lineWidth = MG_WALL_THICKNESS + 1;
  tctx.lineCap = 'round';
  hole.walls.forEach(w => {
    tctx.beginPath();
    tctx.moveTo(w.x1+3, w.y1+3); tctx.lineTo(w.x2+3, w.y2+3);
    tctx.stroke();
  });
  tctx.restore();

  // Tee sign — a small numbered plaque at the start position, the way
  // an actual mini-golf course marks each hole. Placed above the tee
  // by default, but below it on any hole whose start sits too close
  // to the top edge to fit a sign above without clipping.
  const teeAbove = hole.start.y > 50;
  const signY = teeAbove ? hole.start.y - 30 : hole.start.y + 30;
  tctx.save();
  mgRoundRectPath(tctx, hole.start.x-22, signY-13, 44, 26, 5);
  const signGrad = tctx.createLinearGradient(hole.start.x-22, signY-13, hole.start.x-22, signY+13);
  signGrad.addColorStop(0, '#3f331a'); signGrad.addColorStop(1, '#241c0c');
  tctx.fillStyle = signGrad; tctx.fill();
  tctx.strokeStyle = '#c9a24b'; tctx.lineWidth = 1.2; tctx.stroke();
  tctx.fillStyle = '#FFE078';
  tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
  tctx.font = "700 14px 'Barlow Condensed', sans-serif";
  tctx.fillText(String(idx+1), hole.start.x, signY-4);
  tctx.font = "600 8px 'Barlow Condensed', sans-serif";
  tctx.fillStyle = 'rgba(255,224,120,.8)';
  tctx.fillText(`PAR ${hole.par}`, hole.start.x, signY+8);
  tctx.restore();

  return c;
}

function mgCurrentHole(){ return MG_HOLES[mgHoleIndex]; }

function mgLoadHole(i){
  mgHoleIndex = i;
  const h = mgCurrentHole();
  mgBall.x = h.start.x; mgBall.y = h.start.y; mgBall.vx = 0; mgBall.vy = 0; mgBall.rollAngle = 0;
  mgBallTrail = [];
  mgLastSafe = { x:h.start.x, y:h.start.y };
  mgStrokesThisHole = 0;
  mgMoving = false;
  mgSinkAnim = null;
  mgHoleTexture = mgBuildHoleTexture(h, i);
  mgUpdateHud();
  document.getElementById('mgHoleOverlay').style.display = 'none';
}

function mgUpdateHud(){
  const h = mgCurrentHole();
  document.getElementById('mgHoleNumVal').textContent = `${mgHoleIndex+1} / 18`;
  document.getElementById('mgParVal').textContent = h.par;
  document.getElementById('mgStrokesVal').textContent = mgStrokesThisHole;
  const parSoFar = mgScoreHistory.reduce((s,e)=>s+e.par,0);
  const strokesSoFar = mgScoreHistory.reduce((s,e)=>s+e.strokes,0);
  const diff = strokesSoFar - parSoFar;
  const roundEl = document.getElementById('mgRoundVal');
  roundEl.textContent = diff === 0 ? 'E' : (diff > 0 ? `+${diff}` : `${diff}`);
  roundEl.style.color = diff < 0 ? 'var(--win)' : (diff > 0 ? 'var(--loss)' : 'var(--cream)');
}

function mgScoreLabel(strokes, par){
  const d = strokes - par;
  if(d <= -3) return 'Albatross!';
  if(d === -2) return 'Eagle!';
  if(d === -1) return 'Birdie!';
  if(d === 0) return 'Par';
  if(d === 1) return 'Bogey';
  if(d === 2) return 'Double Bogey';
  return `+${d}`;
}

function mgOnSplash(){
  mgStrokesThisHole += 1; // one-stroke water penalty, standard mini-golf/golf convention
  mgBall.x = mgLastSafe.x; mgBall.y = mgLastSafe.y; mgBall.vx = 0; mgBall.vy = 0;
  mgBallTrail = [];
  mgUpdateHud();
}

function mgOnSunk(t){
  mgMoving = false;
  mgBall.vx = 0; mgBall.vy = 0;
  const label = mgScoreLabel(mgStrokesThisHole, mgCurrentHole().par);
  mgSinkAnim = { startT: t, label, duration: 520 };
  setTimeout(() => {
    mgSinkAnim = null;
    mgScoreHistory.push({ par: mgCurrentHole().par, strokes: mgStrokesThisHole });
    mgUpdateHud(); // must run before showing either overlay — otherwise the scorebar's
                 // Round figure still reflects every hole EXCEPT the one just sunk
    if(mgHoleIndex === MG_HOLES.length-1){
      mgShowRoundComplete();
    } else {
      mgShowHoleComplete();
    }
  }, 520);
}

function mgShowHoleComplete(){
  const h = mgCurrentHole();
  document.getElementById('mgHoleOverlayTitle').textContent = mgScoreLabel(mgStrokesThisHole, h.par);
  document.getElementById('mgHoleOverlayScore').textContent = `${mgStrokesThisHole} stroke${mgStrokesThisHole===1?'':'s'} on a Par ${h.par}`;
  document.getElementById('mgHoleOverlay').style.display = 'flex';
}

function mgShowRoundComplete(){
  const parTotal = mgScoreHistory.reduce((s,e)=>s+e.par,0);
  const strokeTotal = mgScoreHistory.reduce((s,e)=>s+e.strokes,0);
  const diff = strokeTotal - parTotal;
  document.getElementById('mgRoundOverlayScore').textContent = `${strokeTotal} strokes`;
  document.getElementById('mgRoundOverlayDetail').textContent =
    diff === 0 ? 'Even par across 18 holes.' : (diff < 0 ? `${Math.abs(diff)} under par across 18 holes.` : `${diff} over par across 18 holes.`);
  document.getElementById('mgRoundOverlay').style.display = 'flex';
  mgSubmitWeeklyScore(strokeTotal);
}

// ================= RENDERING =================
function mgDrawWall(s, t, isBorder){
  const len = Math.hypot(s.x2-s.x1, s.y2-s.y1);
  const nx = len > 4 ? -(s.y2-s.y1)/len : 0, ny = len > 4 ? (s.x2-s.x1)/len : 0;

  if(isBorder){
    // The outer rail gets a distinct brushed-brass treatment, not the
    // same wood as interior obstacles — a real course's outer bumper
    // rail always reads differently from its internal hazards, and
    // using one texture for everything was a big part of the flat,
    // sample-y look.
    mgCtx.strokeStyle = '#5c4423';
    mgCtx.lineWidth = MG_WALL_THICKNESS + 3;
    mgCtx.lineCap = 'round';
    mgCtx.beginPath(); mgCtx.moveTo(s.x1,s.y1); mgCtx.lineTo(s.x2,s.y2); mgCtx.stroke();
    const grad = mgCtx.createLinearGradient(s.x1+nx*5, s.y1+ny*5, s.x1-nx*5, s.y1-ny*5);
    grad.addColorStop(0, '#8a713a'); grad.addColorStop(0.45, '#e8c878'); grad.addColorStop(0.55, '#e8c878'); grad.addColorStop(1, '#8a713a');
    mgCtx.strokeStyle = grad;
    mgCtx.lineWidth = MG_WALL_THICKNESS - 1;
    mgCtx.beginPath(); mgCtx.moveTo(s.x1,s.y1); mgCtx.lineTo(s.x2,s.y2); mgCtx.stroke();
    mgCtx.strokeStyle = 'rgba(255,255,255,.35)';
    mgCtx.lineWidth = 1;
    mgCtx.beginPath(); mgCtx.moveTo(s.x1+nx*2, s.y1+ny*2); mgCtx.lineTo(s.x2+nx*2, s.y2+ny*2); mgCtx.stroke();
    return;
  }

  // Interior obstacles: a real bevel — dark base, mid-tone body, then
  // a bright highlight offset to one side and a soft shadow on the
  // other, so the rail reads as a rounded 3D rib instead of a flat
  // painted bar with a couple of thin decorative grain lines on top.
  mgCtx.strokeStyle = '#4a3620';
  mgCtx.lineWidth = MG_WALL_THICKNESS + 2;
  mgCtx.lineCap = 'round';
  mgCtx.beginPath(); mgCtx.moveTo(s.x1,s.y1); mgCtx.lineTo(s.x2,s.y2); mgCtx.stroke();

  mgCtx.strokeStyle = '#8f6b3e';
  mgCtx.lineWidth = MG_WALL_THICKNESS - 2;
  mgCtx.beginPath(); mgCtx.moveTo(s.x1,s.y1); mgCtx.lineTo(s.x2,s.y2); mgCtx.stroke();

  if(len > 4){
    mgCtx.strokeStyle = 'rgba(255,224,170,.45)';
    mgCtx.lineWidth = 1.4;
    mgCtx.beginPath();
    mgCtx.moveTo(s.x1+nx*1.6, s.y1+ny*1.6); mgCtx.lineTo(s.x2+nx*1.6, s.y2+ny*1.6);
    mgCtx.stroke();
    mgCtx.strokeStyle = 'rgba(0,0,0,.4)';
    mgCtx.lineWidth = 1.6;
    mgCtx.beginPath();
    mgCtx.moveTo(s.x1-nx*2, s.y1-ny*2); mgCtx.lineTo(s.x2-nx*2, s.y2-ny*2);
    mgCtx.stroke();
  }
}

function mgDrawFrame(t){
  mgCtx.clearRect(0,0,MG_W,MG_H);
  if(mgHoleTexture) mgCtx.drawImage(mgHoleTexture, 0, 0);

  const h = mgCurrentHole();

  // Water — animated, drawn live (the only hazard that isn't baked
  // into the static texture, since it needs to visibly shimmer)
  (h.water||[]).forEach(z => {
    mgCtx.save();
    mgCtx.beginPath();
    if(z.type === 'circle') mgCtx.arc(z.x, z.y, z.r, 0, Math.PI*2);
    else mgCtx.rect(z.x, z.y, z.w, z.h);
    mgCtx.clip();
    const bx = z.type === 'circle' ? z.x-z.r : z.x, by = z.type === 'circle' ? z.y-z.r : z.y;
    const bw = z.type === 'circle' ? z.r*2 : z.w, bh = z.type === 'circle' ? z.r*2 : z.h;
    const wgrad = mgCtx.createLinearGradient(bx, by, bx, by+bh);
    wgrad.addColorStop(0, '#3f85b8'); wgrad.addColorStop(1, '#245e85');
    mgCtx.fillStyle = wgrad;
    mgCtx.fillRect(bx, by, bw, bh);
    // two soft shimmer bands drifting sideways over time
    for(let band=0; band<2; band++){
      const bandX = bx + ((t/900 + band*0.5) % 1) * (bw + 60) - 30;
      const bgrad = mgCtx.createLinearGradient(bandX-24, 0, bandX+24, 0);
      bgrad.addColorStop(0, 'rgba(255,255,255,0)');
      bgrad.addColorStop(0.5, 'rgba(255,255,255,0.16)');
      bgrad.addColorStop(1, 'rgba(255,255,255,0)');
      mgCtx.fillStyle = bgrad;
      mgCtx.fillRect(bandX-24, by, 48, bh);
    }
    mgCtx.restore();
  });

  mgBorderWalls().forEach(s => mgDrawWall(s, t, true));
  h.walls.slice(mgBorderWalls().length).forEach(s => mgDrawWall(s, t, false));
  if(h.movingWalls) h.movingWalls.forEach(mw => mgDrawWall(mw.resolve(t), t, false));

  (h.bumpers||[]).forEach((b, i) => {
    const pulse = 0.5 + 0.5*Math.sin(t/280 + i*1.7);
    const glowR = b.r + 6 + pulse*4;
    const glow = mgCtx.createRadialGradient(b.x, b.y, b.r*0.4, b.x, b.y, glowR);
    glow.addColorStop(0, `rgba(255,224,120,${0.35+pulse*0.2})`);
    glow.addColorStop(1, 'rgba(255,224,120,0)');
    mgCtx.fillStyle = glow;
    mgCtx.beginPath(); mgCtx.arc(b.x, b.y, glowR, 0, Math.PI*2); mgCtx.fill();

    mgCtx.save();
    mgCtx.shadowColor = 'rgba(0,0,0,.5)'; mgCtx.shadowBlur = 6; mgCtx.shadowOffsetY = 2;
    const bgrad = mgCtx.createRadialGradient(b.x-b.r*0.35, b.y-b.r*0.4, b.r*0.1, b.x, b.y, b.r);
    bgrad.addColorStop(0, '#fff8e4'); bgrad.addColorStop(0.55, '#FFE078'); bgrad.addColorStop(1, '#d9a53f');
    mgCtx.fillStyle = bgrad;
    mgCtx.beginPath(); mgCtx.arc(b.x, b.y, b.r, 0, Math.PI*2); mgCtx.fill();
    mgCtx.restore();
    mgCtx.strokeStyle = '#8a713a'; mgCtx.lineWidth = 1.5; mgCtx.stroke();
    // small specular hotspot — the detail that actually sells "glossy jewel" over "flat sticker"
    mgCtx.beginPath(); mgCtx.arc(b.x-b.r*0.32, b.y-b.r*0.38, b.r*0.22, 0, Math.PI*2);
    mgCtx.fillStyle = 'rgba(255,255,255,.75)'; mgCtx.fill();
  });

  // cup — a soft cast shadow onto the surrounding grass (a plain
  // semi-transparent ellipse, not mgCanvas shadowBlur — shadowBlur's
  // opacity scales with the source shape's own alpha, so a
  // near-invisible fill would have produced a near-invisible shadow
  // too, not a strong one independent of it), a real dip via radial
  // shading, and a thin bright rim catching the light
  mgCtx.beginPath(); mgCtx.ellipse(h.cup.x, h.cup.y+2, h.cupRadius*1.35, h.cupRadius*0.9, 0, 0, Math.PI*2);
  mgCtx.fillStyle = 'rgba(0,0,0,.28)'; mgCtx.fill();
  const cupShade = mgCtx.createRadialGradient(h.cup.x, h.cup.y, 1, h.cup.x, h.cup.y, h.cupRadius);
  cupShade.addColorStop(0, '#000000'); cupShade.addColorStop(0.7, '#0a1a12'); cupShade.addColorStop(1, '#173626');
  mgCtx.beginPath(); mgCtx.arc(h.cup.x, h.cup.y, h.cupRadius, 0, Math.PI*2);
  mgCtx.fillStyle = cupShade; mgCtx.fill();
  mgCtx.strokeStyle = 'rgba(255,224,120,.55)'; mgCtx.lineWidth = 1.5; mgCtx.stroke();
  mgCtx.strokeStyle = 'rgba(255,255,255,.25)'; mgCtx.lineWidth = 1;
  mgCtx.beginPath(); mgCtx.arc(h.cup.x, h.cup.y, h.cupRadius-1.5, Math.PI*1.1, Math.PI*1.9); mgCtx.stroke();

  // flag — subtle fabric gradient and a small pooled shadow at the pole base
  const wave = Math.sin(t/260) * 3;
  mgCtx.beginPath();
  mgCtx.ellipse(h.cup.x, h.cup.y, h.cupRadius*0.5, h.cupRadius*0.22, 0, 0, Math.PI*2);
  mgCtx.fillStyle = 'rgba(0,0,0,.25)'; mgCtx.fill();
  mgCtx.strokeStyle = '#c9a24b'; mgCtx.lineWidth = 2;
  mgCtx.beginPath(); mgCtx.moveTo(h.cup.x, h.cup.y); mgCtx.lineTo(h.cup.x, h.cup.y-34); mgCtx.stroke();
  const flagGrad = mgCtx.createLinearGradient(h.cup.x, h.cup.y-34, h.cup.x+16, h.cup.y-28);
  flagGrad.addColorStop(0, '#d9704f'); flagGrad.addColorStop(1, '#a8402a');
  mgCtx.fillStyle = flagGrad;
  mgCtx.beginPath();
  mgCtx.moveTo(h.cup.x, h.cup.y-34);
  mgCtx.quadraticCurveTo(h.cup.x+10+wave, h.cup.y-31, h.cup.x+16+wave, h.cup.y-28);
  mgCtx.quadraticCurveTo(h.cup.x+10+wave, h.cup.y-25, h.cup.x, h.cup.y-22);
  mgCtx.fill();

  // fading motion trail while the mgBall is mgMoving
  mgBallTrail.forEach((p, i) => {
    const age = (i+1) / mgBallTrail.length;
    mgCtx.beginPath();
    mgCtx.arc(p.x, p.y, mgBall.r * 0.55 * age, 0, Math.PI*2);
    mgCtx.fillStyle = `rgba(253,250,240,${0.12*age})`;
    mgCtx.fill();
  });

  // mgBall — a plain hand-drawn soft shadow ellipse (same reasoning as
  // the cup above — not mgCanvas shadowBlur), then a true glossy-sphere
  // gradient rather than a flat fill plus a separately-drawn highlight dot
  if(!mgSinkAnim){
    mgCtx.beginPath();
    mgCtx.ellipse(mgBall.x, mgBall.y+2, mgBall.r*0.85, mgBall.r*0.5, 0, 0, Math.PI*2);
    mgCtx.fillStyle = 'rgba(0,0,0,.3)';
    mgCtx.fill();

    const hlx0 = mgBall.x + Math.cos(mgBall.rollAngle) * mgBall.r * 0.4 - mgBall.r*0.35;
    const hly0 = mgBall.y + Math.sin(mgBall.rollAngle) * mgBall.r * 0.4 - mgBall.r*0.35;
    const ballGrad = mgCtx.createRadialGradient(hlx0, hly0, 0.5, mgBall.x, mgBall.y, mgBall.r*1.15);
    ballGrad.addColorStop(0, '#ffffff'); ballGrad.addColorStop(0.5, '#fdfaf0'); ballGrad.addColorStop(1, '#c9c2ac');
    mgCtx.beginPath(); mgCtx.arc(mgBall.x, mgBall.y, mgBall.r, 0, Math.PI*2);
    mgCtx.fillStyle = ballGrad; mgCtx.fill();
    mgCtx.strokeStyle = 'rgba(0,0,0,.2)'; mgCtx.lineWidth = 0.75; mgCtx.stroke();

    // subtle rolling dimple mark, orbiting with rollAngle so the spin is visible
    const hlx = mgBall.x + Math.cos(mgBall.rollAngle) * mgBall.r * 0.5;
    const hly = mgBall.y + Math.sin(mgBall.rollAngle) * mgBall.r * 0.5;
    mgCtx.beginPath(); mgCtx.arc(hlx, hly, mgBall.r*0.16, 0, Math.PI*2);
    mgCtx.fillStyle = 'rgba(120,110,90,.35)'; mgCtx.fill();
  }

  // aim line + power indicator while dragging — a fading dotted
  // trajectory preview with an arrowhead (reads as a real shot
  // preview, not a plain drawn line) and a proper rounded power gauge
  // with a green-to-red gradient and tick marks, instead of a flat bar
  if(mgAiming){
    const dx = mgAimStart.x - mgAimCurrent.x, dy = mgAimStart.y - mgAimCurrent.y;
    const dragDist = Math.min(Math.hypot(dx,dy), MG_MAX_DRAG_PX);
    const power = dragDist / MG_MAX_DRAG_PX;
    const angle = Math.atan2(dy,dx);
    const aimLen = 55 + power*65;

    const dotCount = 7;
    for(let i=1; i<=dotCount; i++){
      const dfrac = i/dotCount;
      const dxp = mgBall.x + Math.cos(angle)*aimLen*dfrac;
      const dyp = mgBall.y + Math.sin(angle)*aimLen*dfrac;
      mgCtx.beginPath();
      mgCtx.arc(dxp, dyp, 2.2 - dfrac*0.8, 0, Math.PI*2);
      mgCtx.fillStyle = `rgba(255,224,120,${(0.25+power*0.5) * dfrac})`;
      mgCtx.fill();
    }
    const tipX = mgBall.x + Math.cos(angle)*aimLen, tipY = mgBall.y + Math.sin(angle)*aimLen;
    mgCtx.save();
    mgCtx.translate(tipX, tipY); mgCtx.rotate(angle);
    mgCtx.beginPath();
    mgCtx.moveTo(0,0); mgCtx.lineTo(-7,-4); mgCtx.lineTo(-7,4); mgCtx.closePath();
    mgCtx.fillStyle = `rgba(255,224,120,${0.5+power*0.5})`;
    mgCtx.fill();
    mgCtx.restore();

    const gx = MG_W/2-46, gy = MG_H-20, gw = 92, gh = 9;
    mgRoundRectPath(mgCtx, gx, gy, gw, gh, gh/2);
    mgCtx.fillStyle = 'rgba(0,0,0,.4)'; mgCtx.fill();
    const fillW = Math.max(gh, gw*power);
    mgRoundRectPath(mgCtx, gx, gy, fillW, gh, gh/2);
    const meterGrad = mgCtx.createLinearGradient(gx, 0, gx+gw, 0);
    meterGrad.addColorStop(0, '#6FA98A'); meterGrad.addColorStop(0.6, '#FFE078'); meterGrad.addColorStop(1, '#C1604A');
    mgCtx.fillStyle = meterGrad; mgCtx.fill();
    [0.25,0.5,0.75].forEach(tp => {
      mgCtx.beginPath();
      mgCtx.moveTo(gx+gw*tp, gy+1); mgCtx.lineTo(gx+gw*tp, gy+gh-1);
      mgCtx.strokeStyle = 'rgba(0,0,0,.3)'; mgCtx.lineWidth = 1;
      mgCtx.stroke();
    });
    mgRoundRectPath(mgCtx, gx, gy, gw, gh, gh/2);
    mgCtx.strokeStyle = 'rgba(255,255,255,.25)'; mgCtx.lineWidth = 1; mgCtx.stroke();
  }

  // the quick "sunk" flash — an expanding ring at the cup plus the
  // score label popping in and fading out, all inside ~half a second
  if(mgSinkAnim){
    const elapsed = t - mgSinkAnim.startT;
    const p = Math.min(1, elapsed / mgSinkAnim.duration);
    mgCtx.save();
    mgCtx.globalAlpha = 1 - p;
    mgCtx.strokeStyle = '#FFE078';
    mgCtx.lineWidth = 3;
    mgCtx.beginPath();
    mgCtx.arc(h.cup.x, h.cup.y, 6 + p*46, 0, Math.PI*2);
    mgCtx.stroke();
    mgCtx.restore();

    const scaleP = p < 0.22 ? p/0.22 : 1;
    const alphaP = p > 0.7 ? 1 - (p-0.7)/0.3 : 1;
    mgCtx.save();
    mgCtx.globalAlpha = alphaP;
    mgCtx.translate(MG_W/2, MG_H/2);
    mgCtx.scale(scaleP, scaleP);
    mgCtx.font = "800 32px 'Barlow Condensed', sans-serif";
    mgCtx.textAlign = 'center'; mgCtx.textBaseline = 'middle';
    mgCtx.fillStyle = 'rgba(0,0,0,.5)';
    mgCtx.fillText(mgSinkAnim.label.toUpperCase(), 2, 2);
    mgCtx.fillStyle = '#FFE078';
    mgCtx.fillText(mgSinkAnim.label.toUpperCase(), 0, 0);
    mgCtx.restore();
  }
}

// ================= CONTROLS =================
function mgCanvasPoint(clientX, clientY){
  const rect = mgCanvas.getBoundingClientRect();
  const scaleX = MG_W / rect.width, scaleY = MG_H / rect.height;
  return { x:(clientX-rect.left)*scaleX, y:(clientY-rect.top)*scaleY };
}

function mgPointerDown(clientX, clientY){
  if(mgMoving) return;
  const p = mgCanvasPoint(clientX, clientY);
  if(mgDist(p.x,p.y,mgBall.x,mgBall.y) > 40) return; // must grab reasonably near the mgBall
  mgAiming = true;
  mgAimStart = { x: mgBall.x, y: mgBall.y };
  mgAimCurrent = p;
}
function mgPointerMove(clientX, clientY){
  if(!mgAiming) return;
  mgAimCurrent = mgCanvasPoint(clientX, clientY);
}
function mgPointerUp(){
  if(!mgAiming) return;
  mgAiming = false;
  const dx = mgAimStart.x - mgAimCurrent.x, dy = mgAimStart.y - mgAimCurrent.y;
  const dragDist = Math.min(Math.hypot(dx,dy), MG_MAX_DRAG_PX);
  if(dragDist < 6) return; // treat as an accidental tap, not a putt
  const power = dragDist / MG_MAX_DRAG_PX;
  const angle = Math.atan2(dy,dx);
  const speed = power * MG_MAX_SHOT_SPEED;
  mgLastSafe = { x: mgBall.x, y: mgBall.y };
  mgBall.vx = Math.cos(angle)*speed;
  mgBall.vy = Math.sin(angle)*speed;
  mgStrokesThisHole += 1;
  mgMoving = true;
  mgUpdateHud();
}

mgCanvas.addEventListener('mousedown', e => mgPointerDown(e.clientX, e.clientY));
window.addEventListener('mousemove', e => mgPointerMove(e.clientX, e.clientY));
window.addEventListener('mouseup', mgPointerUp);
mgCanvas.addEventListener('touchstart', e => { mgPointerDown(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
mgCanvas.addEventListener('touchmove', e => { e.preventDefault(); mgPointerMove(e.touches[0].clientX, e.touches[0].clientY); }, {passive:false});
mgCanvas.addEventListener('touchend', e => { mgPointerUp(); }, {passive:true});

// ================= LOOP =================
let mgActive = false; // true only while the Mini Golf panel is the one showing — stops the render loop from running forever in the background once the player switches to a different game
function mgLoop(t){
  if(!mgActive) return; // stopped — mgResume() restarts it next time this panel opens
  if(mgMoving){
    const result = mgStepPhysics(mgBall, mgCurrentHole(), t, mgOnSplash);
    if(result.sunk) mgOnSunk(t);
    else mgMoving = result.mgMoving;
    if(mgMoving){
      mgBall.rollAngle += Math.hypot(mgBall.vx, mgBall.vy) * 0.14;
      mgBallTrail.push({ x: mgBall.x, y: mgBall.y });
      if(mgBallTrail.length > 10) mgBallTrail.shift();
    } else {
      mgBallTrail = [];
    }
  }
  mgDrawFrame(t);
  mgAnimId = requestAnimationFrame(mgLoop);
}

document.getElementById('mgNextHoleBtn').addEventListener('click', () => {
  if(mgHoleIndex < MG_HOLES.length-1) mgLoadHole(mgHoleIndex+1);
});
document.getElementById('mgRetryHoleBtn').addEventListener('click', () => mgLoadHole(mgHoleIndex));
document.getElementById('mgSkipHoleBtn').addEventListener('click', () => {
  mgScoreHistory.push({ par: mgCurrentHole().par, strokes: mgStrokesThisHole || mgCurrentHole().par });
  if(mgHoleIndex === MG_HOLES.length-1){
    mgUpdateHud(); // same fix as mgOnSunk — the non-final branch below already gets this for
                 // free from mgLoadHole(), but skipping the LAST hole has no next mgLoadHole() call
    mgShowRoundComplete();
  } else {
    mgLoadHole(mgHoleIndex+1);
  }
});
document.getElementById('mgPlayAgainBtn').addEventListener('click', () => {
  mgScoreHistory = [];
  document.getElementById('mgRoundOverlay').style.display = 'none';
  mgLoadHole(0);
});

// ================= WEEKLY LADDER + PRIZE (real Firebase) =================
// Reuses xpWeekKey() (defined earlier in index.html for the Weekly
// Bonus feature) rather than inventing a separate week-boundary
// convention — same "align with what already exists" reasoning as
// reusing Hold'em's realtime auth bridge for Pong.
const MG_WEEKLY_PRIZE_XP = 100000;

async function mgSubmitWeeklyScore(totalStrokes){
  if(!currentUserUid) return;
  const weekKey = xpWeekKey();
  try{
    // Check locally first so an already-beaten score doesn't even
    // attempt a write — firebase-rules.json also enforces this
    // server-side (a write is only accepted if it's actually an
    // improvement), so this is a courtesy skip, not the real guarantee.
    const res = await authedFetch(`/minigolf/weeklyScores/${weekKey}/${currentUserUid}.json`);
    const existing = res.ok ? await res.json() : null;
    if(existing && existing.strokes <= totalStrokes) return;
    const writeRes = await authedFetch(`/minigolf/weeklyScores/${weekKey}/${currentUserUid}.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strokes: totalStrokes, ts: Date.now() })
    });
    // A rejected write (e.g. Firebase rules not actually deployed for
    // this node yet) previously failed completely silently here — the
    // ladder would just never update with no visible error at all.
    if(!writeRes.ok){
      showToast('⚠️ Could not save your round to the weekly ladder — try again shortly.');
      return;
    }
    await mgRenderWeeklyLadder();
  }catch(e){
    showToast('⚠️ Could not save your round to the weekly ladder — check your connection.');
  }
}

async function mgRenderWeeklyLadder(){
  const table = document.getElementById('mgLadderTable');
  if(!table) return;
  const weekKey = xpWeekKey();
  let entries = [];
  try{
    const res = await authedFetch(`/minigolf/weeklyScores/${weekKey}.json`);
    const data = res.ok ? await res.json() : null;
    if(data) entries = Object.keys(data).map(uid => ({ uid, strokes: data[uid].strokes }));
  }catch(e){}
  entries.sort((a,b) => a.strokes - b.strokes);
  if(!entries.length){
    table.innerHTML = '<tr><td style="text-align:center; color:var(--muted); padding:10px 0;">No rounds posted yet this week — be the first.</td></tr>';
    return;
  }
  const rankClass = i => i===0 ? 'gold' : i===1 ? 'silver' : i===2 ? 'bronze' : 'other';
  const rankMark = i => String(i+1);
  table.innerHTML = entries.slice(0, 12).map((e,i) => {
    const mine = e.uid === currentUserUid;
    return `<tr${mine?' class="me"':''}><td class="rank ${rankClass(i)}">${rankMark(i)}</td><td>${nameForUid(e.uid)}</td><td class="score">${e.strokes}</td></tr>`;
  }).join('');
}

async function mgDealerCall(action, extraParams){
  const auth = await getValidAuth();
  if(!auth) return null;
  try{
    const res = await fetch('/.netlify/functions/minigolf-dealer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: auth.idToken, action, ...extraParams })
    });
    return await res.json().catch(() => null);
  }catch(e){ return null; }
}

// Lazy-triggered exactly like Hold'em's checkAutoStart/checkTimeout —
// no server-side timer exists to fire this on its own, so whichever
// member happens to open Mini Golf first after a week rolls over is
// the one whose client actually triggers the payout. Safe to call
// repeatedly; the dealer function itself guards against double-paying
// via a conditional write (see minigolf-dealer.js).
async function mgCheckWeeklyPrize(){
  const result = await mgDealerCall('checkWeeklyPrize', {});
  if(result && result.paid){
    showToast(`⛳ ${nameForUid(result.winnerUid)} won last week's Mini Golf prize — ${MG_WEEKLY_PRIZE_XP.toLocaleString()} XP!`);
    mgRenderWeeklyLadder();
  }
}

let mgBuilt = false;
async function mgInit(){
  mgBuilt = true;
  mgLoadHole(0);
}
function mgResume(){
  mgActive = true;
  mgRenderWeeklyLadder();
  mgCheckWeeklyPrize();
  mgAnimId = requestAnimationFrame(mgLoop);
}
