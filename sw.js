/* ══════════════════════════════════════════════════════════════════
   Spotly Service Worker
   Strategy:
   - Precache the app shell (index.html, manifest, offline page, icons).
   - Navigation requests: network-first, falling back to cached shell,
     falling back to offline.html if nothing is cached yet.
   - Same-origin static assets: cache-first.
   - Third-party static libraries (Leaflet, Tabler icons, fonts, CDN JS/CSS):
     stale-while-revalidate so they still work offline.
   - Backend API (Google Apps Script) and payment/notification/auth/admin
     endpoints are NEVER cached and NEVER intercepted — they always hit the
     network directly, so auth, payments, notifications and live data are
     completely unaffected by this service worker.
   ══════════════════════════════════════════════════════════════════ */

const SW_VERSION      = 'v1';
const SHELL_CACHE      = `spotly-shell-${SW_VERSION}`;
const RUNTIME_CACHE    = `spotly-runtime-${SW_VERSION}`;
const API_READ_CACHE   = `spotly-api-read-${SW_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './offline.html',
  './icons/icon-72x72.png',
  './icons/icon-96x96.png',
  './icons/icon-128x128.png',
  './icons/icon-144x144.png',
  './icons/icon-152x152.png',
  './icons/icon-192x192.png',
  './icons/icon-384x384.png',
  './icons/icon-512x512.png',
  './icons/icon-maskable-192x192.png',
  './icons/icon-maskable-512x512.png',
  './icons/apple-touch-icon.png',
];

// Backend API host — never cache or intercept sensitive calls made here.
const API_HOST = 'script.google.com';

// GET actions against the backend that are safe & non-sensitive to cache
// for offline browsing (public directory / discovery data only).
const CACHEABLE_API_ACTIONS = [
  'getprovider', 'getfeatured', 'getcategories', 'getlocations',
  'search', 'getforyoufeed', 'getpopular', 'getarea', 'gettown', 'getlga',
];

// Never cache these even if they'd otherwise match — safety net for
// anything auth/payment/notification/admin/verification related.
const NEVER_CACHE_KEYWORDS = [
  'login', 'signup', 'register', 'auth', 'password', 'otp', 'token',
  'payment', 'flutterwave', 'verify', 'withdraw', 'notif', 'admin',
  'session', 'upload', 'delete', 'update', 'create', 'submit', 'save',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {}) // don't fail install if a CDN asset list changes
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => ![SHELL_CACHE, RUNTIME_CACHE, API_READ_CACHE].includes(n))
          .map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

// Allow the page to trigger immediate activation of a waiting worker
// (used by the "Update Now" button in index.html).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isApiReadRequest(url) {
  if (url.hostname !== API_HOST) return false;
  const action = (url.searchParams.get('action') || '').toLowerCase();
  if (!action) return false;
  if (NEVER_CACHE_KEYWORDS.some((k) => action.includes(k))) return false;
  return CACHEABLE_API_ACTIONS.some((a) => action.includes(a));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only ever act on GET requests — POST/PUT/DELETE (payments, writes,
  // logins, notifications, admin actions) always pass straight through
  // to the network untouched.
  if (req.method !== 'GET') return;

  // Never touch the backend except for the small, explicit read-only
  // whitelist above — everything else on script.google.com goes straight
  // to the network with no interception at all.
  if (url.hostname === API_HOST) {
    if (!isApiReadRequest(url)) return;
    event.respondWith(staleWhileRevalidate(req, API_READ_CACHE));
    return;
  }

  // App navigation (loading/refreshing the SPA itself).
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
    return;
  }

  // Same-origin static assets (icons, manifest, offline page).
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // Third-party static libraries (Leaflet, Tabler icon font/css, etc).
  if (isStaticLibrary(url)) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // Anything else (OneSignal, analytics, unknown cross-origin) — leave alone.
});

function isStaticLibrary(url) {
  return (
    /unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(
      url.hostname
    )
  );
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    })
    .catch(() => null);
  return cached || (await networkPromise) || Response.error();
}

async function networkFirstShell(req) {
  const shellCache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) shellCache.put('./index.html', fresh.clone());
    return fresh;
  } catch (err) {
    const cachedShell = await shellCache.match('./index.html');
    if (cachedShell) return cachedShell;
    const offline = await shellCache.match('./offline.html');
    return offline || Response.error();
  }
}
