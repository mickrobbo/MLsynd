// sw.js
// Two things were causing "have to clear cache to see updates":
// 1. A new service worker version installs but sits WAITING until every
//    open tab of the site is fully closed — on a phone that basically
//    never happens (people switch apps, they don't close tabs).
// 2. If the app shell (index.html/JS) was being served cache-first, a new
//    deploy just wouldn't show up at all until the cache was manually
//    cleared, deploy or no deploy.
//
// Fixed by: skipWaiting()+clients.claim() so a new version takes over
// immediately instead of waiting, and network-first for navigation/JS so
// the browser always tries to get the latest deploy first, only falling
// back to a cached copy if there's no connection at all. Static assets
// (icons, banner, logos) stay cache-first since they rarely change and
// benefit from being fast/offline-available.

const CACHE_VERSION = "mlsynd-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const STATIC_ASSET_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?)(\?.*)?$/i;

self.addEventListener("install", (event) => {
  self.skipWaiting(); // don't wait for old tabs to close — activate straight away
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // clean up any caches from older versions of this service worker
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("mlsynd-") && !name.startsWith(CACHE_VERSION))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim(); // take control of already-open tabs immediately
    })()
  );
});

// ---- Push notifications ----
// The push payload is a plain JSON object: { title, body, url }. "url" is
// where tapping the notification should take you (defaults to the app root
// if not given). Actual sending happens server-side (a Netlify function
// using the web-push library, VAPID-signed) — this is just the receiving
// end that turns a push event into a visible notification.
self.addEventListener("push", (event) => {
  let data = { title: "MLSynd", body: "You've got a notification.", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // not JSON — fall back to plain text as the body
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an already-open tab if there is one, rather than opening a
      // second copy of the app.
      for (const client of allClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.focus();
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin (Firebase, ESPN, etc.)

  // API calls (racing, tipping, news, odds, scores...) are dynamic data, not
  // app shell — let them go straight to the network with no caching at all.
  // Most of these carry changing query params (round numbers, dates,
  // cache-busting timestamps), so caching them would just accumulate an
  // ever-growing pile of entries that are never reused or cleaned up.
  if (url.pathname.startsWith("/.netlify/functions/")) return;

  // Static assets: cache-first (fast, rarely change), but still refresh
  // the cache in the background so they don't go stale forever.
  if (STATIC_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(req);
        const networkFetch = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await networkFetch) || new Response("", { status: 504 });
      })()
    );
    return;
  }

  // Everything else (HTML, JS, CSS, the app shell) — always try the
  // network first so a new deploy shows up immediately. Only fall back
  // to whatever's cached if there's genuinely no connection.
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(STATIC_CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(req);
        return cached || new Response("Offline", { status: 503 });
      }
    })()
  );
});
