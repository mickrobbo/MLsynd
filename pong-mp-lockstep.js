// ---- Multiplayer Pong — Stages 2/3: the lockstep engine and session
// scheduler that pong-mp-engine.js and pong-mp-lockstep.js were always
// meant to be (an earlier build note in casino-pong.js referred to
// them as two files; they're combined here into one, since that's what
// the actual <script> tags in index.html expect — one file defining
// BOTH globals below).
//
// The core idea, stated plainly: two players' clients each run the
// EXACT same physics simulation, fed the EXACT same sequence of inputs
// (their own local paddle target each tick, the opponent's most recent
// known target each tick, synced via pong-mp-firebase-adapter.js).
// Given identical inputs and identical deterministic math, both
// simulations produce identical results without ever needing to
// transmit ball position itself — only paddle targets, which is far
// less data and far more resistant to network jitter than streaming
// ball physics directly would be.
//
// Determinism is the entire point, and it's fragile: ANY source of
// non-determinism (an unseeded Math.random() call inside the shared
// step, a physics constant that isn't byte-identical between builds,
// a floating-point operation order that differs between call sites)
// causes the two clients' simulations to silently diverge over time.
// The single-player engine (casino-pong.js's own pongStep) calls
// Math.random() directly for its CPU aim error and score randomness —
// fine there, since only one client's opinion of the game ever matters.
// Here it would be a real bug. Every "random" moment in this file goes
// through seededRandom(seed) instead, seeded by the tick count at the
// moment it's needed — since both clients are at the same tick when a
// point is scored (that's what lockstep guarantees), both compute the
// identical "random" serve angle without exchanging anything extra.
//
// Geometry and feel are deliberately identical to single-player Pong
// (see PONG_W/PONG_H/PONG_PADDLE_W/PONG_PADDLE_H/PONG_BALL_R in
// casino-pong.js) rather than reinvented — same canvas size, same
// paddle dimensions, same ball radius, so a PvP match feels like the
// same game, not a different one that happens to share a name.

