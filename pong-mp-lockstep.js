// ---- Multiplayer Pong — Stage 3a: the lockstep scheduler ----
//
// This is the piece that turns "two phones with real network latency
// between them" into "two engines that stay bit-identical". It has NO
// Firebase/DOM dependency at all — it only knows about (tick, y) pairs
// coming in and going out, via plain callbacks. That's deliberate: it
// means this file can be fully unit-tested by simulating network delay
// in-process (see pong-mp-lockstep.test.js), the same way
// pong-mp-engine.js was tested without ever touching a browser.
//
// The core idea (classic "input-delay lockstep", the same family of
// technique real-time-strategy games have used for decades over much
// worse connections than Firebase): a tick is only ever SIMULATED once
// both players' real input for that exact tick number is known. Rather
// than trying to guess or interpolate a missing input (which risks two
// clients guessing DIFFERENT things and silently diverging), a tick
// whose input hasn't arrived yet simply doesn't run — the shared
// simulation stalls for both players until it does. Input delay
// (INPUT_DELAY_TICKS) exists purely to make that stall rare in
// practice: a player's own input for "right now" is tagged for a tick
// slightly in the FUTURE, giving the network a head start to deliver it
// to the other side before that tick actually needs to run.
//
// What this file does NOT do: send/receive anything over a real
// network, touch the DOM, or know what a "paddle" or "Pong" even is
// beyond calling the engine's step() function with two numbers. Wiring
// this to actual Firebase writes/listeners is pong-mp-firebase-adapter.js.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./pong-mp-engine.js'));
  } else {
    root.PongMpLockstep = factory(root.PongMpEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (Engine) {

  // A tick of head start given to every locally-generated input before
  // the simulation is allowed to actually need it. At 60 ticks/sec this
  // is ~100ms — comfortably more than typical Firebase Realtime
  // Database round-trip latency over the SDK's persistent connection,
  // without adding enough input lag for a human to actually notice in a
  // game this forgiving (Pong doesn't need frame-perfect reactions).
  // Exposed as a constant so it's one obvious place to retune after a
  // real live-network test, not a number buried in a function body.
  const INPUT_DELAY_TICKS = 6;

  // A simple, deterministic string hash (FNV-1a, 32-bit) so both
  // players can derive the SAME match seed from the match's own Firebase
  // push ID with no extra handshake/write needed — whoever computes it,
  // computes the same number, because it's a pure function of a string
  // both sides already have (the matchId from Stage 1's /pongMatches
  // record).
  function seedFromMatchId(matchId) {
    let h = 0x811c9dc5;
    for (let i = 0; i < matchId.length; i++) {
      h ^= matchId.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // mySide: 'p1' or 'p2' — which slot in the shared engine this local
  // player occupies (Stage 1 convention: the challenger is always p1,
  // the accepting opponent is always p2, so there's never any ambiguity
  // about who's who without an extra negotiation step).
  function createSession(opts) {
    const mySide = opts.mySide;
    const otherSide = mySide === 'p1' ? 'p2' : 'p1';
    const seed = typeof opts.seed === 'number' ? opts.seed : seedFromMatchId(opts.matchId);
    const inputDelayTicks = opts.inputDelayTicks || INPUT_DELAY_TICKS;

    const state = Engine.createMatch(seed);
    const buffers = { p1: {}, p2: {} }; // buffers[side][tickNumber] = y
    let nextLocalInputTick = 0; // the next tick number this side hasn't generated input for yet
    let executedTick = -1; // last tick actually simulated
    let accumulatorMs = 0; // fixed-timestep leftover, same pattern as any fixed-step game loop

    // How many ticks are currently sitting unsent, waiting to go out —
    // the adapter drains this on its own schedule (see
    // pong-mp-firebase-adapter.js) rather than this module trying to
    // know anything about network batching/throttling itself.
    const outbox = [];

    function recordLocalInput(rawY) {
      const tick = nextLocalInputTick++;
      buffers[mySide][tick] = rawY;
      outbox.push({ tick, y: rawY });
    }

    function receiveRemoteInput(tick, y) {
      // Idempotent by design — the adapter may legitimately deliver the
      // same tick twice (e.g. a reconnect replaying recent history), and
      // silently accepting a duplicate is correct; the alternative would
      // be to reject a message that just happens to be a legitimate
      // resend, which is worse.
      if (buffers[otherSide][tick] === undefined) buffers[otherSide][tick] = y;
    }

    function drainOutbox() {
      const batch = outbox.splice(0, outbox.length);
      return batch;
    }

    // Attempts to simulate every tick that has become ready since the
    // last call, in order, and stops the instant one isn't ready yet
    // (never skips ahead out of order — that would break determinism
    // just as badly as guessing a missing input would).
    function tryAdvanceReadyTicks() {
      while (true) {
        const nextTick = executedTick + 1;
        const localReady = buffers[mySide][nextTick] !== undefined;
        const remoteReady = buffers[otherSide][nextTick] !== undefined;
        // The local side's own input-delay guarantee: we never even
        // attempt a tick until our own input generation has moved
        // comfortably past it. This isn't a correctness requirement by
        // itself (localReady already covers "do we have OUR input"),
        // it's what makes a stall load-bearing rather than silent —
        // without it, a fast local player could race ahead of their own
        // opponent's network delivery constantly, turning "occasional
        // stall while the network catches up" into "stalls basically
        // every tick".
        const localHasHeadStart = nextLocalInputTick - nextTick > inputDelayTicks;
        if (!localReady || !remoteReady || !localHasHeadStart) break;

        const p1y = buffers.p1[nextTick];
        const p2y = buffers.p2[nextTick];
        Engine.step(state, p1y, p2y);
        executedTick = nextTick;
        if (state.winner) break; // no point simulating further ticks once the match is decided
      }
    }

    // Called once per animation frame with real elapsed milliseconds.
    // Converts real time into fixed engine ticks (same accumulator
    // pattern as any fixed-timestep loop) and, at each tick boundary,
    // records this side's current raw input and tries to advance the
    // shared simulation as far as buffered data allows.
    function advance(dtMs, getRawLocalY) {
      accumulatorMs += dtMs;
      while (accumulatorMs >= Engine.TICK_DT_MS) {
        accumulatorMs -= Engine.TICK_DT_MS;
        recordLocalInput(getRawLocalY());
        tryAdvanceReadyTicks();
      }
    }

    return {
      mySide, otherSide, seed,
      recordLocalInput, receiveRemoteInput, drainOutbox, advance,
      getState: () => state,
      getSnapshot: () => Engine.toSnapshot(state),
      isStalled: () => {
        const nextTick = executedTick + 1;
        return buffers[mySide][nextTick] === undefined || buffers[otherSide][nextTick] === undefined;
      },
      // How many ticks behind "as current as the local player's own
      // input" the confirmed simulation is sitting — a large, growing
      // number is exactly what a "waiting for opponent's connection…"
      // UI indicator should watch for.
      getLagTicks: () => nextLocalInputTick - 1 - executedTick
    };
  }

  return { createSession, seedFromMatchId, INPUT_DELAY_TICKS };
});
