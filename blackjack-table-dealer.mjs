// netlify/functions/blackjack-table-dealer.js
// Trusted server-side arbiter for multiplayer Blackjack tables — same
// security model as holdem-dealer.mjs: every write to shared table state
// goes through here, never direct from a client. firebase-rules.json
// sets .write:false on /blackjackTables so nothing can bypass this and
// corrupt shared state or let a client see the dealer's hole card before
// it's revealed — the full dealer hand + remaining deck live in
// /blackjackTableSecrets, which is .read:false for EVERYONE, server
// included via REST — only reachable through this function's own
// DB_SECRET-authenticated calls.
//
// SOLO-FRIENDLY BY DESIGN: a seated player sets their own bet
// (seats[i].currentBet) whenever the table is 'waiting'. Anyone with a
// bet set can trigger dealHand — it deals in ONLY the seats that
// currently have a bet, so one person playing alone just works, and
// anyone who sits down without betting simply watches until the next
// round rather than getting pulled into a hand already in progress.
//
// Needs the same env vars already set for the other functions in this
// project: FIREBASE_DB_SECRET, FIREBASE_WEB_API_KEY. No new ones.

import crypto from "node:crypto";

const DB_BASE = "https://mlsynd-default-rtdb.firebaseio.com";
const DB_SECRET = process.env.FIREBASE_DB_SECRET;
const MAX_SEATS = 6; // matches a standard Blackjack table, and the reference layout's seat count

