/* ToolTrace service worker.
 * - Static build assets and icons: cache first (they are content-hashed).
 * - Pages: network first, falling back to an offline page that can queue
 *   check-outs (see src/lib/outbox.ts) until the connection is back.
 * - /api: never cached. Tool and session data must always be live.
 */
const VERSION = 'tooltrace-v2';
const OFFLINE_URL = '/offline';

// The offline page must work with no network at all, so its own scripts and
// styles (content-hashed /_next/static files) are cached along with it.
async function precacheOfflinePage() {
  const cache = await caches.open(VERSION);
  const res = await fetch(OFFLINE_URL, { cache: 'reload' });
  if (!res.ok) throw new Error('offline page unavailable');
  const html = await res.clone().text();
  await cache.put(OFFLINE_URL, res);
  const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]);
  await cache.addAll([...new Set(['/icons/icon.svg', ...assets])]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheOfflinePage().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
  }
});
