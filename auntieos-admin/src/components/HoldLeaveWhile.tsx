import { useBlocker, useRouter } from '@tanstack/react-router';

/**
 * #1895: while `work` runs, leaving the screen waits for it. A reload or a
 * closed tab gets the browser's own "leave this page?" prompt, because either
 * one drops the call. A move inside the app waits, then goes through when the
 * work succeeds. When it fails the screen stays, so the failure banner is seen
 * (a toast cannot carry an error here, on purpose).
 */
export function HoldLeaveWhile({ work }: { work: Promise<unknown> | null }) {
  // Screens are also rendered outside a router in tests.
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null;
  if (router === null || work === null) return null;
  return <Hold work={work} />;
}

function Hold({ work }: { work: Promise<unknown> }) {
  useBlocker({
    shouldBlockFn: async () => {
      try {
        await work;
        return false;
      } catch {
        return true;
      }
    },
    enableBeforeUnload: true,
  });
  return null;
}
