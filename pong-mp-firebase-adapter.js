// ---- Multiplayer Pong — the Firebase sync layer connecting two
// clients' PongMpLockstep sessions (see pong-mp-lockstep.js) to each
// other. This app talks to Firebase purely over REST (authedFetch
// against .json endpoints) everywhere else — Hold'em, multiplayer
// Blackjack, the Casino floor feed all work this way — rather than the
// Firebase JS SDK's websocket-based real-time listeners, so "real-time"
// here means frequent polling with client-side smoothing to hide the
// gaps, not a true push channel. Matches that existing convention
// rather than introducing a new networking approach just for Pong.
//
// What actually gets synced is deliberately small: each player's
// current PADDLE TARGET Y, nothing else. Not ball position, not score,
// not paddle velocity — because the whole point of the lockstep engine
// is that both clients compute everything else identically from that
// one number plus their own local input, given the shared deterministic
// physics. Syncing paddle targets instead of full game state is both
// far less data over the wire and far more resistant to a slow or
// jittery connection: a stale ball-position sync would visibly jump the
// ball around on a lag spike, while a stale paddle target just means
// the opponent's paddle briefly stops updating and then catches up
// smoothly once a fresh value arrives (helped by the engine's own
// PADDLE_MAX_SPEED cap, which was already there for exactly this).

function pongMpCreateFirebaseAdapter(session, matchId){
  const SYNC_MS = 80; // ~12.5 syncs/sec — smooth enough given PADDLE_MAX_SPEED, without hammering Firebase every 16ms
  let syncHandle = null;
  let mySide = null;       // 'p1' or 'p2' — matches the role-based path structure already defined in firebase-rules.json's pongLive node
  let opponentSide = null;
  let lastWrittenY = null; // avoids re-writing the identical value every tick when the local paddle isn't moving

  // IMPORTANT: the path structure below (/pongLive/{matchId}/inputs/p1
  // and /inputs/p2, gated by challengerUid=p1/opponentUid=p2) is not a
  // new design — firebase-rules.json already had a pongLive node with
  // exactly this shape and exactly these write permissions before this
  // file was written. Matched deliberately rather than inventing a
  // parallel /pongMatches/{id}/live/{uid}/y path, which would have
  // needed its own new rules and duplicated a decision someone had
  // already made correctly.
  async function fetchMatchSides(){
    const res = await authedFetch(`/pongMatches/${matchId}.json`);
    if(!res.ok) throw new Error('Could not load match details.');
    const match = await res.json();
    if(!match) throw new Error('Match not found.');
    mySide = match.challengerUid === currentUserUid ? 'p1' : 'p2';
    opponentSide = mySide === 'p1' ? 'p2' : 'p1';
  }

  async function writeMyPaddle(){
    // Reads the local target from casino-pong.js's own global rather
    // than taking it as a parameter — matches how pongPvpSession.advance
    // already reads it (via the getLocalTargetY callback passed in from
    // the same global), so there's one source of truth for "where is my
    // paddle right now" rather than two that could disagree.
    const y = typeof pongPvpLocalTargetY === 'number' ? pongPvpLocalTargetY : null;
    if(y === null || y === lastWrittenY) return;
    lastWrittenY = y;
    try{
      await authedFetch(`/pongLive/${matchId}/inputs/${mySide}.json`, {
        method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(y)
      });
    }catch(e){} // a single missed write is fine — the next sync tick retries with a fresher value anyway
  }

  async function readOpponentPaddle(){
    try{
      const res = await authedFetch(`/pongLive/${matchId}/inputs/${opponentSide}.json`);
      if(!res.ok) return;
      const y = await res.json();
      if(typeof y === 'number') session.setRemoteTargetY(y);
    }catch(e){} // isStalled() on the session already surfaces a sustained gap to the UI — no need to duplicate that handling here
  }

  return {
    async start(){
      await fetchMatchSides();
      // First read happens immediately rather than waiting a full
      // SYNC_MS — otherwise the opponent's paddle sits at the default
      // centre position for up to 80ms after the match visibly begins.
      await readOpponentPaddle();
      syncHandle = setInterval(() => {
        writeMyPaddle();
        readOpponentPaddle();
      }, SYNC_MS);
    },
    stop(){
      if(syncHandle){ clearInterval(syncHandle); syncHandle = null; }
    }
  };
}
