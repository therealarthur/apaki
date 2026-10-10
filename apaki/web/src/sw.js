/**
 * sw.js: the Apaki phone client's service worker (Track B part 2,
 * 2026-10-09). build-web.mjs writes the version (a hash of every built file)
 * and the asset list in below.
 *
 * Every asset of one build is cached together under apaki-web-<version>, so
 * a phone never mixes files of two builds. The page itself is fetched from
 * the network first (a new build is picked up on the next visit) and comes
 * from the cache when offline. Other caches are removed when a new build
 * takes over. Nothing from the relay goes through here: WebSockets bypass
 * service workers.
 */

const VERSION = '__VERSION__';
const ASSETS = __ASSETS__;
const CACHE = `apaki-web-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('apaki-web-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.open(CACHE).then((c) => c.match('./index.html'))));
    return;
  }
  e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req))));
});
