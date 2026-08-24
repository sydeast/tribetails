import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// MyTribe web portal. PWA notes:
// - Navigations are NETWORK-FIRST (repo gotcha: stale-while-revalidate kept
//   serving old bundles one load behind every release).
// - Functions / Firestore / Auth traffic is never cached; the Kotlin app's
//   service worker had the same rule and breaking it blocks the auth SDK.
// - S5: switched generateSW -> injectManifest (custom src/sw.ts) so the SAME
//   app-shell worker can also handle FCM 'push'/'notificationclick' events.
//   This mirrors the Kotlin/JS reference (PushToken.js.kt), which deliberately
//   reuses the app-shell worker instead of registering a second
//   firebase-messaging-sw.js at the same scope (two workers fighting for
//   control of navigations was the risk that pattern avoids). The runtime
//   caching rules below are now hand-written in src/sw.ts using the same
//   Workbox primitives generateSW used to configure automatically.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // The app bundle plus fonts/JS chunks generateSW used to precache
        // automatically; injectManifest needs the same globs told explicitly.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // The issue recorder's standalone bundle is a static asset the app
        // never loads: it exists so the bookmarklet can pull it from this
        // site's own origin past the CSP. Precaching it would push 190 KB
        // through every kinfolk's service worker to support a tool only the
        // operator ever triggers. Measured: the precache went from 69 entries
        // and 1827 KiB to 70 and 2024 KiB before this line was added.
        //
        // mapbox-*: RouteMap.tsx (#520) loads mapbox-gl through a dynamic
        // import so it stays out of the initial download. Precaching it would
        // hand that back: a service worker fetches its whole manifest on
        // install, so every kinfolk would pull the map library up front for a
        // screen many of them never open. Measured: precache goes from 73
        // entries and 1861 KiB to 75 and 3686 KiB without these two patterns.
        // The chunk is named for the package (mapbox-gl-<hash>.js, plus its
        // stylesheet); it is fetched the first time a visit actually has a
        // route, and the SVG polyline covers the case where that fetch fails.
        globIgnores: ['**/__recorder.js', '**/mapbox-*.js', '**/mapbox-*.css'],
      },
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'MyTribe',
        short_name: 'MyTribe',
        description: 'Tribe Tails Pet Care kinfolk portal. Schedule, KinTales, Kin profiles, invoices.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#FBFBF9',
        theme_color: '#FBFBF9',
        lang: 'en',
        categories: ['lifestyle', 'utilities'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  build: {
    sourcemap: false,
    // vite 8 bundles with rolldown, which drops object-form manualChunks;
    // codeSplitting (né advancedChunks) is its replacement for the same
    // firebase-in-one-chunk split.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'firebase', test: /node_modules\/(@firebase|firebase)\// }],
        },
      },
    },
  },
});
