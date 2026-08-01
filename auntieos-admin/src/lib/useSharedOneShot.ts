import { useCallback, useEffect, useRef, useState } from 'react';
import type { Async } from './async';

/**
 * `useOneShot`, but ONE request no matter how many widgets ask for it.
 *
 * Home mounts every widget on the operator's board at once, and two of them
 * (Weather Watchdog and Heat Stroke Index) read the SAME callable. With
 * `useOneShot` that is two POSTs to `getLocalWeather` on every visit to /home,
 * for one reading that the server then hands back from its own cache anyway.
 * The e2e egress work measured ten POSTs per /home visit from the widgets that
 * already existed; adding twelve more cards is exactly the moment to stop
 * paying per card for data that is per board.
 *
 * The cache is keyed by a caller-supplied string, so two components asking for
 * the same thing must spell it the same way. Entries hold the PROMISE, not just
 * the value, so a second caller mounting while the first request is still in
 * flight joins that request rather than starting another.
 *
 * TWO RULES THE CACHE FOLLOWS, both of them about not lying:
 *  - A REJECTION IS NEVER CACHED. The entry is dropped the moment the loader
 *    throws, so Retry genuinely retries instead of replaying the same failure
 *    forever from memory.
 *  - A SUCCESS EXPIRES. Held past [ttlMs] the entry is dropped on next use, so
 *    a dashboard left open all afternoon is not still showing this morning's
 *    weather as though it were current.
 */

interface Entry {
  promise: Promise<unknown>;
  /** When the promise settled successfully; 0 while still in flight. */
  settledAtMs: number;
}

const cache = new Map<string, Entry>();

/** Default freshness window. Shorter than the server's own 30-minute weather
 *  cache, so an expiry here usually costs a cache hit there rather than a
 *  round trip to the National Weather Service. */
export const SHARED_ONE_SHOT_TTL_MS = 5 * 60 * 1000;

/**
 * Run [loader] at most once per [key] per [ttlMs], sharing the in-flight
 * promise with every other caller. Exported apart from the hook so a test (or
 * a non-React caller) can exercise the sharing without rendering.
 */
export function sharedLoad<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = SHARED_ONE_SHOT_TTL_MS,
): Promise<T> {
  const held = cache.get(key);
  if (held !== undefined) {
    const fresh = held.settledAtMs === 0 || Date.now() - held.settledAtMs < ttlMs;
    if (fresh) return held.promise as Promise<T>;
    cache.delete(key);
  }

  const entry: Entry = { promise: Promise.resolve(), settledAtMs: 0 };
  entry.promise = loader().then(
    (value) => {
      entry.settledAtMs = Date.now();
      return value;
    },
    (err: unknown) => {
      // Never hold a failure: the next caller, and every Retry, must reach the
      // loader again rather than replaying this rejection out of memory.
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    },
  );
  cache.set(key, entry);
  return entry.promise as Promise<T>;
}

/** Drop one key (or everything). Used by Retry, and by tests between cases. */
export function invalidateSharedLoad(key?: string): void {
  if (key === undefined) cache.clear();
  else cache.delete(key);
}

/**
 * The `Async<T>` state of a shared one-shot load.
 *
 * Same contract as `useOneShot`: loading, then ready or a fail-loud error
 * carrying a `retry`. [loader] is read through a ref so an inline arrow at the
 * call site does not re-fire the effect every render; only [key] does that.
 * Retry drops the cached entry first, so it is a real reload for every widget
 * sharing the key and not just for the one that was clicked.
 */
export function useSharedOneShot<T>(
  key: string,
  loader: () => Promise<T>,
  label: string,
  ttlMs: number = SHARED_ONE_SHOT_TTL_MS,
): Async<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [state, setState] = useState<Async<T>>({ status: 'loading' });

  const load = useCallback(
    (force: boolean) => {
      let live = true;
      if (force) invalidateSharedLoad(key);
      setState({ status: 'loading' });
      void (async () => {
        try {
          const data = await sharedLoad(key, () => loaderRef.current(), ttlMs);
          if (live) setState({ status: 'ready', data });
        } catch (err) {
          if (live) {
            setState({
              status: 'error',
              message: `${label} failed: ${err instanceof Error ? err.message : 'Load failed'}`,
              retry: () => load(true),
            });
          }
        }
      })();
      return () => {
        live = false;
      };
    },
    [key, label, ttlMs],
  );

  useEffect(() => load(false), [load]);
  return state;
}
