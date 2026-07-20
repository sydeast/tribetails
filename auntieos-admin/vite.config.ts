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
});
