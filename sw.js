// Offline support: once loaded, the app keeps working with wifi off.
// Strategy: serve from cache immediately, refresh the cache in the background
// (so a new deploy is picked up on the next reload). Bump VERSION to force it.
const VERSION = 'v1';
const CACHE = `darts-dashboard-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './admin.html',
  './css/base.css',
  './css/tv.css',
  './css/admin.css',
  './js/tv.js',
  './js/admin.js',
  './js/store.js',
  './js/view.js',
  './js/logic/bracket.js',
  './js/logic/config.js',
  './js/logic/fixtures.js',
  './js/logic/simulate.js',
  './js/logic/standings.js',
  './js/logic/tournament.js',
  './js/logic/util.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('darts-dashboard-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
