import React from 'react';
import ReactDOM from 'react-dom/client';
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
import { router } from './router';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
