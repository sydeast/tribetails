import type { ReactNode } from 'react';
import { resolveAsync, type Async } from '../lib/async';
import { useSlowWait } from '../lib/slowWait';
import { SlowWaitNotice } from './SlowWaitNotice';
import { Spinner } from './Spinner';

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
 * The one in-flight marker in the app: `div[role=status][aria-live=polite]`
 * wrapping either a caller's skeleton or the default "Loading ___…" line.
 *
 * Extracted out of `AsyncRegion` so the ROUTE-level wait can render the same
 * thing (`components/RoutePending.tsx`). A lazily-loaded screen and a
 * lazily-loaded collection are the same event as far as the operator and the
 * screen reader are concerned, and the visual harness already waits on exactly
 * this selector before it photographs anything (`e2e/visual.capture.spec.ts`),
 * so a second spinner idiom would be a second thing for it to learn.
 *
 * IT NOW MOVES, AND IT NOW ESCALATES (operator ruling, 2026-09-12: "any
 * waits/delays/etc need to have some sort of loading icon", and "a tap to sync
 * option if server access is taking too long"). Both land here rather than on
 * sixty screens because this is already the one marker every one of them goes
 * through -- `AsyncRegion`'s loading branch and `RoutePending` both render it.
 * Issue #714 built `components/Spinner.tsx` and then wired it into five
 * settings sections by hand; everything else kept the bare sentence. Putting it
 * in the seam is what stops that from being the shape of the fix again.
 *
 * The spinner is added BESIDE the sentence, never in place of it. "Loading
 * bookings…" says which of the four regions on a screen is the one still
 * waiting; a bare ring says only that something is. That is also what keeps
 * this honest under `prefers-reduced-motion`, where the ring is slowed right
 * down and the words are doing most of the work (see Spinner.css).
 *
 * A CALLER'S OWN [children] SKELETON KEEPS THE ESCALATION AND LOSES NOTHING:
 * the notice is a sibling of the skeleton, not a replacement for it, so a
 * screen that drew its own shimmer bars still gains a way forward at 10s.
 */
export function AsyncLoading({
  what,
  retry,
  children,
}: {
  what: string;
  /**
   * What "Sync now" does once the wait passes the threshold. Absent means the
   * notice offers a page reload instead -- never nothing. See SlowWaitNotice
   * for the idempotency rule before pointing this at a write.
   */
  retry?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const wait = useSlowWait(true, retry);
  return (
    // role=status, not just grey boxes: the wasm canvas exposed nothing to
    // screen readers (AO-15) and we are not repeating that.
    <div role="status" aria-live="polite">
      {children ?? (
        <p className="async-loading loadingRow">
          <Spinner label={`Loading ${what}`} />
          <span>Loading {what}…</span>
        </p>
      )}
      {wait.phase === 'slow' && (
        <SlowWaitNotice what={what} attempt={wait.attempt} onSync={wait.canSync ? wait.sync : undefined} />
      )}
    </div>
  );
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
      // `r.retry` is the producer's own reload closure, carried on the loading
      // state rather than only the error one (see lib/async.ts). A producer
      // that supplies none still gets the escalation, offering a page reload.
      return (
        <AsyncLoading what={what} retry={r.retry}>
          {loading}
        </AsyncLoading>
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
