/// <reference lib="webworker" />

/**
 * App-shell service worker. Handles two unrelated jobs in one worker
 * (S5 web-push decision, see vite.config.ts's comment): asset/navigation
 * caching (ported verbatim from the old generateSW `workbox` config) and raw
 * FCM 'push'/'notificationclick' events. Deliberately does NOT import the
 * Firebase SDK (no `onBackgroundMessage`) — the FCM webpush payload is plain
 * JSON on `PushEvent.data`, so parsing it by hand keeps the firebase bundle
 * out of the worker, matching the reasoning in the Kotlin/JS reference
 * (src/jsMain/kotlin/com/kinfolk/portal/push/PushToken.js.kt).
 */

import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst, NetworkOnly } from 'workbox-strategies';
import {
  NAVIGATION_CACHE_NAME,
  NAVIGATION_FALLBACK_DENYLIST,
  NAVIGATION_FALLBACK_URL,
  NAVIGATION_NETWORK_TIMEOUT_SECONDS,
  isNeverCachedHost,
  navigationHandler,
} from './lib/swPolicy';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// ── Precaching + routing (ported from the old vite.config.ts `workbox` block) ──

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navigations: network-first, falling back to the cached shell once the
// network has had its short turn.
//
// TWO SECONDS, DOWN FROM FIVE (operator ruling 2026-09-12). Mobile web is the
// FIELD FALLBACK, and for iOS households the only client there is, so the case
// that matters is a weak-but-alive signal. Five seconds of that was five
// seconds of blank screen before the shell this worker already had.
//
// STILL NetworkFirst, NOT StaleWhileRevalidate, which would paint instantly.
// SWR is the repo gotcha recorded in vite.config.ts: it kept serving old
// bundles one load behind every release. `registerType: 'autoUpdate'` does not
// rescue that. The new worker does take control as soon as it installs, but an
// SWR navigation is answered FROM THE CACHE before its revalidation lands, so
// the first visit after a deploy still paints the previous shell and only the
// second one is current. The trade accepted here is the other way round: an
// ordinary load waits up to two seconds and gets fresh HTML, and only a
// genuinely stalled network sees the cache. lib/swPolicy.ts has the long form,
// including why the deadline is not one second or zero.
//
// AND WHEN THE NETWORK LOSES, THE PRECACHED SHELL ANSWERS, whatever route was
// asked for. NetworkFirst on its own can only fall back to a page it has
// already seen, keyed by that exact URL, so a household opening a link to one
// visit with no signal got nothing: the one journey this whole ruling is about.
// Every route in this app resolves to the same shell, and firebase.json
// rewrites `**` to /index.html, so answering any navigation with the precached
// index.html is what the server does online, not a compromise. swPolicy.ts
// carries the denylist and why a 404 never reaches this path.

// FIRST, so it wins by registration order: nothing below may cache these.
registerRoute(({ url }) => isNeverCachedHost(url), new NetworkOnly());

const networkFirstPage = new NetworkFirst({
  cacheName: NAVIGATION_CACHE_NAME,
  networkTimeoutSeconds: NAVIGATION_NETWORK_TIMEOUT_SECONDS,
});
const precachedShell = createHandlerBoundToURL(NAVIGATION_FALLBACK_URL);

registerRoute(
  new NavigationRoute(
    navigationHandler({
      fromNetwork: (options) => networkFirstPage.handle(options),
      fromPrecachedShell: (options) => precachedShell(options),
    }),
    { denylist: NAVIGATION_FALLBACK_DENYLIST },
  ),
);

// registerType: 'autoUpdate' expects the worker to activate itself immediately
// rather than wait for all tabs to close (injectManifest doesn't do this for
// free the way generateSW does).
self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── FCM push ──────────────────────────────────────────────────────────────

interface FcmWebpushPayload {
  notification?: { title?: string; body?: string };
  data?: { notificationKey?: string; route?: string };
  fcmMessageId?: string;
}

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;
  let payload: FcmWebpushPayload;
  try {
    payload = event.data.json() as FcmWebpushPayload;
  } catch {
    return;
  }

  const title = payload.notification?.title ?? payload.data?.notificationKey ?? 'MyTribe';
  const body = payload.notification?.body ?? '';
  // Same tag convention as the foreground handler (src/lib/push.ts) — if both
  // paths ever fire for one message, the second showNotification replaces the
  // first instead of duplicating it.
  const tag = payload.fcmMessageId ?? payload.data?.notificationKey;

  const options: NotificationOptions & { data?: { route?: string } } = {
    body,
    icon: '/icon-192.png',
    ...(tag ? { tag } : {}),
    data: { route: payload.data?.route },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification focuses an already-open MyTribe tab if one exists
// (navigating it to the deep-linked route), otherwise opens a new one.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const route =
    (event.notification.data as { route?: string } | undefined)?.route ?? '/home';
  const requested = new URL(route, self.location.origin);
  // `route` comes from the push payload's `data.route` (backend-authored via
  // pushTemplates/{key}.dataRoute, not attacker-settable per-recipient) — but
  // cheap to refuse an off-origin target outright rather than trust it blindly.
  const targetUrl = requested.origin === self.location.origin ? requested.href : self.location.origin + '/home';

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientsList.find((c) => 'focus' in c) as WindowClient | undefined;
      if (existing) {
        await existing.focus();
        if ('navigate' in existing) await existing.navigate(targetUrl);
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