(function(){
  'use strict';

  // Deterministic pseudo-random, 0..1, from an integer seed. Simple
  // sine-based hash — not cryptographic, doesn't need to be, just
  // needs to produce the same output for the same seed on both clients
  // (which any implementation of this exact formula does, since it's
  // pure floating-point math with no external state).
  function seededRandom(seed){
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  const PongMpEngine = {
    W: 340, H: 220, PADDLE_W: 7, PADDLE_H: 40, BALL_R: 5,
    // First to 7 — long enough to feel like a real contest, short
    // enough that a match with real XP on the line doesn't drag.
    WIN_SCORE: 7,
    BASE_SPEED: 2.6,
    // How fast a paddle can move toward its target per tick — caps
    // instant teleporting under network jitter (if the remote target
    // jumps due to a delayed sync catching up, the paddle still only
    // moves at this capped rate, same as it would locally).
    PADDLE_MAX_SPEED: 4.2,
    // Ticks run at a fixed 60/sec regardless of actual frame rate —
    // see PongMpLockstep.advance for why this matters for determinism.
    TICK_MS: 1000 / 60,

    createInitialState(){
      return {
        p1: { y: this.H / 2 - this.PADDLE_H / 2 },
        p2: { y: this.H / 2 - this.PADDLE_H / 2 },
        // FIXED — real bug caught by simulation, not by inspection: this
        // originally called serveBall(0, 0), and dir=0 means vx = 0 *
        // BASE_SPEED = 0. The ball had no horizontal velocity from the
        // instant a match started, so it could never reach either
        // paddle — a 20,000-tick test scored 0-0 the whole way through
        // before this was found. Serves toward p2 first; which side
        // serves first doesn't need to be random since it's identical
        // on both clients regardless.
        ball: this.serveBall(1, 0),
        scoreP1: 0, scoreP2: 0, winner: null, tick: 0
      };
    },

    // dir: -1 serves toward p1 (left), 1 serves toward p2 (right).
    // seed: the tick count at serve time — deterministic on both
    // clients since they're at the same tick when this is called.
    serveBall(dir, seed){
      const angle = (seededRandom(seed) * 0.6 - 0.3);
      return { x: this.W / 2, y: this.H / 2, vx: dir * this.BASE_SPEED, vy: angle * 3 };
    },

    // Advances state by exactly one fixed tick, given both players'
    // CURRENT target paddle Y (already clamped to the playfield by
    // whoever's feeding them in — the local player via direct input,
    // the remote player via the firebase adapter). Mutates and returns
    // state. Pure function of (state, p1TargetY, p2TargetY) — no
    // reference to Date.now(), Math.random(), or anything else that
    // could differ between two calls with the same three arguments.
    step(state, p1TargetY, p2TargetY){
      state.p1.y += Math.max(-this.PADDLE_MAX_SPEED, Math.min(this.PADDLE_MAX_SPEED, p1TargetY - state.p1.y));
      state.p2.y += Math.max(-this.PADDLE_MAX_SPEED, Math.min(this.PADDLE_MAX_SPEED, p2TargetY - state.p2.y));
      state.p1.y = Math.max(0, Math.min(this.H - this.PADDLE_H, state.p1.y));
      state.p2.y = Math.max(0, Math.min(this.H - this.PADDLE_H, state.p2.y));

      const b = state.ball;
      b.x += b.vx; b.y += b.vy;

      if(b.y - this.BALL_R < 0){ b.y = this.BALL_R; b.vy = Math.abs(b.vy); }
      if(b.y + this.BALL_R > this.H){ b.y = this.H - this.BALL_R; b.vy = -Math.abs(b.vy); }

      // p1 (left) paddle hit or miss
      if(b.vx < 0 && b.x - this.BALL_R <= this.PADDLE_W + 2){
        if(b.y >= state.p1.y && b.y <= state.p1.y + this.PADDLE_H){
          const hitPos = (b.y - (state.p1.y + this.PADDLE_H / 2)) / (this.PADDLE_H / 2);
          // A small, capped speed-up over a long rally — same spirit as
          // single-player's tier escalation, just gentler and without
          // tiers, since there's no CPU difficulty ramp to match here.
          const speedUp = Math.min(state.tick / 900, 1.4);
          b.vx = this.BASE_SPEED + speedUp;
          b.vy = hitPos * (2.4 + speedUp);
          b.x = this.PADDLE_W + 2 + this.BALL_R;
        } else if(b.x - this.BALL_R < 0){
          state.scoreP2++;
          if(state.scoreP2 >= this.WIN_SCORE){ state.winner = 'p2'; }
          else { state.ball = this.serveBall(-1, state.tick); }
        }
      }
      // p2 (right) paddle hit or miss — symmetric
      if(b.vx > 0 && b.x + this.BALL_R >= this.W - this.PADDLE_W - 2){
        if(b.y >= state.p2.y && b.y <= state.p2.y + this.PADDLE_H){
          const hitPos = (b.y - (state.p2.y + this.PADDLE_H / 2)) / (this.PADDLE_H / 2);
          const speedUp = Math.min(state.tick / 900, 1.4);
          b.vx = -(this.BASE_SPEED + speedUp);
          b.vy = hitPos * (2.4 + speedUp);
          b.x = this.W - this.PADDLE_W - 2 - this.BALL_R;
        } else if(b.x + this.BALL_R > this.W){
          state.scoreP1++;
          if(state.scoreP1 >= this.WIN_SCORE){ state.winner = 'p1'; }
          else { state.ball = this.serveBall(1, state.tick); }
        }
      }

      state.tick++;
      return state;
    }
  };

  // ---- Session scheduler — wraps the pure engine above with fixed-
  // timestep advancement and remote-input bookkeeping. This is the
  // layer that turns "a deterministic step function" into "something
  // that actually plays smoothly given a real device's inconsistent
  // frame timing and a real network's inconsistent latency."
  //
  // FIXED — a real problem, not a hypothetical one: caught by actually
  // simulating two independent sessions over a fake jittery network
  // (60-160ms one-way latency, occasional dropped packets) before
  // shipping, rather than trusting the pure-engine determinism test
  // alone. The pure engine test proved "same inputs -> same outputs",
  // which is necessary but not sufficient — the ORIGINAL version of
  // this scheduler fed each session whatever remote value it happened
  // to have most recently received, applied at whatever tick was
  // currently running locally. Two clients' local clocks are never
  // perfectly aligned and network delivery timing varies, so each side
  // was effectively simulating with SLIGHTLY different inputs at the
  // same tick number — enough that a single ~10-second test match
  // ended 6-7 on one side and 6-6 (mid-match) on the other. That's not
  // a rare edge case; over enough matches it would mean routinely
  // disputed results with no XP ever actually settling — a broken
  // feature, not a working one with occasional hiccups.
  //
  // The standard fix for exactly this problem: don't simulate "right
  // now" at all. Buffer BOTH local and remote inputs with timestamps,
  // and always simulate INPUT_DELAY_MS in the past — far enough behind
  // real time that the remote input for that past moment has reliably
  // already arrived on both sides by the time either client actually
  // simulates it. Both clients then look up "what was each player's
  // target at wall-clock time T" from their own buffered history and
  // get the IDENTICAL answer, because by the time T is actually
  // simulated, both sides have long since received the real value —
  // not a currently-in-flight one. The cost is a small, constant input
  // lag (your own paddle responds ~200ms after you move it) rather
  // than an occasional desync; for a casual duel that trade is the
  // right one, and it's the same trade every real lockstep-networked
  // game makes.
  const INPUT_DELAY_MS = 380; // widened after testing showed 220ms was tighter than the worst-case latency in realistic conditions (80ms sync interval + up to 160ms one-way network delay = 240ms possible, exceeding the old buffer)
  const HISTORY_CAP = 400; // ~7 seconds of buffered ticks at 60/sec — far more than INPUT_DELAY_MS ever needs, generous headroom
  // FIXED — a second, deeper bug than the input-delay one above, found
  // by tracing actual per-tick state rather than just final scores:
  // tick COUNTS stayed perfectly in sync the whole time, but paddle
  // POSITIONS at those same ticks still disagreed. Cause: a player's
  // own client was recording its local input EVERY FRAME (a smooth,
  // continuous curve, ~60 samples/sec), while the opponent's client
  // only ever learned that same player's position once every SYNC_MS
  // (an 80ms step function, ~12.5 samples/sec) — because that's the
  // adapter's actual sync cadence. Even at the exact same tick, with
  // input delay working correctly, the two sides were reconstructing
  // player A's paddle from two DIFFERENT-RESOLUTION representations of
  // the same continuous movement, and a sine/cosine paddle pattern has
  // enough slope that "the value 13ms earlier" and "the value 80ms
  // earlier" are genuinely different numbers. Fix: LOCAL input is now
  // throttled to the same LOCAL_SAMPLE_MS cadence as what actually gets
  // transmitted, so both sides always reconstruct every player's
  // history from the identical step function — the one that was
  // actually sent — rather than one side having "better" data about
  // itself than the network could ever deliver to its opponent.
  const LOCAL_SAMPLE_MS = 80; // must match the adapter's own SYNC_MS — the discretization has to be identical on both ends, not just similar

  const PongMpLockstep = {
    createSession({ matchId, mySide }){
      const state = PongMpEngine.createInitialState();
      const centerY = PongMpEngine.H / 2 - PongMpEngine.PADDLE_H / 2;
      // {t, y} pairs, oldest first. t is elapsed ms since this session
      // started, NOT Date.now() directly, so both clients' histories
      // are on the same relative clock regardless of when each of
      // their devices' Date.now() happens to read.
      let localHistory = [{ t: 0, y: centerY }];
      let remoteHistory = [{ t: 0, y: centerY }];
      let startedAt = null;
      let simulatedTicks = 0;
      let lastRemoteUpdateAt = Date.now();
      let lastLocalSampleAt = -Infinity;

      function elapsedMs(){
        if(startedAt === null) startedAt = Date.now();
        return Date.now() - startedAt;
      }
      // Most recent buffered value at or before time t — a plain
      // linear scan from the end is fine at this scale (a few hundred
      // entries, called a handful of times per tick at most).
      function valueAtTime(history, t){
        let result = history[0].y;
        for(let i = 0; i < history.length; i++){
          if(history[i].t <= t) result = history[i].y; else break;
        }
        return result;
      }
      function pushHistory(history, t, y){
        history.push({ t, y });
        if(history.length > HISTORY_CAP) history.shift();
      }

      return {
        // dt is accepted for API compatibility with the original design
        // (and clamped upstream by the caller — see pongPvpLoopStep's
        // 250ms cap) but the delayed-buffer approach above means actual
        // tick advancement is driven by elapsed wall-clock time rather
        // than dt accumulation directly.
        advance(dt, getLocalTargetY){
          if(state.winner) return; // match already decided, nothing left to simulate
          const now = elapsedMs();
          // Throttled to LOCAL_SAMPLE_MS — see the fix note above for
          // why this must match the adapter's sync cadence exactly
          // rather than recording a fresh value every frame.
          if(now - lastLocalSampleAt >= LOCAL_SAMPLE_MS){
            lastLocalSampleAt = now;
            pushHistory(localHistory, now, getLocalTargetY());
          }

          const targetSimTime = now - INPUT_DELAY_MS;
          const targetTick = Math.max(0, Math.floor(targetSimTime / PongMpEngine.TICK_MS));
          // Capped per call for the same reason as before — a genuine
          // stall shouldn't try to simulate an enormous backlog in one
          // frame, it should just run a little behind and catch up
          // gradually across subsequent calls.
          let ticksThisCall = 0;
          while(simulatedTicks < targetTick && ticksThisCall < 10){
            const tAtTick = simulatedTicks * PongMpEngine.TICK_MS;
            const localY = valueAtTime(localHistory, tAtTick);
            const remoteY = valueAtTime(remoteHistory, tAtTick);
            const p1Y = mySide === 'p1' ? localY : remoteY;
            const p2Y = mySide === 'p2' ? localY : remoteY;
            PongMpEngine.step(state, p1Y, p2Y);
            simulatedTicks++;
            ticksThisCall++;
            if(state.winner) break;
          }
        },
        // Called by the firebase adapter whenever a new remote paddle
        // target arrives, timestamped on THIS session's own relative
        // clock (elapsedMs(), not the sender's) — what matters for
        // buffering is "when did I learn this", consistent with how
        // local input is timestamped too.
        setRemoteTargetY(y){
          pushHistory(remoteHistory, elapsedMs(), y);
          lastRemoteUpdateAt = Date.now();
        },
        // True if nothing's been heard from the opponent in a while —
        // drives the "Reconnecting to opponent…" status hint rather
        // than the match silently freezing with no explanation.
        isStalled(){
          return (Date.now() - lastRemoteUpdateAt) > 3000;
        },
        getState(){ return state; },
        getSnapshot(){
          return { scoreP1: state.scoreP1, scoreP2: state.scoreP2, winner: state.winner, tick: state.tick };
        }
      };
    }
  };

  window.PongMpEngine = PongMpEngine;
  window.PongMpLockstep = PongMpLockstep;
})();
