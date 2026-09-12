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

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, NetworkOnly } from 'workbox-strategies';
import {
  NAVIGATION_CACHE_NAME,
  NAVIGATION_NETWORK_TIMEOUT_SECONDS,
  isNavigationRequest,
  isNeverCachedHost,
} from './lib/swPolicy';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// ── Precaching + routing (ported from the old vite.config.ts `workbox` block) ──

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navigations: network-first, falling back to the cached shell once the
// network has had its short turn. Both the strategy (still network-first, not
// stale-while-revalidate) and the length of that turn (two seconds, down from
// five) are decisions with measurements behind them, and lib/swPolicy.ts is
// where that reasoning is written down.
registerRoute(
  ({ request }) => isNavigationRequest(request),
  new NetworkFirst({
    cacheName: NAVIGATION_CACHE_NAME,
    networkTimeoutSeconds: NAVIGATION_NETWORK_TIMEOUT_SECONDS,
  }),
);

// Functions / Firestore / Auth traffic: never cached, must be live — breaking
// this rule blocks the auth SDK (same rule the Kotlin app's worker had).
registerRoute(({ url }) => isNeverCachedHost(url), new NetworkOnly());

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
