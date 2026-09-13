import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// AuntieOS admin (React). Replaces the Compose/wasm admin at auntieos-ttpc.
//
// THIS FILE USED TO SAY THE ADMIN NEEDED NO SERVICE WORKER, on the grounds
// that "the operator uses this on a desk machine with a network". That is no
// longer true, and the sentence is gone rather than edited, because it was the
// reason a whole capability was missing. Operator ruling 2026-09-12: web and
// Android stay at parity, and MOBILE WEB IS THE FIELD FALLBACK, what the
// operator opens on a driveway when the Android app will not load on the job.
// A fallback that needs a good signal to reach its own login screen is not a
// fallback, so the admin is now installable and opens with no signal, the same
// way MyTribe/web does.
//
// The PWA block below mirrors mytribe/web/vite.config.ts deliberately. The two
// are separate workspaces, but the rules are the same rules, and a difference
// between them should be a decision somebody made rather than a drift nobody
// noticed. src/sw.ts is the worker; src/lib/swPolicy.ts holds the routing
// decisions and the reasoning behind the navigation timeout.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // injectManifest, not generateSW, for the same reason the portal made the
      // switch: the worker is then a file in this repo that can be read,
      // commented and typechecked, rather than a block of plugin options that
      // generates one. The runtime caching rules live in src/sw.ts.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Precaching is not free: a service worker fetches its WHOLE manifest
        // on install, so anything listed here is downloaded on first load
        // whether the operator opens that screen or not.
        //
        // __recorder.js: the issue recorder's standalone bundle is a static
        // asset the app never imports. It exists so the bookmarklet can pull it
        // from this origin past the CSP (see src/main.tsx). 190 KB for a tool
        // only the operator triggers by hand.
        //
        // mapbox-*: RouteMap.tsx loads mapbox-gl through a dynamic import so it
        // stays out of the initial download. Precaching it would hand that back
        // and push the whole map library at every load, for a screen most
        // sessions never open. The map fetches on first use instead.
        //
        // Measured on this build: 159 entries and 4724 KiB without these three
        // patterns, 156 entries and 2713 KiB with them. What remains IS every
        // screen's chunk, and that is the point rather than an oversight: the
        // fallback is only a fallback if the screen the operator needs on a
        // driveway is already on the phone.
        globIgnores: ['**/__recorder.js', '**/mapbox-*.js', '**/mapbox-*.css'],
      },
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'AuntieOS Admin',
        short_name: 'AuntieOS',
        description: 'Tribe Tails Pet Care operations. Bookings, sessions, invoices, KinTales.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Both navy, matching index.html's meta theme-color and the one scheme
        // the admin paints (the 2026-09-11 glass-world ruling). A launch screen
        // in any other colour would flash a palette the app never shows.
        background_color: '#11131F',
        theme_color: '#11131F',
        lang: 'en',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  server: { port: 5174 }, // 5173 is MyTribe/web; both run side by side during the port
  build: {
    // Firebase in a chunk of its own, copied from `mytribe/web/vite.config.ts`
    // for the same reason it exists there. The SDK is 580 KB of the bundle and
    // it changes only when the dependency is bumped, so pinning it to one file
    // keeps it cached across every app deploy instead of being re-downloaded
    // with each release because one screen's markup moved.
    //
    // `codeSplitting`, not the object form of `manualChunks`: vite 8 bundles
    // with rolldown, which dropped that form. Same split, different option name.
    //
    // Named `firebase-sdk` where the portal says `firebase`, and only because
    // `src/lib/firebase.ts` is a shared chunk of its own in this app. Two files
    // called `firebase-<hash>.js` in one asset directory (a 580 KB vendor
    // blob and this app's 9 KB init module) is a build log and a network
    // waterfall nobody can read.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'firebase-sdk', test: /node_modules\/(@firebase|firebase)\// }],
        },
      },
    },
  },
});
