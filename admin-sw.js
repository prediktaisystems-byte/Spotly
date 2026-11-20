/* Spotly Admin service worker
 * Scope: /Spotly/admin  (registered from admin.html). Separate from the public Spotly app
 * and from OneSignal's worker.
 *
 * SECURITY RULES
 *  - Caches ONLY the static app shell: the admin page HTML, manifest and icons.
 *  - NEVER intercepts the Apps Script backend or any other cross-origin request, so admin
 *    API responses, tokens and dashboard data are never stored by this worker.
 *  - Only GET requests to an explicit same-origin allow-list are handled; everything else
 *    goes straight to the network untouched.
 *  - Contains no credentials. Login is always checked by the backend on launch.
 */
const CACHE = 'spotly-admin-shell-v2';
const BASE  = '/Spotly/';
const SHELL_URL = BASE + 'admin.html';
const STATIC_ASSETS = [
  BASE + 'admin-manifest.webmanifest',
  BASE + 'admin-192.png',
  BASE + 'admin-512.png',
  BASE + 'admin-maskable-512.png',
  BASE + 'admin-apple-touch-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([SHELL_URL].concat(STATIC_ASSETS)))
      .catch(() => {})            // never block install on a missing file
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.indexOf('spotly-admin-') === 0 && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks us to wipe caches on logout (hygiene — nothing private is stored anyway).
self.addEventListener('message', (event) => {
  if (event.data === 'spotly-admin-clear') {
    event.waitUntil(caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.indexOf('spotly-admin-') === 0).map((k) => caches.delete(k)))));
  }
});

function isAdminPage(url) {
  return url.pathname === BASE + 'admin' || url.pathname === SHELL_URL;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                      // POSTs (all admin API writes) untouched
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // Apps Script, CDNs, OneSignal: untouched

  // Admin page: network first (always get the latest deploy), cached shell only if offline.
  if (req.mode === 'navigate' && isAdminPage(url)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL_URL, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(SHELL_URL))
    );
    return;
  }

  // Static icons + manifest: cache first.
  if (STATIC_ASSETS.indexOf(url.pathname) !== -1) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
  }
  // anything else: not handled → normal network behaviour
});
