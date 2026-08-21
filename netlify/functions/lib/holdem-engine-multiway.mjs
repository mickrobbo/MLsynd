// ---- Multi-way Fixed-Limit Hold'em engine (up to 9 players) ----
// Pure state-transition logic, same discipline as the heads-up version
// this replaces: no Firebase, no network, no DOM, fully testable in
// isolation. This is NOT an extension of holdem-engine.js — 3+ players
// introduces side pots (impossible in heads-up, where there are only ever
// two stacks and therefore only ever one pot), dealer-button rotation,
// and genuinely different action-order and round-completion rules. This
// file supersedes holdem-engine.js for anything beyond exactly 2 seated
// players.
//
// Still Fixed-Limit (see holdem-engine.js's header for why that choice
// was made) — No-Limit multi-way with side pots is a real future step
// up, not a first version.

import { randomInt } from 'crypto';
import { evaluateBestHand, compareHands } from './hand-evaluator.mjs';

const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];
const MAX_BETS_PER_STREET = 4;
const MAX_SEATS = 9;

function freshDeck(){
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  suits.forEach(s => ranks.forEach(r => deck.push({ rank: r, suit: s })));
  // Cryptographically secure shuffle — Math.random() is a fast, non-secure
  // PRNG never meant for anything where the output needs to be
  // unpredictable to an adversary. crypto.randomInt is Node's built-in
  // CSPRNG-backed integer generator, unbiased by construction (unlike
  // hand-rolling modulo on raw random bytes), same Fisher-Yates shape as
  // before so nothing else about this function's contract changes.
  for(let i = deck.length - 1; i > 0; i--){
    const j = randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Input is the TRUE big blind (this is what table.bigBlind means
// everywhere else — the table creation UI literally labels it "Big
// blind (XP)"). Small blind is derived as half of it. Previously this
// function treated its own input AS the small blind and doubled it for
// "big" — meaning every table's real stakes were silently double whatever
// the creator configured, in every single hand, not just an edge case.
// Caught by an external review, not by the original test suite, because
// the tests only checked internal consistency against this function's
// own (buggy) definition rather than against what the parameter name
// actually promises.
function betSizes(bigBlind){
  return { small: Math.max(1, Math.floor(bigBlind / 2)), big: bigBlind };
}

// seats: ordered array of { uid, stack } — order is the actual seating
// order around the table, index 0 through N-1, clockwise. buttonIndex
// picks who's on the button for this hand (rotate this externally between
// hands, e.g. (buttonIndex + 1) % seats.length, skipping anyone who's
// stood up — this function just deals the hand it's given).
function createHand(seats, buttonIndex, bigBlind){
  if(seats.length < 2) throw new Error('Need at least 2 seated players to deal a hand');
  if(seats.length > MAX_SEATS) throw new Error(`Max ${MAX_SEATS} seats`);
  const { small, big } = betSizes(bigBlind);
  const deck = freshDeck();
  const n = seats.length;
  const order = seats.map((s, i) => seats[(buttonIndex + i) % n].uid); // order[0] = button

  const players = {};
  seats.forEach(s => {
    players[s.uid] = {
      uid: s.uid, stack: s.stack, committed: 0, totalCommitted: 0,
      folded: false, allIn: false, holeCards: [deck.pop(), deck.pop()]
    };
  });

  // Heads-up (exactly 2 players) is the one case where button ≠ first-to-act
  // convention flips (button posts small blind and acts first preflop) —
  // everywhere else, the two players immediately left of the button post
  // the blinds. Handling both here means the SAME engine covers a
  // 2-handed table that's short down to heads-up mid-session, not just
  // dedicated 3+ tables.
  const sbUid = n === 2 ? order[0] : order[1];
  const bbUid = n === 2 ? order[1] : order[2 % n];
  // postBlind returns the REAL amount posted (capped at the player's
  // stack, for a short-stacked blind) — the pot and action log now use
  // these actual amounts, not the nominal small/big blind size. Posting
  // a blind you can't fully afford correctly goes all-in for whatever
  // you have, and the pot/log reflect exactly that, not the full blind.
  const sbPosted = postBlind(players, sbUid, small);
  const bbPosted = postBlind(players, bbUid, big);

  const firstToActPreflop = n === 2 ? sbUid : order[3 % n] || order[0];

  const hand = {
    bigBlind, seatOrder: order, buttonUid: order[0],
    deck,
    players,
    board: [],
    street: 'preflop',
    pot: sbPosted + bbPosted,
    betsThisStreet: 1,
    toAct: firstToActPreflop,
    // Excludes all-in players — someone who's already all-in from posting
    // a short-stacked blind can never take a further action to remove
    // themselves from this set, so including them here meant the round
    // could never close via needsToAct reaching empty. Matches how this
    // set is correctly rebuilt after every bet/raise elsewhere in this
    // file (activeNonAllInUids, not activeUids).
    needsToAct: new Set(activeNonAllInUids(players)),
    lastAggressorUid: null,
    actionLog: [{ uid: sbUid, action: 'post-sb', amount: sbPosted }, { uid: bbUid, action: 'post-bb', amount: bbPosted }],
    result: null // set once the hand ends: { pots: [{amount, winners:[uid,...], eligiblePlayers:[...]}, ...], reason }
  };

  // A short-stacked blind can go all-in on the very first forced post,
  // before anyone has voluntarily acted at all — if that leaves at most
  // one player who can still act, there's no betting left to do this
  // hand, full stop. Previously toAct was still set to firstToActPreflop
  // regardless, even when that exact player had just gone all-in posting
  // their own blind — legalActions correctly returned nothing for them,
  // and the hand had no way to proceed. Caught by fuzzing short stacks
  // specifically, not by the original test suite (which only used deep
  // 1000-XP stacks that never bankrupt on a blind).
  if(activeNonAllInUids(players).length <= 1){
    return goToNextStreetOrRunout(hand);
  }
  hand.toAct = nextToActFrom(hand, firstToActPreflop);
  return hand;
}

// Like nextToAct, but checks `uid` itself first before searching forward
// — used for the very first action of a street/hand, where the "default"
// first-to-act seat might itself be folded or all-in and need skipping,
// not just the seat after it.
function nextToActFrom(hand, uid){
  const p = hand.players[uid];
  if(!p.folded && !p.allIn) return uid;
  return nextToAct(hand, uid);
}

// Returns the REAL amount posted — capped at the player's stack, so a
// short-stacked blind correctly goes all-in for whatever they have
// instead of the nominal blind size. Callers must use this return value
// for the pot and action log, not the nominal `amount` passed in.
function postBlind(players, uid, amount){
  const p = players[uid];
  const actual = Math.min(amount, p.stack);
  p.stack -= actual;
  p.committed += actual;
  p.totalCommitted += actual;
  if(p.stack === 0) p.allIn = true;
  return actual;
}

function activeUids(players){
  return Object.values(players).filter(p => !p.folded).map(p => p.uid);
}
function activeNonAllInUids(players){
  return Object.values(players).filter(p => !p.folded && !p.allIn).map(p => p.uid);
}

function currentBetSize(hand){
  const { small, big } = betSizes(hand.bigBlind);
  return (hand.street === 'preflop' || hand.street === 'flop') ? small : big;
}
function highestCommitted(hand){
  return Math.max(0, ...Object.values(hand.players).filter(p => !p.folded).map(p => p.committed));
}
function toCallAmount(hand, uid){
  return Math.max(0, highestCommitted(hand) - hand.players[uid].committed);
}

function legalActions(hand, uid){
  if(hand.result) return [];
  if(hand.toAct !== uid) return [];
  const p = hand.players[uid];
  if(p.folded || p.allIn) return [];
  const toCall = toCallAmount(hand, uid);
  const actions = ['fold'];
  if(toCall === 0) actions.push('check'); else actions.push('call');
  if(hand.betsThisStreet < MAX_BETS_PER_STREET && p.stack > toCall){
    actions.push(hand.betsThisStreet === 0 ? 'bet' : 'raise');
  }
  return actions;
}

// Next active (non-folded), non-all-in seat clockwise from `uid`. Skips
// anyone who's folded or already all-in (they don't get further turns —
// an all-in player has no more chips to act with, they just wait for
// showdown). Returns null if nobody else can act.
function nextToAct(hand, uid){
  const order = hand.seatOrder;
  const startIdx = order.indexOf(uid);
  for(let i = 1; i <= order.length; i++){
    const candidate = order[(startIdx + i) % order.length];
    const p = hand.players[candidate];
    if(!p.folded && !p.allIn) return candidate;
  }
  return null;
}

function applyAction(hand, uid, action){
  if(hand.result) throw new Error('Hand is already over');
  if(hand.toAct !== uid) throw new Error('Not your turn');
  const legal = legalActions(hand, uid);
  if(!legal.includes(action)) throw new Error(`Illegal action "${action}" — legal actions right now: ${legal.join(', ')}`);

  const next = deepClone(hand);
  const p = next.players[uid];
  const toCall = toCallAmount(next, uid);
  const betSize = currentBetSize(next);

  if(action === 'fold'){
    p.folded = true;
    next.needsToAct.delete(uid);
    next.actionLog.push({ uid, action: 'fold', amount: 0 });
    const stillIn = activeUids(next.players);
    if(stillIn.length === 1){
      finishHandUncontested(next, stillIn[0]);
      return next;
    }
    return advance(next);
  }

  next.needsToAct.delete(uid);

  if(action === 'check'){
    next.actionLog.push({ uid, action: 'check', amount: 0 });
    return advance(next);
  }

  if(action === 'call'){
    const amount = Math.min(toCall, p.stack);
    commit(p, next, amount);
    next.actionLog.push({ uid, action: 'call', amount });
    return advance(next);
  }

  if(action === 'bet' || action === 'raise'){
    const amount = Math.min(toCall + betSize, p.stack);
    commit(p, next, amount);
    next.betsThisStreet += 1;
    next.lastAggressorUid = uid;
    next.actionLog.push({ uid, action, amount });
    // A bet/raise reopens action for every other active, non-all-in
    // player — including anyone who'd already acted this street.
    next.needsToAct = new Set(activeNonAllInUids(next.players).filter(u => u !== uid));
    return advance(next);
  }

  throw new Error('Unknown action: ' + action);
}

function commit(p, hand, amount){
  p.stack -= amount;
  p.committed += amount;
  p.totalCommitted += amount;
  hand.pot += amount;
  if(p.stack === 0) p.allIn = true;
}

function finishHandUncontested(hand, winnerUid){
  const pots = computeSidePots(hand.players);
  pots.forEach(pot => { pot.winners = pot.eligiblePlayers.includes(winnerUid) ? [winnerUid] : pot.eligiblePlayers; });
  hand.result = { pots, reason: 'fold' };
  hand.street = 'showdown';
}

// Decides whether the betting round is over (needsToAct empty, or only
// one non-all-in player remains with nobody left who could still raise —
// e.g. everyone else is all-in) and either advances to the next street or
// passes the turn to the next active player.
function advance(hand){
  const nonAllIn = activeNonAllInUids(hand.players);
  // If at most one active player still HAS chips to act with, no more
  // betting is possible this hand regardless of needsToAct — everyone
  // else is either folded or already all-in. Run out the remaining
  // streets straight to showdown.
  if(hand.needsToAct.size === 0 || nonAllIn.length <= 1){
    return goToNextStreetOrRunout(hand);
  }
  hand.toAct = nextToAct(hand, hand.toAct);
  return hand;
}

function goToNextStreetOrRunout(hand){
  const idx = STREETS.indexOf(hand.street);
  const next = STREETS[idx + 1];
  Object.values(hand.players).forEach(p => { p.committed = 0; });
  hand.betsThisStreet = 0;
  hand.lastAggressorUid = null;
  if(next === 'flop') hand.board.push(deckPop(hand), deckPop(hand), deckPop(hand));
  else if(next === 'turn' || next === 'river') hand.board.push(deckPop(hand));

  const nonAllIn = activeNonAllInUids(hand.players);
  if(next === 'showdown' || nonAllIn.length <= 1){
    // Either genuinely reached showdown, or everyone left is all-in with
    // no more decisions possible — deal out any remaining streets face-up
    // and go straight to showdown, same as a real table would.
    while(hand.board.length < 5){ hand.board.push(deckPop(hand)); }
    resolveShowdown(hand);
    return hand;
  }
  hand.street = next;
  hand.needsToAct = new Set(nonAllIn);
  hand.toAct = nextToAct(hand, hand.buttonUid) || nonAllIn[0]; // first active player left of the button postflop
  // nextToAct search starts AFTER the given uid, so seeding with buttonUid
  // correctly finds the first active seat clockwise from the button.
  return hand;
}

// deckPop needs the original deck, which createHand doesn't keep on the
// hand object by default in this sketch — callers should attach it (see
// note in createHand usage below). Kept as a named helper so the intent
// ("draw the next card off the shared deck for this hand") is explicit
// wherever it's called, rather than reaching into hand.deck inline.
function deckPop(hand){
  return hand.deck.pop();
}

// Splits the total pot into layers based on each player's TOTAL
// commitment across the whole hand (all streets combined) — the standard
// side-pot algorithm. A player who went all-in for less can only ever win
// a pot capped at their own contribution, multiplied across however many
// players (folded or not) put in at least that much; anything committed
// above that level by other players forms a separate pot those short
// players aren't eligible for.
function computeSidePots(players){
  const contributors = Object.values(players).filter(p => p.totalCommitted > 0);
  const levels = [...new Set(contributors.map(p => p.totalCommitted))].sort((a, b) => a - b);
  const pots = [];
  let prevLevel = 0;
  levels.forEach(level => {
    const layerSize = level - prevLevel;
    if(layerSize <= 0){ prevLevel = level; return; }
    // Everyone who committed at least up to this level contributes to this
    // layer of the pot (folded players' chips still count toward the
    // pot amount — they just aren't eligible to WIN any of it).
    const payingThisLayer = contributors.filter(p => p.totalCommitted >= level);
    const amount = layerSize * payingThisLayer.length;
    const eligiblePlayers = payingThisLayer.filter(p => !p.folded).map(p => p.uid);
    if(amount > 0 && eligiblePlayers.length > 0){
      pots.push({ amount, eligiblePlayers });
    }
    prevLevel = level;
  });
  return pots;
}

function resolveShowdown(hand){
  hand.street = 'showdown';
  const evaluated = {};
  activeUids(hand.players).forEach(uid => {
    evaluated[uid] = evaluateBestHand([...hand.players[uid].holeCards, ...hand.board]);
  });
  const pots = computeSidePots(hand.players);
  pots.forEach(pot => {
    let best = null;
    let winners = [];
    pot.eligiblePlayers.forEach(uid => {
      const hval = evaluated[uid];
      if(!best || compareHands(hval, best) > 0){
        best = hval;
        winners = [uid];
      } else if(compareHands(hval, best) === 0){
        winners.push(uid);
      }
    });
    pot.winners = winners;
  });
  hand.result = { pots, reason: 'showdown', evaluated };
}

function deepClone(hand){
  const { deck, ...rest } = hand;
  const cloned = JSON.parse(JSON.stringify({ ...rest, needsToAct: [...rest.needsToAct] }));
  cloned.needsToAct = new Set(cloned.needsToAct);
  cloned.deck = deck; // the deck itself is only ever popped from, never rewound — safe and much cheaper to share by reference than deep-clone a 52-card array on every single action
  return cloned;
}

export { createHand, applyAction, legalActions, betSizes, freshDeck, computeSidePots, STREETS, MAX_SEATS };
