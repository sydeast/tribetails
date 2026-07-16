import type { ReactNode } from 'react';
import { resolveAsync, type Async } from '../lib/async';

interface Props<T> {
  state: Async<T>;
  /**
   * What is being loaded, lower-case, as it should read in "Couldn't load ___".
   * e.g. "bookings", "schemas", "training documents".
   */
  what: string;
  isEmpty: (data: T) => boolean;
  /** Shown ONLY for a proven-empty ready state. Never during loading or error. */
  empty: ReactNode;
  /** Optional custom in-flight node (a skeleton). Defaults to a plain line. */
  loading?: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * Renders exactly one of: loading, error, empty, data.
 *
 * Modelled on Form Schemas, the one screen in the wasm admin that gets this
 * right. It names the failing callable, offers Retry, and replaces the list with
 * "Schemas unavailable while the load is failing" instead of an empty state.
 * Every other screen hand-rolls this and about half get it wrong, which is the
 * central finding of the 2026-07-15 review: not a knowledge gap, a missing
 * component. So the component is the fix.
 *
 * Two things it will not let a caller do:
 *  - render an empty state while the load is failing (Tribal Intel does today)
 *  - leave a spinner running after an error (Templates does today)
 *
 * The empty branch is unreachable during an error because `resolveAsync` owns the
 * decision and never consults `isEmpty` unless the data is really there.
 */
export function AsyncRegion<T>({ state, what, isEmpty, empty, loading, children }: Props<T>) {
  const r = resolveAsync(state, isEmpty);

  switch (r.kind) {
    case 'loading':
      return (
        // role=status, not just grey boxes: the wasm canvas exposed nothing to
        // screen readers (AO-15) and we are not repeating that.
        <div role="status" aria-live="polite">
          {loading ?? <p className="async-loading">Loading {what}…</p>}
        </div>
      );

    case 'error':
      return (
        <div role="alert" className="async-error">
          <h3 className="async-error-title">Couldn&rsquo;t load {what}</h3>
          <p className="async-error-detail">{r.message}</p>
          {r.retry && (
            <button type="button" className="async-retry" onClick={r.retry}>
              Retry
            </button>
          )}
          {/* Says the region is unknown. Saying "nothing here yet" would be a
              claim we cannot support, which is exactly today's bug. */}
          <p className="async-error-unavailable">
            {capitalise(what)} unavailable while the load is failing.
          </p>
        </div>
      );

    case 'empty':
      return <>{empty}</>;

    case 'data':
      return <>{children(r.data)}</>;
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
