import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// AuntieOS admin (React). Replaces the Compose/wasm admin at auntieos-ttpc.
//
// No PWA plugin, deliberately: the wasm admin had no service worker either, and
// the operator uses this on a desk machine with a network. MyTribe/web needs one
// because kinfolk read it on phones and it handles FCM push. Do not copy that
// config across without a reason to.
export default defineConfig({
  plugins: [react()],
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
