// Offline support: once loaded, the app keeps working with wifi off.
//
// Strategy: NETWORK FIRST for pages, scripts and styles — when online you
// always get the latest deploy (revalidated with the server, so the browser's
// HTTP cache can't hand back an old file); when offline or the network is
// slow, the cached copy is used. Images are cache-first (they rarely change).
//
// VERSION must equal APP_VERSION in js/version.js (a test checks this).
// Bump both on every release that changes behaviour.
const VERSION = 'v11';
const CACHE = `darts-dashboard-${VERSION}`;
const NETWORK_TIMEOUT_MS = 3500;
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
  './js/version.js',
  './js/logic/blocks.js',
  './js/logic/bracket.js',
  './js/logic/config.js',
  './js/logic/fixtures.js',
  './js/logic/simulate.js',
  './js/logic/standings.js',
  './js/logic/tournament.js',
  './js/logic/util.js',
  './img/logo.png',
  './img/icon-192.png',
];

// Cache key ignores ?view=… etc. so index.html?view=table works offline too.
const keyFor = (url) => {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' bypasses the HTTP cache so a new version never caches old files.
    await Promise.all(ASSETS.map(async (path) => {
      const url = new URL(path, self.registration.scope).href;
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await cache.put(keyFor(url), res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('darts-dashboard-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const key = keyFor(request.url);
  try {
    const res = await Promise.race([
      fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const key = keyFor(request.url);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(key, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isImage = req.destination === 'image' || /\.(png|jpe?g|svg|webp|ico)$/i.test(new URL(req.url).pathname);
  event.respondWith(isImage ? cacheFirst(req) : networkFirst(req));
});
