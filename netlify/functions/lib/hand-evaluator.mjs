// ---- Texas Hold'em hand evaluator ----
// Takes 7 cards (2 hole + 5 community, same {rank, suit} shape bjFreshDeck
// already uses elsewhere in DASHBOARD-index.html) and returns the best
// possible 5-card poker hand, with a score that's directly comparable
// between two players' evaluated hands to determine a winner.
//
// This is pure, stateless, dependency-free logic — no Firebase, no DOM,
// no game-state coupling. It's the one piece of a full Hold'em build that
// doesn't depend on resolving the harder architectural question (how
// hole cards stay hidden from the opponent, which needs a trusted server
// dealer — see the writeup alongside this file). Whatever shape that
// takes, this evaluator is what it will call to decide who actually won.

const HAND_RANKS = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush'
];

function rankValue(rank){
  if(rank === 'A') return 14;
  if(rank === 'K') return 13;
  if(rank === 'Q') return 12;
  if(rank === 'J') return 11;
  return Number(rank);
}

// All C(7,5) = 21 five-card combinations from a 7-card set.
function combinations5(cards){
  const result = [];
  const n = cards.length;
  for(let a = 0; a < n; a++){
    for(let b = a + 1; b < n; b++){
      for(let c = b + 1; c < n; c++){
        for(let d = c + 1; d < n; d++){
          for(let e = d + 1; e < n; e++){
            result.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
          }
        }
      }
    }
  }
  return result;
}

// Evaluates exactly 5 cards. Returns { rank: 0-9, tiebreakers: [...] } —
// tiebreakers is ordered so a plain array comparison (compareTiebreakers
// below) correctly ranks two hands of the SAME category against each
// other (e.g. two pairs of Kings, second-highest kicker wins).
function evaluate5(cards){
  const values = cards.map(c => rankValue(c.rank)).sort((a, b) => b - a); // high to low
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // Straight check, including the wheel (A-2-3-4-5, where Ace plays low).
  const uniqueDesc = [...new Set(values)];
  let isStraight = false;
  let straightHigh = null;
  if(uniqueDesc.length === 5){
    if(uniqueDesc[0] - uniqueDesc[4] === 4){
      isStraight = true;
      straightHigh = uniqueDesc[0];
    } else if(uniqueDesc.join(',') === '14,5,4,3,2'){ // wheel: A,5,4,3,2
      isStraight = true;
      straightHigh = 5; // the 5 is the effective high card in a wheel
    }
  }

  // Frequency map, e.g. {14: 2, 9: 1, ...} then grouped into
  // [[value, count], ...] sorted by count desc, then value desc — this
  // ordering is exactly what's needed to build correct tiebreakers for
  // pairs/trips/quads/full house/two pair without extra logic per case.
  const freq = {};
  values.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  const groups = Object.entries(freq)
    .map(([v, count]) => [Number(v), count])
    .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const counts = groups.map(g => g[1]);

  if(isStraight && isFlush){
    const rank = straightHigh === 14 ? 9 : 8; // royal vs plain straight flush
    return { rank, tiebreakers: [straightHigh] };
  }
  if(counts[0] === 4){
    const kicker = groups.find(g => g[1] === 1)[0];
    return { rank: 7, tiebreakers: [groups[0][0], kicker] };
  }
  if(counts[0] === 3 && counts[1] === 2){
    return { rank: 6, tiebreakers: [groups[0][0], groups[1][0]] };
  }
  if(isFlush){
    return { rank: 5, tiebreakers: values };
  }
  if(isStraight){
    return { rank: 4, tiebreakers: [straightHigh] };
  }
  if(counts[0] === 3){
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]);
    return { rank: 3, tiebreakers: [groups[0][0], ...kickers] };
  }
  if(counts[0] === 2 && counts[1] === 2){
    const pairVals = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    const kicker = groups.find(g => g[1] === 1)[0];
    return { rank: 2, tiebreakers: [...pairVals, kicker] };
  }
  if(counts[0] === 2){
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]);
    return { rank: 1, tiebreakers: [groups[0][0], ...kickers] };
  }
  return { rank: 0, tiebreakers: values };
}

// Public entry point: best hand out of all 7 cards.
function evaluateBestHand(sevenCards){
  if(sevenCards.length < 5) throw new Error('Need at least 5 cards to evaluate a hand');
  const combos = sevenCards.length === 5 ? [sevenCards] : combinations5(sevenCards);
  let best = null;
  let bestCombo = null;
  for(const combo of combos){
    const result = evaluate5(combo);
    if(!best || result.rank > best.rank || (result.rank === best.rank && compareTiebreakers(result.tiebreakers, best.tiebreakers) > 0)){
      best = result;
      bestCombo = combo;
    }
  }
  return { rank: best.rank, rankName: HAND_RANKS[best.rank], tiebreakers: best.tiebreakers, bestFive: bestCombo };
}

// Positive if a beats b, negative if b beats a, 0 if genuinely equal.
function compareTiebreakers(a, b){
  for(let i = 0; i < Math.max(a.length, b.length); i++){
    const av = a[i] || 0, bv = b[i] || 0;
    if(av !== bv) return av - bv;
  }
  return 0;
}

// Compares two already-evaluated hands (as returned by evaluateBestHand).
// Returns 1 if handA wins, -1 if handB wins, 0 for a genuine split pot.
function compareHands(handA, handB){
  if(handA.rank !== handB.rank) return handA.rank > handB.rank ? 1 : -1;
  const cmp = compareTiebreakers(handA.tiebreakers, handB.tiebreakers);
  return cmp > 0 ? 1 : cmp < 0 ? -1 : 0;
}

export { evaluateBestHand, compareHands, HAND_RANKS, rankValue };
