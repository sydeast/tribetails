import { QueryClient } from '@tanstack/react-query';

/**
 * The app's one React Query cache.
 *
 * It used to be constructed inline in `main.tsx`, which made it unreachable
 * from anywhere else — and sign-out is somewhere else (#539). Every screen's
 * data lives in here keyed by the kinfolk id, so a cache that outlives a
 * sign-out is the previous account's household still sitting in memory,
 * ready to paint the moment any authenticated route mounts again. `lib/auth.ts`
 * clears it as part of tearing the session down, which it can only do if the
 * client is a module of its own.
 *
 * It must NOT be created inside `main.tsx`'s render call for the same reason:
 * two clients would mean the one sign-out clears is not the one the screens
 * read.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});
