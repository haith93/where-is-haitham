/* =====================================================================
   Service worker: offline shell + Web Push delivery.

   Caching rules
   -------------
   * HTML pages      network first, cached copy as the fallback, then
                     offline.html. A stale page is better than nothing,
                     but fresh is always preferred.
   * CSS / JS / icons stale-while-revalidate: instant load, quiet update.
   * Supabase calls   NEVER cached. Application data must be live, and
                     responses carry the user's access token.
   ===================================================================== */

const VERSION = 'wih-v3.7.0';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL = [
  './',
  './index.html',
  './admin.html',
  './staff.html',
  './offline.html',
  './manifest.json',
  './css/tokens.css',
  './css/main.css',
  './css/dashboard.css',
  './css/admin.css',
  './css/responsive.css',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/badge.png'
];

/* ---------------------------------------------------------------- */
/* Install / activate                                                */
/* ---------------------------------------------------------------- */

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails the whole install if one file 404s, so add individually.
    await Promise.all(SHELL.map(url => cache.add(url).catch(err => console.warn('[sw] skip', url, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/* ---------------------------------------------------------------- */
/* Fetch                                                             */
/* ---------------------------------------------------------------- */

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Application data is always live. Never serve it from a cache.
  if (url.hostname.endsWith('.supabase.co') || url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Our own code: network first.
  //
  // This used to be stale-while-revalidate, and that combination was a
  // trap. Navigations are network-first, so after a deploy the browser
  // got the NEW index.html - and then stale-while-revalidate handed it
  // the OLD dashboard.js from the cache, because that is exactly what
  // "stale" means. New markup driven by old script, which fails the
  // moment the two disagree about an element: "Cannot read properties
  // of null (reading 'addEventListener')".
  //
  // The script and the page it runs must come from the same deploy. A
  // round trip for a handful of small files is a price worth paying for
  // that, and the cache is still there when the network is not.
  if (url.origin === self.location.origin
      && /\.(?:js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirstAsset(request));
    return;
  }

  // Everything else that may be cached: our own icons and manifest, the
  // Supabase client, the web fonts. These are not coupled to the markup -
  // an icon from yesterday renders perfectly beside today's script - and
  // caching the fonts keeps the app's type intact when the network is
  // gone instead of dropping to a system face.
  const CACHEABLE_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
  if (url.origin === self.location.origin || CACHEABLE_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/**
 * Fresh if the network answers, cached if it does not.
 *
 * Unlike networkFirst() above there is no index.html fallback: a missing
 * script has no sensible substitute, and serving HTML in its place would
 * turn a network error into a syntax error.
 */
async function networkFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  let response = null;

  try {
    response = await fetch(request);
  } catch {
    response = null;                       // offline, DNS, dropped connection
  }

  if (response && response.ok) {
    cache.put(request, response.clone());
    return response;
  }

  // A 500 from the host, or a captive portal returning its own page, is
  // not a reason to throw away a copy that worked yesterday. Fall back to
  // the cache for anything that is not a healthy response - but only if
  // there IS one, so a genuine 404 still reports itself as a 404.
  const cached = await cache.match(request);
  if (cached) return cached;

  return response ?? new Response('', { status: 504 });
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request))
        ?? (await cache.match('./index.html'))
        ?? (await cache.match('./offline.html'))
        ?? new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request).then(response => {
    if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached ?? (await network) ?? new Response('', { status: 504 });
}

/* ---------------------------------------------------------------- */
/* Push                                                              */
/* ---------------------------------------------------------------- */

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Where Is Haitham Now?', body: event.data?.text() ?? '' };
  }

  const title = payload.title || 'New request';
  const options = {
    body: payload.body || '',
    icon: payload.icon || './assets/icons/icon-192.png',
    badge: './assets/icons/badge.png',
    tag: payload.tag || 'wih-request',
    renotify: true,
    requireInteraction: payload.priority === 'very_urgent',
    vibrate: payload.priority === 'normal' ? [90] : [90, 60, 90],
    data: { url: payload.url || './admin.html#/requests' },
    actions: payload.actions || [{ action: 'open', title: 'View request' }]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* The browser can replace a push subscription at any time. Re-subscribe
   immediately so the endpoint stays valid, and tell any open tab so it can
   store the new one. If no tab is open, the app re-saves it on next start
   via refreshPushSubscription(). */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const key = event.oldSubscription?.options?.applicationServerKey;
      if (!key) return;
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key
      });
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clientList.forEach(client =>
        client.postMessage({ type: 'push-subscription-changed', subscription: fresh.toJSON() }));
    } catch (err) {
      console.warn('[sw] resubscribe failed', err);
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './index.html', self.location.href).href;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (client.url.startsWith(self.location.origin)) {
        await client.focus();
        client.postMessage({ type: 'navigate', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
