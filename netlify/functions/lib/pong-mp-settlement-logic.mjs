// ---- Multiplayer Pong — Stage 4a: settlement decision logic ----
//
// Same file as before, converted from a UMD wrapper to plain ESM to
// match this project's actual convention once holdem-dealer.js was
// available for reference: lib files here are .mjs with named exports
// (see holdem-engine-multiway.mjs), imported into the dealer function
// via `import { ... } from './lib/...'`. The logic itself is unchanged
// from the version already unit-tested — this is a mechanical format
// conversion, not a behavior change.
//
// What this stage's trust model actually is, stated plainly: a match is
// only ever settled once BOTH players' clients independently report the
// exact same final outcome. If they disagree, nothing is paid — the
// match freezes as 'disputed' for a human (the admin) to resolve.
//
// What it does NOT catch: two genuinely COLLUDING accounts agreeing to
// both report a fabricated result. Nothing here independently replays
// the match's input log server-side to verify the reported score is
// real — doing that properly would mean transmitting the full tick-by-
// tick input history to a server-side copy of the engine and re-running
// it, a meaningfully bigger build than this stage. For an ~11-person
// friendly group this is the same trust level already accepted
// everywhere else in this app.

export function reportsMatch(reportA, reportB) {
  if (!reportA || !reportB) return false;
  return reportA.scoreP1 === reportB.scoreP1 &&
    reportA.scoreP2 === reportB.scoreP2 &&
    reportA.winner === reportB.winner &&
    reportA.tick === reportB.tick;
}

export function isValidReport(report) {
  return !!report &&
    typeof report.scoreP1 === 'number' &&
    typeof report.scoreP2 === 'number' &&
    typeof report.tick === 'number' &&
    (report.winner === 'p1' || report.winner === 'p2');
}

// Maps the engine's abstract 'p1'/'p2' winner label to an actual uid,
// using Stage 1's fixed convention: the challenger is always p1, the
// accepting opponent is always p2.
export function computeWinnerUid(match, winnerSide) {
  if (winnerSide !== 'p1' && winnerSide !== 'p2') {
    throw new Error(`Invalid winner side: ${winnerSide}`);
  }
  return winnerSide === 'p1' ? match.challengerUid : match.opponentUid;
}

export function otherUid(match, uid) {
  return uid === match.challengerUid ? match.opponentUid : match.challengerUid;
}

// The single decision point the dealer function calls once both sides
// have reported: pure — takes plain data, returns a plain description
// of what to do. The caller is the one that actually moves XP.
export function decideSettlement(match, reportP1, reportP2) {
  if (!isValidReport(reportP1) || !isValidReport(reportP2)) {
    return { outcome: 'disputed', reason: 'malformed-report' };
  }
  if (!reportsMatch(reportP1, reportP2)) {
    return { outcome: 'disputed', reason: 'mismatched-reports' };
  }
  const winnerUid = computeWinnerUid(match, reportP1.winner);
  return {
    outcome: 'settled',
    winnerUid,
    loserUid: otherUid(match, winnerUid),
    pot: match.stake * 2,
    scoreP1: reportP1.scoreP1,
    scoreP2: reportP1.scoreP2
  };
}
