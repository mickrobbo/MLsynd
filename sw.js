const CACHE_NAME = 'mlsynd-dashboard-v3';
const SHELL_FILES = [
  './',
  './dashboard-manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never touch cross-origin calls (the live Firebase data) — always go to the network.
  if (url.origin !== self.location.origin) return;

  // Never touch our own serverless functions either (scores, racing data, etc.) —
  // these are dynamic API calls, not app-shell assets, and must always hit the
  // network fresh. Letting the browser handle these directly (not intercepting at
  // all) rules out any caching weirdness for these endpoints.
  if (url.pathname.startsWith('/.netlify/functions/')) return;

  // Same-origin app shell files only: cache-first, falling back to network.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
