import { useCallback, useEffect, useRef, useState } from 'react';
import type { Async } from './async';

/**
 * Load a one-shot value into the shared `Async<T>` state machine, with a
 * fail-loud, retryable error and StrictMode-safe cancellation.
 *
 * The detail screens (KinView, KinfolkProfile, SessionDetail) each inline this
 * exact load-once effect; the Home dashboard mounts several self-loading widgets
 * side by side, so the pattern earns a hook. Each widget owning its own load
 * (rather than Home fetching everything and prop-drilling) mirrors the Compose
 * dashboard, where every insight widget takes its own `FirestoreResult`, and
 * keeps a widget independently mountable / hideable.
 *
 * [loader] is read through a ref so an inline arrow passed at the call site does
 * NOT re-fire the effect every render (only [label] is a dependency); a genuine
 * reload goes through the `retry` on the error state.
 */
/**
 * #1607: `useOneShot` that loads again whenever `key` changes, WITHOUT going
 * back to `loading` first: the rows already on screen stay put while the next
 * read is in flight, so a refresh never blanks a list or re-flashes a spinner.
 * A failed refresh is shown (with a retry), never swallowed.
 */
export function useRefreshingLoad<T>(loader: () => Promise<T>, label: string, key: string): Async<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  const [retries, setRetries] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const data = await loaderRef.current();
        if (live) setState({ status: 'ready', data });
      } catch (err) {
        if (live) {
          setState({
            status: 'error',
            message: `${label} failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: () => setRetries((n) => n + 1),
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [key, label, retries]);
  return state;
}

export function useOneShot<T>(loader: () => Promise<T>, label: string): Async<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [state, setState] = useState<Async<T>>({ status: 'loading' });

  const load = useCallback(() => {
    let live = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const data = await loaderRef.current();
        if (live) setState({ status: 'ready', data });
      } catch (err) {
        if (live) {
          setState({
            status: 'error',
            message: `${label} failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [label]);

  useEffect(() => load(), [load]);
  return state;
}
