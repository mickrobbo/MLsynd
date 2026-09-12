// ---- Multiplayer Pong — Stage 3b: the Firebase adapter ----
//
// Everything determinism-critical lives in pong-mp-lockstep.js and was
// proven correct there via simulated-network unit tests. This file is
// deliberately as thin and boring as possible: it just moves bytes
// between that scheduler and Firebase. It CANNOT be unit-tested the way
// the last two files were — it needs a real Firebase connection, so
// this only gets verified once two actual phones play a real match.
// Keeping it this thin is exactly why: less surface area here means
// less that can only be checked live.
//
// Reuses ensureHoldemRealtimeAuth() (defined in index.html, despite the
// name it's generic to any realtime listener in this app — see its own
// comment) rather than minting a second auth bridge. No new Netlify
// function needed for this stage.
//
// Firebase layout this reads/writes (rules for this added to
// firebase-rules.json alongside this delivery):
//   /pongLive/{matchId}/inputs/p1/{tick} = y   (challenger writes only this)
//   /pongLive/{matchId}/inputs/p2/{tick} = y   (opponent writes only this)

function pongMpCreateFirebaseAdapter(session, matchId) {
  const mySide = session.mySide;
  const otherSide = session.otherSide;
  let sendTimer = null;
  let remoteRef = null;
  let stopped = false;

  // Drains whatever ticks the scheduler has buffered locally since the
  // last send and pushes them out as ONE merged update() call rather
  // than one write per tick — at 60 ticks/sec, writing every single
  // tick individually would be both needlessly chatty against Firebase
  // and pointless, since input delay already means several ticks
  // accumulate between sends anyway. update() merges keys rather than
  // replacing the whole node, so earlier ticks already written are
  // never clobbered by a later batch.
  function flushOutbox() {
    const batch = session.drainOutbox();
    if (batch.length === 0) return;
    const patch = {};
    batch.forEach(({ tick, y }) => { patch[tick] = y; });
    firebase.database().ref(`/pongLive/${matchId}/inputs/${mySide}`).update(patch).catch(() => {
      // A failed update here is exactly the "genuinely lost input"
      // scenario flagged in pong-mp-lockstep.test.js's closing note —
      // this adapter doesn't retry it, which means the opponent's
      // session will stall waiting for these specific ticks. Stage 4
      // needs a real stall/forfeit UI; for now this at least doesn't
      // pretend the send succeeded.
      console.warn('Pong PvP: failed to send input batch — opponent may stall until reconnect.');
    });
  }

  // child_added fires once per NEW tick key as it appears under the
  // opponent's inputs node — exactly the shape we want (one event per
  // tick, in the order Firebase saw them written), rather than 'value'
  // which would hand back the entire growing object on every change.
  function startListening() {
    remoteRef = firebase.database().ref(`/pongLive/${matchId}/inputs/${otherSide}`);
    remoteRef.on('child_added', (snap) => {
      const tick = parseInt(snap.key, 10);
      const y = snap.val();
      if (Number.isFinite(tick) && typeof y === 'number') {
        session.receiveRemoteInput(tick, y);
      }
    });
  }

  async function start() {
    await ensureHoldemRealtimeAuth(); // generic despite the name — see its own comment in index.html
    startListening();
    // Sent on a fixed short interval rather than after every single
    // recordLocalInput() call — batches naturally accumulate a handful
    // of ticks between sends this way, which is the entire point of
    // draining a buffer instead of writing per-tick.
    sendTimer = setInterval(flushOutbox, 66); // ~15 sends/sec — comfortably inside the input-delay budget (6 ticks = 100ms) without writing on every single tick
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (sendTimer) clearInterval(sendTimer);
    if (remoteRef) remoteRef.off('child_added');
  }

  return { start, stop, flushOutbox };
}
