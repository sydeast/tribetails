/// <reference lib="webworker" />

/**
 * App-shell service worker for the AuntieOS admin.
 *
 * WHY THE ADMIN HAS ONE AT ALL (operator ruling 2026-09-12). This used to be a
 * desk app on a desk network, and vite.config.ts said so. It is not any more:
 * web and Android stay at parity, and MOBILE WEB IS THE FIELD FALLBACK, the
 * thing the operator opens on a driveway when the Android app will not load.
 * A field fallback that needs a good signal to reach its own login screen is
 * not a fallback. This worker is what lets the admin open with no signal at
 * all, and the manifest beside it is what lets it be installed so the operator
 * reaches it without typing a URL.
 *
 * MIRRORS mytribe/web/src/sw.ts, minus push. The portal's worker also handles
 * raw FCM 'push' and 'notificationclick' events; the admin has no web push, so
 * this file stops at caching. If push is ever added here, add it to THIS
 * worker rather than registering a second firebase-messaging-sw.js at the same
 * scope, for the reason the portal's vite.config.ts records.
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

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navigations: network-first, falling back to the cached shell once the network
// has had its short turn. Both the strategy and the length of that turn are
// decisions with reasoning behind them; lib/swPolicy.ts carries it.
registerRoute(
  ({ request }) => isNavigationRequest(request),
  new NetworkFirst({
    cacheName: NAVIGATION_CACHE_NAME,
    networkTimeoutSeconds: NAVIGATION_NETWORK_TIMEOUT_SECONDS,
  }),
);

// Functions / Firestore / Auth traffic: never cached, must be live. Breaking
// this rule blocks the auth SDK, and in an admin it would also mean showing a
// cached booking or invoice as though it were current, which is exactly the
// silent degradation this repo refuses.
registerRoute(({ url }) => isNeverCachedHost(url, self.location.origin), new NetworkOnly());

// registerType: 'autoUpdate' expects the worker to activate itself immediately
// rather than wait for all tabs to close (injectManifest doesn't do this for
// free the way generateSW does).
self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
