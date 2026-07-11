/* ═══════════════════════════════════════════════════════════════
   SW.JS — HAMRO AFNAI  Service Worker  
   Strategy:
   • App shell  → stale-while-revalidate (cache-first, update in bg)
   • API/Drive  → network-first, offline JSON fallback
═══════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'ha-shell-v7'; // Bumped version
const SHELL = [
  './',
  './index.html',        // ← ADD: login gateway
  './user.html',        // ← ADD: your main app page
  './admin.html',       // ← ADD: admin page
  './app.js',
  './chapters-data.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(SHELL))
      .catch(err => console.warn('SW install: some shell files could not be cached', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  /* ── API calls: network-first ── */
  if (url.hostname.includes('script.google.com')) {
    e.respondWith(
      fetch(e.request.clone())
        .catch(() => new Response(
          JSON.stringify({success: false, error: 'Offline — use cached data'}),
          {status: 200, headers: {'Content-Type': 'application/json'}}
        ))
    );
    return;
  }

  /* ── Google Drive file fetch (your question JSONs) ── */
  if (url.hostname.includes('drive.google.com') || url.hostname.includes('googleusercontent.com')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        return fetch(e.request.clone())
          .then(res => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
            }
            return res;
          })
          .catch(() => cached || new Response(
            JSON.stringify({success: false, error: 'File not cached'}),
            {status: 200, headers: {'Content-Type': 'application/json'}}
          ));
      })
    );
    return;
  }

  /* ── App shell: stale-while-revalidate (FIXED) ── */
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request.clone())
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => {
          // Network failed — return cached if we have it
          return cached || new Response('Offline', {status: 503});
        });

      // Return cached immediately (stale-while-revalidate), 
      // or wait for network if nothing in cache
      return cached || fetchPromise;
    })
  );
});
