/**
 * One load state, four outcomes, exactly one of them at a time.
 *
 * Mirrors the Compose app's `FirestoreResult<T>` (Loading / Data / Error) on
 * purpose: the mental model carries over, and every screen already thinks in it.
 * What is new is the RESOLUTION step below, which is the thing the wasm admin
 * lacks and which caused most of the 2026-07-15 review's findings.
 *
 * The defect being designed out (all live, all verified on production):
 *   Home         "Open bookings: 0 / needs a reply" while permission-denied.
 *   Bookings     two "Couldn't load" banners beside three counts reading 0.
 *   Tribal Intel "Couldn't load training documents" stacked on "No Tribal Intel yet".
 *   Templates    error + endless "Loading templates..." + "All 0", together.
 *
 * All four are one root cause: `(state as? Data)?.value ?: emptyList()` turns an
 * Error into an empty success, and then a separate `if (isEmpty)` cheerfully
 * renders "nothing here yet" on top of a failure. The `?: 0` / `?: emptyList()`
 * is where the truth is lost, so this module never offers one.
 */

export type Async<T> =
  /**
   * [retry] is what "Sync now" re-runs once this load passes
   * `lib/slowWait.ts#SLOW_WAIT_MS` (operator ruling, 2026-09-12). It is the same
   * closure the error state already carries, and most producers already hoist
   * one for exactly that reason (`load` in FormSchemas.tsx, FeatureFlags.tsx),
   * so supplying it is usually `{ status: 'loading', retry: load }`.
   *
   * OPTIONAL, so no existing producer had to change and none is forced to
   * invent a retry it does not have. A loading state without one still
   * escalates: `components/SlowWaitNotice.tsx` falls back to offering a page
   * reload, because the ruling's floor is that no wait is ever a dead end.
   */
  | { status: 'loading'; retry?: () => void }
  | { status: 'error'; message: string; retry?: () => void }
  | { status: 'ready'; data: T };

/** What a region should render. Exactly one; the caller cannot combine them. */
export type Resolved<T> =
  | { kind: 'loading'; retry?: () => void }
  | { kind: 'error'; message: string; retry?: () => void }
  | { kind: 'empty' }
  | { kind: 'data'; data: T };

/**
 * Decide what a region shows.
 *
 * [isEmpty] is deliberately only consulted on `ready`. A failed load does not
 * have an empty list, it has an UNKNOWN list, and the difference is the whole
 * point: an empty inbox and an unreadable inbox must not look alike. Because the
 * branch lives here rather than at the call site, "show the empty state during an
 * error" is not a mistake a screen can make.
 */
export function resolveAsync<T>(state: Async<T>, isEmpty: (data: T) => boolean): Resolved<T> {
  switch (state.status) {
    case 'loading':
      // Same shape as the error arm below, and for the same reason: spreading
      // `state` would carry `status` in alongside `kind`.
      return state.retry ? { kind: 'loading', retry: state.retry } : { kind: 'loading' };
    case 'error':
      // Not `{ kind: 'error', ...state }`: that would spread `status` in too.
      return state.retry
        ? { kind: 'error', message: state.message, retry: state.retry }
        : { kind: 'error', message: state.message };
    case 'ready':
      return isEmpty(state.data) ? { kind: 'empty' } : { kind: 'data', data: state.data };
  }
}

/** What a single value (a count, a total) should render. */
export type ResolvedScalar<V> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'value'; value: V };

/**
 * Project a scalar out of a load state, or refuse to.
 *
 * A number on screen is a claim. `openBookings = (state as? Data)?.value?.size ?: 0`
 * makes that claim from a failed read, which is how an operator with real booking
 * requests waiting came to see a confident zero with no error anywhere on the
 * screen (Home has no bookings panel, so the card was the only possible surface).
 *
 * [project] never runs unless the data is really there, so there is nowhere to
 * put a fallback.
 */
export function asyncScalar<T, V>(state: Async<T>, project: (data: T) => V): ResolvedScalar<V> {
  switch (state.status) {
    case 'loading':
      return { kind: 'loading' };
    case 'error':
      return { kind: 'error', message: state.message };
    case 'ready':
      return { kind: 'value', value: project(state.data) };
  }
}
