import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Self-hosted fonts (no font CDN at runtime).
import '@fontsource/young-serif/400.css';
import '@fontsource/bricolage-grotesque/400.css';
import '@fontsource/bricolage-grotesque/500.css';
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';

import './styles/tokens.css';
import './styles/base.css';
import './styles/auth.css';
import './styles/schedule.css';
import './styles/kin.css';
import './styles/kindetail.css';
import './styles/tribepicker.css';
import './styles/kintales.css';
import './styles/invoices.css';
import './styles/notifications.css';
import './styles/tribe.css';
import './styles/account.css';
import './styles/signedImageUpload.css';

import './lib/firebase'; // initialize Firebase before anything else touches auth
import { ensureRecaptcha } from './lib/auth';
import { initSentry } from './lib/sentry';
import { router } from './router';

// Start crash reporting before the app renders, so an error during first paint
// is still captured. No-op (with a visible console line) when no VITE_SENTRY_DSN.
initSentry();

// Kick off the reCAPTCHA interceptor install immediately (the Kotlin app had
// a race where sign-in could beat it; every auth call also awaits it).
void ensureRecaptcha();

// Legacy hash deep links (#/claim/<id>) predate history routing. Rewrite them
// to real URLs BEFORE the router binds; the old app had a hash-strip-before-
// bind gotcha where a leftover hash broke route matching.
const hash = window.location.hash;
const claimMatch = /^#\/claim\/([^/?#]+)/.exec(hash);
if (claimMatch) {
  window.history.replaceState(null, '', `/claim?invite=${encodeURIComponent(claimMatch[1] ?? '')}`);
} else if (hash.startsWith('#/')) {
  window.history.replaceState(null, '', hash.slice(1) + window.location.search);
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
        color: '#1c1a17',
        background: '#FBFBF9',
      }}
    >
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>We hit a snag loading this page.</h1>
      <p style={{ maxWidth: '32rem', margin: 0, opacity: 0.8 }}>
        Nothing you saved is lost. Reloading usually sorts it out.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginTop: '0.5rem',
          padding: '0.6rem 1.1rem',
          borderRadius: '999px',
          border: 'none',
          background: '#1c1a17',
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
      {/* Catches uncaught RENDER errors, reports them, shows a fail-loud
          fallback instead of a blank page. Event-handler and async throws are
          caught separately by the window.onerror / unhandledrejection handlers
          Sentry.init installs, so full coverage exists only once a DSN is set. */}
      <Sentry.ErrorBoundary fallback={<CrashFallback />}>
        <RouterProvider router={router} />
      </Sentry.ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);
