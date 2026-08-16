import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Self-hosted brand fonts (Den redesign), no font CDN at runtime.
//
// `/full.css`, not the package default. The default entry ships the wght axis
// alone; Fraunces also carries SOFT and WONK, and those two are what the Den
// mocks set ("SOFT" 50, "WONK" 1) to get the friendly editorial serif the brand
// picked, rather than a generic one. Costs 121 KB for the latin subset against
// 36 KB for wght alone, woff2, cached, `font-display: swap`. If that trade ever
// stops being worth it, dropping back to '@fontsource-variable/fraunces' is the
// only change needed: the variation tokens degrade to no-ops.
import '@fontsource-variable/fraunces/full.css';
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/spline-sans-mono/400.css';

import './styles/tokens.css';
import './styles/base.css';
import './styles/signin.css';
import './styles/shell.css';
import './styles/screens.css';

import './lib/firebase'; // initialize Firebase before anything touches auth
import { initSentry } from './lib/sentry';
import { router } from './router';
import { ToastProvider } from './components/Toast';

// Start crash reporting before the app renders, so an error during first paint
// is still captured. No-op (with a visible console line) when no VITE_SENTRY_DSN.
initSentry();

/**
 * The issue recorder, for walking the app and marking what is wrong.
 *
 * OFF UNLESS ASKED FOR, and asked for by a variable nothing in the deploy path
 * sets. `VITE_ISSUE_RECORDER` is written in one place, the `dev:record` script
 * in this package's `package.json`, so a hosting build substitutes `undefined`
 * for the whole `import.meta.env` access at build time, the condition folds to
 * a constant false, and rolldown drops the branch together with the dynamic
 * import and all of rrweb. Same mechanism as the emulator gate in
 * `lib/firebase.ts`, and verified the same way with a grep over `dist/assets`.
 *
 * A DYNAMIC import, not a static one. A static import would put rrweb in the
 * module graph of every build and rely on tree-shaking to remove it, which is a
 * weaker guarantee than the branch never being reachable.
 *
 * The live site gets the same recorder from the bookmarklet instead
 * (`packages/issue-recorder/README.md`), which loads `/__recorder.js` from the
 * site's own origin so the page's CSP does not refuse it.
 */
if (import.meta.env.VITE_ISSUE_RECORDER === '1') {
  void import('@tribetails/issue-recorder').then(({ startRecorder }) => {
    startRecorder({ app: 'admin' });
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

/**
 * Fail-loud fallback for an uncaught render error: never a white screen. Inline
 * styles on purpose, so it renders even if the app's CSS is what failed to load.
 */
function CrashFallback() {
  return (
    <main
      role="alert"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        padding: '2rem',
        textAlign: 'center',
        fontFamily: 'system-ui, sans-serif',
        color: '#11131F',
        background: '#FBFBF9',
      }}
    >
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Something broke on this screen.</h1>
      <p style={{ maxWidth: '32rem', margin: 0, opacity: 0.8 }}>
        The error was reported. Reloading usually clears it; nothing you saved is lost.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginTop: '0.5rem',
          padding: '0.6rem 1.1rem',
          borderRadius: '999px',
          border: 'none',
          background: '#11131F',
          color: '#FBFBF9',
          cursor: 'pointer',
        }}
      >
        Reload
      </button>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Above the router on purpose: a save confirmed on one screen still
          confirms after it navigates to another. */}
      <ToastProvider>
        {/* Catches uncaught RENDER errors, reports them, shows a fail-loud
            fallback instead of a blank page. Event-handler and async throws are
            caught separately by the window.onerror / unhandledrejection handlers
            Sentry.init installs, so full coverage exists only once a DSN is set. */}
        <Sentry.ErrorBoundary fallback={<CrashFallback />}>
          <RouterProvider router={router} />
        </Sentry.ErrorBoundary>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
