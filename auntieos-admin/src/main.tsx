import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Self-hosted brand fonts (Den redesign), no font CDN at runtime.
import '@fontsource-variable/fraunces'; // variable: all heading weights
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/spline-sans-mono/400.css';

import './styles/tokens.css';
import './styles/base.css';
import './styles/signin.css';
import './styles/shell.css';
import './styles/screens.css';

import './lib/firebase'; // initialize Firebase before anything touches auth
import { router } from './router';

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