async function dbGet(path) {
  const res = await fetch(`${DB_BASE}${path}.json?auth=${DB_SECRET}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}
async function dbPut(path, value) {
  const res = await fetch(`${DB_BASE}${path}.json?auth=${DB_SECRET}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Firebase PUT ${path} failed: ${res.status}`);
  return res.json();
}
async function dbPost(path, value) {
  const res = await fetch(`${DB_BASE}${path}.json?auth=${DB_SECRET}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Firebase POST ${path} failed: ${res.status}`);
  return res.json(); // { name: "-Nxxxx" }
}

async function verifyFirebaseIdToken(idToken) {
  const fbApiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!fbApiKey) throw new Error("FIREBASE_WEB_API_KEY not set");
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbApiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  return user ? { uid: user.localId, email: user.email } : null;
}

async function requireApprovedUser(uid) {
  const user = await dbGet(`/users/${uid}`);
  if (!user || user.status !== "approved") throw new Error("Not an approved member");
  return user;
}

async function getXpBalance(uid) {
  const bal = await dbGet(`/xp/${uid}/balance`);
  return bal || 0;
}
async function adjustXp(uid, delta, reason) {
  const current = await getXpBalance(uid);
  const next = current + delta;
  await dbPut(`/xp/${uid}/balance`, next);
  await dbPost(`/xp/${uid}/log`, { amount: delta, reason, balanceAfter: next, ts: Date.now() });
  return next;
}
// Logs an XP-log entry WITHOUT touching the real balance — for a hand's
// result specifically, where the actual balance change only ever
// happens later, in one lump sum, at cash-out (a table's stack is
// deliberately separate from the global balance while someone's seated,
// same as a real casino's chips). Lets the Floor feed and personal XP
// log show each hand as real activity, rather than only ever showing
// the eventual net cash-out. Both renderXPLog and renderCasinoFloorFeed
// only ever read amount/reason (confirmed by checking their own code,
// not assumed) — neither depends on balanceAfter, so omitting it here
// is safe.
async function logXpEvent(uid, amount, reason) {
  await dbPost(`/xp/${uid}/log`, { amount, reason, ts: Date.now() });
}

// ---- Cards ----
// Two-character strings: rank + suit, e.g. "AS" (Ace of Spades), "TH"
// (Ten of Hearts, "T" not "10" so every card is a consistent length).
const SUITS = ["S", "H", "D", "C"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
function buildShuffledDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  // Fisher-Yates using crypto.randomInt rather than Math.random — no
  // real money on the line here, but there's no reason not to use the
  // better source when it's this cheap.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const r = c[0];
    if (r === "A") { total += 11; aces++; }
    else if (r === "T" || r === "J" || r === "Q" || r === "K") total += 10;
    else total += Number(r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function isBlackjack(cards) { return cards.length === 2 && handValue(cards) === 21; }

// Turn order walks seat indices in order, wrapping once, skipping any
// seat that isn't actually mid-hand (not betting this round, or already
// finished acting). Returns null once nobody's left to act — dealer's
// turn.
function findNextActiveSeat(seats, fromIndex) {
  for (let offset = 1; offset <= MAX_SEATS; offset++) {
    const idx = (fromIndex + offset) % MAX_SEATS;
    const seat = seats[idx];
    if (seat && seat.inHand && seat.handStatus === "playing") return idx;
  }
  return null;
}

// Dealer reveals and plays out their hand, then settles every seat still
// inHand against it. Standard "dealer stands on any 17" rule, matching
// this app's own existing reference text elsewhere ("Dealer stands on
// 17") rather than the hit-on-soft-17 variant. Mutates and returns the
// updated seats object plus a plain-language summary per seat, both
// written back by the caller.
function playDealerAndSettle(seats, deck, dealerHand) {
  while (handValue(dealerHand) < 17) dealerHand.push(deck.pop());
  const dealerTotal = handValue(dealerHand);
  const dealerBust = dealerTotal > 21;
  const dealerBJ = isBlackjack(dealerHand);

  const results = [];
  for (const idx of Object.keys(seats)) {
    const seat = seats[idx];
    if (!seat || !seat.inHand) continue;
    const bet = seat.currentBet || 0;
    let payout = 0, outcome;
    if (seat.handStatus === "busted") { outcome = "bust"; }
    else if (isBlackjack(seat.hand) && dealerBJ) { payout = bet; outcome = "push"; }
    else if (isBlackjack(seat.hand)) { payout = Math.floor(bet * 2.5); outcome = "blackjack"; }
    else if (dealerBust) { payout = bet * 2; outcome = "win"; }
    else {
      const playerTotal = handValue(seat.hand);
      if (playerTotal > dealerTotal) { payout = bet * 2; outcome = "win"; }
      else if (playerTotal === dealerTotal) { payout = bet; outcome = "push"; }
      else { outcome = "lose"; }
    }
    seat.stack = (seat.stack || 0) + payout;
    results.push({ uid: seat.uid, name: seat.name, outcome, net: payout - bet });
    seat.hand = [];
    seat.currentBet = 0;
    seat.inHand = false;
    seat.handStatus = null;
  }
  return { seats, dealerHand, dealerTotal, dealerBust, dealerBJ, results };
}

// Shared by dealHand/hit/stand/double: finds whoever's next to act, or
// settles the whole hand against the dealer if nobody's left. Always
// writes the FULL secrets object ({ dealerHand, deck }) rather than
// just the deck field, even though dealerHand itself never changes
// mid-hand — simpler and safer than a partial write that would only be
// correct for callers who already know the secrets path exists.
async function advanceTurnOrSettle(tableId, table, seats, deck, dealerHand, fromSeatIndex) {
  const nextTurn = findNextActiveSeat(seats, fromSeatIndex);
  if (nextTurn == null) {
    const settled = playDealerAndSettle(seats, deck, dealerHand);
    table.seats = settled.seats;
    table.status = "waiting";
    table.currentTurnSeatIndex = null;
    table.dealerUpCard = null;
    table.lastHandResult = {
      dealerHand: settled.dealerHand, dealerTotal: settled.dealerTotal,
      dealerBust: settled.dealerBust, dealerBJ: settled.dealerBJ,
      results: settled.results, endedAt: Date.now(),
    };
    await dbPut(`/blackjackTables/${tableId}`, table);
    await dbPut(`/blackjackTableSecrets/${tableId}`, null);
    // Logs each seat's net result to their own XP log — doesn't touch
    // the actual balance (see logXpEvent's own comment for why), purely
    // so the Floor feed and personal XP log have a real entry for the
    // hand itself. Pushes excluded (net === 0, nothing actually won or
    // lost worth showing). Awaited with individually-caught failures
    // rather than fire-and-forget — this is a serverless function, and
    // returning the response before these actually finish risks the
    // execution context being frozen mid-write.
    const outcomeLabels = { bust: "bust", blackjack: "blackjack!", win: "win", lose: "loss" };
    await Promise.all(
      settled.results
        .filter(r => r.net !== 0)
        .map(r => logXpEvent(r.uid, r.net, `Live Blackjack ${outcomeLabels[r.outcome] || r.outcome} — ${table.name}`).catch(() => {}))
    );
    return { table, settled: true };
  }
  table.seats = seats;
  table.status = "playing"; // real bug fixed here: this was never being set anywhere in the file — table.status stayed "waiting" through an entire hand, which meant the client's isPlaying check (dealer cards, turn highlight, Hit/Stand/Double visibility) never once turned true
  table.currentTurnSeatIndex = nextTurn;
  await dbPut(`/blackjackTables/${tableId}`, table);
  await dbPut(`/blackjackTableSecrets/${tableId}`, { dealerHand, deck });
  return { table, settled: false };
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!DB_SECRET) {
    return new Response(JSON.stringify({ error: "Server not configured" }), { status: 500 });
  }

  try {
    const { idToken, action, tableId, name, minBuyIn, seatIndex, buyInAmount, gameType, betAmount } = await req.json();
    if (!idToken || !action) {
      return new Response(JSON.stringify({ error: "Missing idToken or action" }), { status: 400 });
    }

    const auth = await verifyFirebaseIdToken(idToken);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401 });
    }
    const user = await requireApprovedUser(auth.uid);
    const uid = auth.uid;
    const displayName = user.name || "Someone";

    // No-op diagnostic — exercises the exact same verifyFirebaseIdToken
    // → requireApprovedUser path every other action depends on (the
    // DB_SECRET → /users/{uid} read specifically), with zero side
    // effects. Added after a real failure where that read 401'd — the
    // deployment check alone (an empty POST body) never reached this
    // far, so it couldn't have caught this class of problem.
    if (action === "ping") {
      return new Response(JSON.stringify({ ok: true, uid, name: displayName }), { status: 200 });
    }

    // Admin force-delete, both game types — handled here, BEFORE the
    // generic /blackjackTables lookup below, since this needs to work
    // on a Hold'em table too (which wouldn't exist at that path at all).
    // Deliberately doesn't depend on holdem-dealer.mjs's own delete
    // logic or its status checks — the whole point is clearing a table
    // stuck in a state (e.g. Hold'em's status permanently wedged at
    // 'hand_in_progress') that would make the NORMAL delete path fail.
    // DB_SECRET can write to /holdemTables regardless of which function
    // file calls it, so this works without touching holdem-dealer.mjs.
    if (action === "adminForceDeleteTable") {
      if ((auth.email || "").toLowerCase() !== "mlsynd00@gmail.com") {
        return new Response(JSON.stringify({ error: "Admin only" }), { status: 403 });
      }
      if (!tableId || (gameType !== "holdem" && gameType !== "blackjack")) {
        return new Response(JSON.stringify({ error: "Missing tableId, or gameType must be 'holdem' or 'blackjack'" }), { status: 400 });
      }
      const path = gameType === "holdem" ? `/holdemTables/${tableId}` : `/blackjackTables/${tableId}`;
      const forceTable = await dbGet(path);
      if (!forceTable) {
        return new Response(JSON.stringify({ error: "Table not found — it may already be gone" }), { status: 404 });
      }
      const forceSeats = forceTable.seats || {};
      for (const idx of Object.keys(forceSeats)) {
        const s = forceSeats[idx];
        // Refund a staged bet too — for Blackjack specifically a seat
        // could be mid-hand with currentBet already deducted from
        // stack; Hold'em seats don't have this field at all, so the
        // (s.currentBet || 0) fallback is what makes this safe for both
        // game types sharing this one code path.
        const total = s ? (s.stack || 0) + (s.currentBet || 0) : 0;
        if (s && s.uid && total > 0) await adjustXp(s.uid, total, `Table force-closed by admin — ${forceTable.name || "table"} (refund)`);
      }
      await dbPut(path, null);
      if (gameType === "blackjack") await dbPut(`/blackjackTableSecrets/${tableId}`, null);
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }

    if (action === "createTable") {
      const cleanName = (name || "").trim().slice(0, 40) || `${displayName}'s Table`;
      const cleanMin = Math.max(1, Math.floor(Number(minBuyIn) || 100));
      const seats = {};
      for (let i = 0; i < MAX_SEATS; i++) seats[i] = null;
      const table = {
        name: cleanName, createdBy: uid, createdByName: displayName, createdAt: Date.now(),
        maxSeats: MAX_SEATS, minBuyIn: cleanMin, seats, status: "waiting",
      };
      const created = await dbPost("/blackjackTables", table);
      return new Response(JSON.stringify({ tableId: created.name, table }), { status: 200 });
    }

    if (!tableId) {
      return new Response(JSON.stringify({ error: "Missing tableId" }), { status: 400 });
    }
    const table = await dbGet(`/blackjackTables/${tableId}`);
    if (!table) {
      return new Response(JSON.stringify({ error: "Table not found — it may have been closed" }), { status: 404 });
    }

    if (action === "sit") {
      if (seatIndex == null || seatIndex < 0 || seatIndex >= (table.maxSeats || MAX_SEATS)) {
        return new Response(JSON.stringify({ error: "Invalid seat" }), { status: 400 });
      }
      if (table.seats && table.seats[seatIndex]) {
        return new Response(JSON.stringify({ error: "That seat is already taken" }), { status: 409 });
      }
      // Already seated elsewhere at this table? Standing up first avoids
      // one person occupying two seats at once.
      const alreadySeated = Object.values(table.seats || {}).some(s => s && s.uid === uid);
      if (alreadySeated) {
        return new Response(JSON.stringify({ error: "You're already seated at this table" }), { status: 409 });
      }
      const amount = Math.floor(Number(buyInAmount) || 0);
      const min = table.minBuyIn || 1;
      if (amount < min) {
        return new Response(JSON.stringify({ error: `Buy-in must be at least ${min} XP` }), { status: 400 });
      }
      const balance = await getXpBalance(uid);
      if (amount > balance) {
        return new Response(JSON.stringify({ error: `You only have ${balance} XP` }), { status: 400 });
      }
      await adjustXp(uid, -amount, `Live Blackjack table buy-in — ${table.name}`);
      const seat = { uid, name: displayName, stack: amount, joinedAt: Date.now() };
      await dbPut(`/blackjackTables/${tableId}/seats/${seatIndex}`, seat);
      return new Response(JSON.stringify({ seat }), { status: 200 });
    }

    if (action === "setBet") {
      const seats = table.seats || {};
      const myIndex = Object.keys(seats).find(i => seats[i] && seats[i].uid === uid);
      if (myIndex == null) {
        return new Response(JSON.stringify({ error: "You're not seated at this table" }), { status: 400 });
      }
      if (table.status === "playing") {
        return new Response(JSON.stringify({ error: "A hand is already in progress — wait for it to finish" }), { status: 409 });
      }
      const seat = seats[myIndex];
      const amount = Math.floor(Number(betAmount) || 0);
      if (amount < 0) {
        return new Response(JSON.stringify({ error: "Invalid bet" }), { status: 400 });
      }
      // Refund whatever was already staged before applying the new
      // amount — otherwise changing your bet before the deal double-
      // deducts from your stack.
      const availableForBet = (seat.stack || 0) + (seat.currentBet || 0);
      if (amount > availableForBet) {
        return new Response(JSON.stringify({ error: `You only have ${availableForBet} XP available` }), { status: 400 });
      }
      seat.stack = availableForBet - amount;
      seat.currentBet = amount;
      await dbPut(`/blackjackTables/${tableId}/seats/${myIndex}`, seat);
      return new Response(JSON.stringify({ seat }), { status: 200 });
    }

    if (action === "dealHand") {
      if (table.status === "playing") {
        return new Response(JSON.stringify({ error: "A hand is already in progress" }), { status: 409 });
      }
      const seats = table.seats || {};
      // Only seats with a bet currently staged get dealt in — this is
      // the entire mechanism that makes solo play and mid-session
      // joining work: someone sitting down without betting just isn't
      // part of the next hand at all, no special-casing needed anywhere
      // else.
      const bettingIndices = Object.keys(seats).filter(i => seats[i] && seats[i].currentBet > 0);
      if (bettingIndices.length === 0) {
        return new Response(JSON.stringify({ error: "Nobody's placed a bet yet" }), { status: 400 });
      }
      const deck = buildShuffledDeck();
      bettingIndices.forEach(i => {
        seats[i].hand = [deck.pop(), deck.pop()];
        seats[i].inHand = true;
        // An instant blackjack has nothing left to decide — marked
        // stood immediately rather than waiting on a hit/stand that
        // would never make sense to offer.
        seats[i].handStatus = isBlackjack(seats[i].hand) ? "stood" : "playing";
      });
      const dealerHand = [deck.pop(), deck.pop()];
      table.dealerUpCard = dealerHand[0];
      // fromSeatIndex -1 wraps to 0 via the modulo in findNextActiveSeat,
      // so turn order genuinely starts from seat 0, not seat 1.
      const result = await advanceTurnOrSettle(tableId, table, seats, deck, dealerHand, -1);
      return new Response(JSON.stringify(result), { status: 200 });
    }

    if (action === "hit") {
      if (table.status !== "playing") {
        return new Response(JSON.stringify({ error: "No hand in progress" }), { status: 400 });
      }
      const seats = table.seats || {};
      const myIndex = Object.keys(seats).find(i => seats[i] && seats[i].uid === uid);
      if (myIndex == null || Number(myIndex) !== Number(table.currentTurnSeatIndex)) {
        return new Response(JSON.stringify({ error: "It's not your turn" }), { status: 403 });
      }
      const secrets = await dbGet(`/blackjackTableSecrets/${tableId}`);
      if (!secrets || !secrets.deck || !secrets.dealerHand) {
        return new Response(JSON.stringify({ error: "Table state is out of sync — try refreshing" }), { status: 500 });
      }
      const deck = secrets.deck;
      const seat = seats[myIndex];
      seat.hand.push(deck.pop());
      if (handValue(seat.hand) > 21) {
        seat.handStatus = "busted";
        const result = await advanceTurnOrSettle(tableId, table, seats, deck, secrets.dealerHand, Number(myIndex));
        return new Response(JSON.stringify(result), { status: 200 });
      }
      // Not bust — stays their turn, they can hit again or stand next.
      table.seats = seats;
      await dbPut(`/blackjackTables/${tableId}`, table);
      await dbPut(`/blackjackTableSecrets/${tableId}`, { dealerHand: secrets.dealerHand, deck });
      return new Response(JSON.stringify({ table }), { status: 200 });
    }

    if (action === "stand") {
      if (table.status !== "playing") {
        return new Response(JSON.stringify({ error: "No hand in progress" }), { status: 400 });
      }
      const seats = table.seats || {};
      const myIndex = Object.keys(seats).find(i => seats[i] && seats[i].uid === uid);
      if (myIndex == null || Number(myIndex) !== Number(table.currentTurnSeatIndex)) {
        return new Response(JSON.stringify({ error: "It's not your turn" }), { status: 403 });
      }
      const secrets = await dbGet(`/blackjackTableSecrets/${tableId}`);
      if (!secrets || !secrets.deck || !secrets.dealerHand) {
        return new Response(JSON.stringify({ error: "Table state is out of sync — try refreshing" }), { status: 500 });
      }
      seats[myIndex].handStatus = "stood";
      const result = await advanceTurnOrSettle(tableId, table, seats, secrets.deck, secrets.dealerHand, Number(myIndex));
      return new Response(JSON.stringify(result), { status: 200 });
    }

    if (action === "double") {
      if (table.status !== "playing") {
        return new Response(JSON.stringify({ error: "No hand in progress" }), { status: 400 });
      }
      const seats = table.seats || {};
      const myIndex = Object.keys(seats).find(i => seats[i] && seats[i].uid === uid);
      if (myIndex == null || Number(myIndex) !== Number(table.currentTurnSeatIndex)) {
        return new Response(JSON.stringify({ error: "It's not your turn" }), { status: 403 });
      }
      const seat = seats[myIndex];
      if (seat.hand.length !== 2) {
        return new Response(JSON.stringify({ error: "Can only double on your first two cards" }), { status: 400 });
      }
      if (seat.stack < seat.currentBet) {
        return new Response(JSON.stringify({ error: "Not enough XP left to double" }), { status: 400 });
      }
      const secrets = await dbGet(`/blackjackTableSecrets/${tableId}`);
      if (!secrets || !secrets.deck || !secrets.dealerHand) {
        return new Response(JSON.stringify({ error: "Table state is out of sync — try refreshing" }), { status: 500 });
      }
      seat.stack -= seat.currentBet;
      seat.currentBet *= 2;
      const deck = secrets.deck;
      seat.hand.push(deck.pop());
      // Double is always exactly one more card, then done, win or bust.
      seat.handStatus = handValue(seat.hand) > 21 ? "busted" : "stood";
      const result = await advanceTurnOrSettle(tableId, table, seats, deck, secrets.dealerHand, Number(myIndex));
      return new Response(JSON.stringify(result), { status: 200 });
    }

    if (action === "standUp") {
      const seats = table.seats || {};
      const myIndex = Object.keys(seats).find(i => seats[i] && seats[i].uid === uid);
      if (myIndex == null) {
        return new Response(JSON.stringify({ error: "You're not seated at this table" }), { status: 400 });
      }
      // Can't leave mid-hand — same as walking away from a real table
      // with cards still in play. Once the hand settles (handStatus
      // clears back to null), standing up is fine again.
      if (seats[myIndex].inHand) {
        return new Response(JSON.stringify({ error: "You're mid-hand — wait for it to finish before standing up" }), { status: 409 });
      }
      // Refund an active bet too, not just the remaining stack — a bet
      // staged but not yet dealt is still real XP that was deducted.
      const stack = (seats[myIndex].stack || 0) + (seats[myIndex].currentBet || 0);
      if (stack > 0) await adjustXp(uid, stack, `Live Blackjack table cash out — ${table.name}`);
      await dbPut(`/blackjackTables/${tableId}/seats/${myIndex}`, null);
      // If the table's now empty, close it out rather than leaving an
      // abandoned empty table sitting in the browser list indefinitely.
      const stillOccupied = Object.keys(seats).some(i => i !== myIndex && seats[i]);
      if (!stillOccupied) await dbPut(`/blackjackTables/${tableId}`, null);
      return new Response(JSON.stringify({ stackReturned: stack }), { status: 200 });
    }

    if (action === "deleteTable") {
      // Real bug caught while writing this: checked user.email (from
      // /users/{uid}, which doesn't reliably store it) instead of the
      // verified token's own email — same mistake already caught and
      // fixed once before in send-payout-notify.mjs, fixed here before
      // it ever shipped.
      const isAdmin = (auth.email || "").toLowerCase() === "mlsynd00@gmail.com";
      const isCreatorOrAdmin = table.createdBy === uid || !table.createdBy || isAdmin;
      if (!isCreatorOrAdmin) {
        return new Response(JSON.stringify({ error: "Only the table's creator or an admin can delete it" }), { status: 403 });
      }
      const seats = table.seats || {};
      for (const idx of Object.keys(seats)) {
        const s = seats[idx];
        // Refund a staged bet too, same reasoning as standUp above.
        const total = s ? (s.stack || 0) + (s.currentBet || 0) : 0;
        if (s && total > 0) await adjustXp(s.uid, total, `Live Blackjack table closed — ${table.name} (refund)`);
      }
      await dbPut(`/blackjackTables/${tableId}`, null);
      await dbPut(`/blackjackTableSecrets/${tableId}`, null);
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

