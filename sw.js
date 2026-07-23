/* ═══════════════════════════════════════════════════════════════
   SW.JS — HAMRO AFNAI  Service Worker
   Strategy:
   • Admin panel      → NEVER intercepted. Always live network, no
                         cache read/write, no manufactured offline
                         response. A stale/offline admin panel is
                         worse than no admin panel.
   • index.html/shell → network-first, cache-bypass (no-store) so a
                         live connection is never shadowed by a stale
                         copy. Falls back to the last cached copy ONLY
                         when the network genuinely fails — that cached
                         index.html still boots normally and its own
                         resumeUserSession() logic decides whether a
                         permanent/trial user can proceed straight in,
                         or whether to show the login screen.
   • API/Drive        → network-first, offline JSON fallback (except
                         admin — see above).
   • Stale clearance  → whenever we're confirmed online again, purge
                         any cached entries that aren't part of the
                         current SHELL, so a reconnect never leaves old
                         orphaned responses sitting in Cache Storage.
═══════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'ha-shell-v9'; // Bumped for the admin-bypass + stale-clearance rework.
const SHELL = [
  './',
  './index.html',
  './user.html',
  './app.js',
  './chapters-data.js',
  './manifest.json'
  // NOTE: admin.html is deliberately NOT in SHELL — it must never be
  // served from cache, so there's no reason to precache it either.
];

/* Is this request/page the admin panel? Checked two ways:
   1. The request itself is for admin.html (navigating to the page).
   2. The request was issued BY a tab that has admin.html open (an API
      call from admin.html's own script) — found via the client that
      dispatched the fetch, since admin's API calls hit the same GAS_URL
      as everything else and can't be told apart by URL alone. */
async function isAdminOrigin(request, clientId) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('admin.html')) return true;
  if (!clientId) return false;
  try {
    const client = await self.clients.get(clientId);
    return !!(client && client.url && client.url.includes('admin.html'));
  } catch (e) {
    return false;
  }
}

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

// Removes any cached entry not in the current SHELL list, keeping Drive
// question-file responses (those live under the same CACHE_NAME but are
// added dynamically, not part of SHELL, and are still wanted offline) —
// only strips genuinely orphaned shell-type entries (e.g. an old
// admin.html left over from before this version, or a removed file).
async function clearStaleShellEntries() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const shellAbs = new Set(SHELL.map(p => new URL(p, self.registration.scope).href));
  await Promise.all(keys.map(req => {
    const url = new URL(req.url);
    const isDrive = url.hostname.includes('drive.google.com') || url.hostname.includes('googleusercontent.com');
    const isApi = url.hostname.includes('script.google.com');
    if (isDrive || isApi) return Promise.resolve(); // leave dynamic/API entries alone
    if (!shellAbs.has(req.url)) {
      return cache.delete(req);
    }
    return Promise.resolve();
  }));
}

// index.html calls this (via postMessage) once checkNet() confirms we've
// come back online, so any stale leftovers get swept immediately on
// reconnect rather than waiting for the next SW version bump.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CLEAR_STALE_IF_ONLINE') {
    e.waitUntil ? e.waitUntil(clearStaleShellEntries()) : clearStaleShellEntries();
  }
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  e.respondWith((async () => {
    const fromAdmin = await isAdminOrigin(e.request, e.clientId);

    /* ── ADMIN: bypass the service worker entirely ──
       No cache read, no cache write, no offline fallback response.
       If the network fails, the browser's normal failure surfaces —
       admin.html's own code (checkAdmin_ / api()/post() error paths)
       is what shows that to the admin, not a fake success:false from
       here pretending things are fine. */
    if (fromAdmin) {
      return fetch(e.request);
    }

    /* ── API calls: network-first, offline JSON fallback ── */
    if (url.hostname.includes('script.google.com')) {
      try {
        const res = await fetch(e.request.clone());
        // A successful round-trip means we're online — sweep any stale
        // shell leftovers opportunistically (cheap, non-blocking).
        clearStaleShellEntries();
        return res;
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: 'Offline — use cached data' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    /* ── Google Drive file fetch (question JSONs) ── */
    if (url.hostname.includes('drive.google.com') || url.hostname.includes('googleusercontent.com')) {
      const cached = await caches.match(e.request);
      try {
        const res = await fetch(e.request.clone());
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      } catch (err) {
        return cached || new Response(
          JSON.stringify({ success: false, error: 'File not cached' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    /* ── App shell (index.html/user.html/app.js/etc): network-first ──
       `cache: 'no-store'` bypasses the browser's own HTTP cache too, not
       just Cache Storage — so "online" really means online, every time,
       with zero chance of a stale copy shadowing a live connection.
       Falls back to the last cached copy only when the fetch itself
       fails, i.e. genuinely offline. That cached index.html still runs
       its normal boot logic (resumeUserSession) which resolves a
       permanent/trial user straight into the app, or shows login. */
    try {
      const res = await fetch(e.request.clone(), { cache: 'no-store' });
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return res;
    } catch (err) {
      const cached = await caches.match(e.request);
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
