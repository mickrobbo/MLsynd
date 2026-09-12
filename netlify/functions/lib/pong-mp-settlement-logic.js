// ---- Multiplayer Pong — Stage 4a: settlement decision logic ----
//
// Same split as Stages 2/3: anything that's a pure function of plain
// data lives here and gets unit-tested directly; anything that actually
// touches Firebase lives in the Netlify function (pong-mp-dealer.js)
// that requires this file, and is NOT independently testable here.
//
// What this stage's trust model actually is, stated plainly: a match is
// only ever settled once BOTH players' clients independently report the
// exact same final outcome. If they disagree, nothing is paid — the
// match freezes as 'disputed' for a human (the admin) to resolve. This
// catches an honest client that lost sync with its opponent (a bug in
// Stages 2/3, or a genuine network failure) and turns it into a visible
// dispute instead of a wrong, silent payout.
//
// What it does NOT catch: two genuinely COLLUDING accounts agreeing to
// both report a fabricated result. Nothing here independently replays
// the match's input log server-side to verify the reported score is
// real — doing that properly would mean transmitting the full tick-by-
// tick input history to a server-side copy of the engine and re-running
// it, which is a meaningfully bigger build than this stage. For an
// ~11-person friendly group this is the same trust level already
// accepted everywhere else in this app (every casino game debits/credits
// its own XP client-side) — worth knowing about, not silently assumed
// solved.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PongMpSettlementLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Both sides must agree on every one of these fields — not just
  // "who won", but the exact score and tick it happened at. Requiring
  // the full match, not just the headline winner, means a subtle
  // desync bug (e.g. one side thinks it's 7-5, the other thinks 7-4)
  // gets caught as a dispute rather than silently agreeing on "p1 won"
  // while disagreeing on everything else about how.
  function reportsMatch(reportA, reportB) {
    if (!reportA || !reportB) return false;
    return reportA.scoreP1 === reportB.scoreP1 &&
      reportA.scoreP2 === reportB.scoreP2 &&
      reportA.winner === reportB.winner &&
      reportA.tick === reportB.tick;
  }

  function isValidReport(report) {
    return !!report &&
      typeof report.scoreP1 === 'number' &&
      typeof report.scoreP2 === 'number' &&
      typeof report.tick === 'number' &&
      (report.winner === 'p1' || report.winner === 'p2');
  }

  // Maps the engine's abstract 'p1'/'p2' winner label to an actual uid,
  // using Stage 1's fixed convention: the challenger is always p1, the
  // accepting opponent is always p2.
  function computeWinnerUid(match, winnerSide) {
    if (winnerSide !== 'p1' && winnerSide !== 'p2') {
      throw new Error(`Invalid winner side: ${winnerSide}`);
    }
    return winnerSide === 'p1' ? match.challengerUid : match.opponentUid;
  }

  function otherUid(match, uid) {
    return uid === match.challengerUid ? match.opponentUid : match.challengerUid;
  }

  // The single decision point for handleReportResult in the dealer
  // function: given the match record and both sides' now-complete
  // reports, decide whether this is a clean settlement or a dispute.
  // Pure — takes plain data, returns a plain description of what to do;
  // the caller (the actual Netlify function) is the one that goes and
  // moves real XP based on this answer.
  function decideSettlement(match, reportP1, reportP2) {
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

  return { reportsMatch, isValidReport, computeWinnerUid, otherUid, decideSettlement };
});
