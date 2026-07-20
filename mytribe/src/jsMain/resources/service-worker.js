// MyTribe — minimal service worker.
// Cache strategy: stale-while-revalidate for app shell, network-first for Functions calls.
// Also the FCM web push worker: the page passes THIS registration to
// getToken({serviceWorkerRegistration}) (PushToken.js.kt), so the SDK never
// fetches the default /firebase-messaging-sw.js. We handle the raw 'push'
// event ourselves instead of importing the firebase bundle into the worker.

const CACHE_NAME = 'mytribe-v4';
const APP_SHELL = [
  '/',
  '/index.html',
  '/kinfolk-portal.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => null)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache Functions / Firestore traffic — must be live.
  if (
    url.hostname.endsWith('cloudfunctions.net') ||
    url.hostname.endsWith('googleapis.com') ||
    url.hostname.endsWith('firebaseio.com')
  ) {
    return; // default network handler
  }

  if (request.method !== 'GET') return;

  // Only intercept same-origin requests. Handing cross-origin fetches
  // (gstatic, recaptcha, cloudinary) through respondWith risks resolving
  // undefined -> 'Failed to convert value to Response' -> blocked auth SDK.
  if (url.origin !== self.location.origin) return;

  // App shell (navigations, JS, wasm, manifest) is NETWORK-FIRST so a deploy
  // is live on the next load — stale-while-revalidate kept serving old bundles
  // one load behind every release. Static media stays cache-first.
  const isShell =
    request.mode === 'navigate' ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.mjs') ||
    url.pathname.endsWith('.wasm') ||
    url.pathname.endsWith('.webmanifest');

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => null);
          }
          return response;
        })
        .catch(() =>
          cached || new Response('offline', { status: 503, statusText: 'offline' }),
        );
      return isShell ? networkFetch : (cached || networkFetch);
    }),
  );
});
// --- Web push (FCM) ---
// FCM webpush payloads arrive as JSON: { notification: {title, body},
// data: {notificationKey, route, ...}, fcmMessageId, from }.
// `tag` = fcmMessageId so the page-side foreground onMessage handler (which
// uses the same tag) replaces rather than duplicates this notification.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    return; // not an FCM JSON push; ignore
  }
  const n = payload.notification || {};
  const data = payload.data || {};
  const title = n.title || data.title || 'MyTribe';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: n.body || data.body || '',
      icon: '/icon-192.png',
      tag: payload.fcmMessageId || data.notificationKey || undefined,
      data: { route: data.route || null },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = event.notification.data && event.notification.data.route;
  const target = route
    ? new URL(route, self.location.origin).href
    : self.location.origin + '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            if (client.navigate) client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
