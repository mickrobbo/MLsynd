// netlify/functions/blackjack-table-dealer.js
// Trusted server-side arbiter for multiplayer Blackjack tables — same
// security model as holdem-dealer.mjs: every write to shared table state
// goes through here, never direct from a client. firebase-rules.json
// sets .write:false on /blackjackTables so nothing can bypass this and
// corrupt shared state (or, once actual hand play is built in a later
// pass, see cards it shouldn't).
//
// FIRST PASS ONLY: table creation and seating (sit, buy in, stand,
// cash out). No actual card dealing yet — that's the deliberate next
// step once this is confirmed solid, same order Hold'em itself was
// built in.
//
// Needs the same env vars already set for the other functions in this
// project: FIREBASE_DB_SECRET, FIREBASE_WEB_API_KEY. No new ones.

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

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!DB_SECRET) {
    return new Response(JSON.stringify({ error: "Server not configured" }), { status: 500 });
  }

  try {
    const { idToken, action, tableId, name, minBuyIn, maxBuyIn, seatIndex, buyInAmount, gameType } = await req.json();
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
        if (s && s.uid && s.stack > 0) await adjustXp(s.uid, s.stack, `Table force-closed by admin — ${forceTable.name || "table"} (refund)`);
      }
      await dbPut(path, null);
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }

    if (action === "createTable") {
      const cleanName = (name || "").trim().slice(0, 40) || `${displayName}'s Table`;
      const cleanMin = Math.max(1, Math.floor(Number(minBuyIn) || 100));
      const cleanMax = Math.max(cleanMin, Math.floor(Number(maxBuyIn) || cleanMin * 20));
      const seats = {};
      for (let i = 0; i < MAX_SEATS; i++) seats[i] = null;
      const table = {
        name: cleanName, createdBy: uid, createdByName: displayName, createdAt: Date.now(),
        maxSeats: MAX_SEATS, minBuyIn: cleanMin, maxBuyIn: cleanMax, seats, status: "waiting",
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
      const min = table.minBuyIn || 1, max = table.maxBuyIn || min;
      if (amount < min || amount > max) {
        return new Response(JSON.stringify({ error: `Buy-in must be between ${min} and ${max} XP` }), { status: 400 });
      }
      const balance = await getXpBalance(uid);
      if (amount > balance) {
        return new Response(JSON.stringify({ error: `You only have ${balance} XP` }), { status: 400 });
      }
      await adjustXp(uid, -amount, `Blackjack table buy-in — ${table.name}`);
      const seat = { uid, name: displayName, stack: amount, joinedAt: Date.now() };
      await dbPut(`/blackjackTables/${tableId}/seats/${seatIndex}`, seat);
      return new Response(JSON.stringify({ seat }), { status: 200 });
    }

    if (action === "standUp") {
      const seats = table.seats || {};
      const myIndex = Object.keys(seats).find(i => seats[i] && seats[i].uid === uid);
      if (myIndex == null) {
        return new Response(JSON.stringify({ error: "You're not seated at this table" }), { status: 400 });
      }
      const stack = seats[myIndex].stack || 0;
      if (stack > 0) await adjustXp(uid, stack, `Blackjack table cash out — ${table.name}`);
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
        if (s && s.stack > 0) await adjustXp(s.uid, s.stack, `Blackjack table closed — ${table.name} (refund)`);
      }
      await dbPut(`/blackjackTables/${tableId}`, null);
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

