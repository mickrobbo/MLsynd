// netlify/functions/send-push.js
// Sends one push notification to one subscription. Called either directly
// (e.g. from the Ledger, "notify everyone") or from the scheduled lockout
// checker. Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT
// (a mailto: address, required by the Web Push spec) set as Netlify
// environment variables — never commit the private key to the repo.

import webpush from "web-push";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:mlsynd00@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function (request) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { subscription, title, body, url } = await request.json();

    if (!subscription || !subscription.endpoint) {
      return new Response(JSON.stringify({ error: "Missing subscription" }), {
        status: 400,
      });
    }

    const payload = JSON.stringify({
      title: title || "MLSynd",
      body: body || "You've got a notification.",
      url: url || "/",
    });

    await webpush.sendNotification(subscription, payload);

    return new Response(JSON.stringify({ sent: true }), {
      status: 200,
    });
  } catch (err) {
    // A 410/404 from the push service means that subscription is dead
    // (browser data cleared, uninstalled, etc.) — worth telling the caller
    // so it can clean up the stored subscription, not just a generic fail.
    const expired = err.statusCode === 410 || err.statusCode === 404;

    return new Response(
      JSON.stringify({ error: err.message, expired }),
      { status: expired ? 410 : 500 }
    );
  }
}
