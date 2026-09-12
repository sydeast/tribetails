import type { UseQueryResult } from '@tanstack/react-query';

/**
 * What a portal region should render, given one React Query result.
 *
 * THE DEFECT THIS EXISTS FOR (confirmed on production). A household loses
 * signal with the tab already open. React Query's default `networkMode:
 * 'online'` does not fail those queries, it PAUSES them:
 *
 *   retryer.js      canFetch(networkMode) -> onlineManager.isOnline()
 *   query.js:349    fetchStatus: canFetch(...) ? 'fetching' : 'paused'
 *   queryObserver   isLoading = isPending && isFetching
 *
 * Paused is not fetching, so `isLoading` is FALSE. Nothing failed, so
 * `isError` is FALSE. And `data` is undefined. Every screen here was written as
 * `isLoading ? spinner : items.length === 0 ? EMPTY : rows`, so all three of
 * those falses land the kinfolk on the EMPTY state: "No upcoming bookings.
 * Nothing on the calendar yet. Request a booking and your Auntie will confirm a
 * time." A household that already has a visit booked reads that as the booking
 * being gone and books it again.
 *
 * WHY `networkMode` STAYS 'online' AND THE PAUSE IS HANDLED HERE INSTEAD.
 * Flipping the client to `networkMode: 'always'` would make the queries run and
 * fail, which does reach `isError` and does fix the false empty. It is still
 * the wrong trade:
 *
 *   - It makes a dropped bar of signal indistinguishable from the backend being
 *     down. Every screen's error path is `LaunchError`, and LaunchError's second
 *     button is Sign out, which clears this cache (see queryClient.ts). Handing
 *     a stranded household a button that throws away the only copy of their data
 *     they can still reach is a worse screen than the one we are fixing.
 *   - It burns the retries. `retry: 1` means two doomed round-trips per query
 *     per screen on a phone that already has no signal.
 *   - It throws away the resume. A paused query restarts itself the instant
 *     onlineManager sees the connection return, with no retry storm and no tap.
 *     That is the behaviour we want to keep.
 *
 * So the pause is CORRECT. What was wrong is that it was invisible. This module
 * names it, the same way `auntieos-admin/src/lib/async.ts` names the admin's
 * four states, for the same stated reason: a queue that failed must never
 * read as empty. The difference between an empty list and an unknown list is
 * the whole point, and because the branch lives here rather than at the call
 * site, "show the empty state while offline" stops being a mistake a screen can
 * make.
 */

/**
 * The part of a query result this module reads.
 *
 * Deliberately structural rather than the whole `UseQueryResult`: it keeps the
 * decision table testable from a plain node spec with object literals, no
 * React, no jsdom, no QueryClient.
 */
export type QuerySnapshot<T> = Pick<UseQueryResult<T>, 'status' | 'fetchStatus' | 'data'>;

/** Exactly one of these. The caller cannot combine them. */
export type PortalView<T> =
  | { kind: 'loading' }
  /** Paused: the device is offline and the request was never sent. */
  | { kind: 'offline' }
  | { kind: 'error' }
  /** Never asked. A query held behind `enabled: false` with no gate to blame. */
  | { kind: 'idle' }
  /** PROVEN empty: the server answered, and the answer was nothing. */
  | { kind: 'empty' }
  | { kind: 'data'; data: T };

/** A single number on screen. `0` is a claim, so it needs the same treatment. */
export type PortalCount =
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'error' }
  | { kind: 'idle' }
  | { kind: 'value'; value: number };

export interface ViewOptions<T> {
  /**
   * Consulted ONLY on success, exactly as `resolveAsync` does it. A paused or
   * failed read does not have an empty list, it has an unknown one.
   */
  isEmpty?: (data: T) => boolean;
  /**
   * The query this one is held behind (`enabled: home.isSuccess`).
   *
   * Without it a gated query sits at pending/idle forever while its gate is
   * paused, and "never asked" is not something a household can read. With it,
   * the dependant reports the gate's reason: if the gate is offline, so is
   * everything waiting on it. Home is the screen this is for: three sections
   * gated on `home.isSuccess`, all three silently empty when home pauses.
   */
  gate?: QuerySnapshot<unknown>;
}

/**
 * Decide what a region shows.
 *
 * Order matters and is not arbitrary:
 *
 * 1. `success` wins over everything. Cached rows from before the signal dropped
 *    are still the truest thing we can show, so a paused REFETCH never blanks a
 *    list that is already on screen.
 * 2. `error` beats `offline`. An error means the server did answer, badly; that
 *    is a real answer and hiding it behind "you're offline" would be the same
 *    class of lie this module exists to stop. A query that is merely offline
 *    never reaches `error` in the first place. It pauses instead of running.
 * 3. Then `paused`, which is the state the whole defect was about.
 */
export function viewOfQuery<T>(
  q: QuerySnapshot<T>,
  opts: ViewOptions<T> & { isEmpty: (data: T) => boolean },
): PortalView<T>;
/**
 * Without an [isEmpty] there is no way to reach 'empty', and the signature says
 * so: a caller that never declared what empty means cannot be handed an empty
 * state to render. That is the same "nowhere to put a fallback" property
 * `asyncScalar` has in the admin's async.ts, expressed in the type.
 */
export function viewOfQuery<T>(
  q: QuerySnapshot<T>,
  opts?: Omit<ViewOptions<T>, 'isEmpty'>,
): Exclude<PortalView<T>, { kind: 'empty' }>;
export function viewOfQuery<T>(q: QuerySnapshot<T>, opts: ViewOptions<T> = {}): PortalView<T> {
  if (q.status === 'success' && q.data !== undefined) {
    return opts.isEmpty?.(q.data) === true ? { kind: 'empty' } : { kind: 'data', data: q.data };
  }
  if (q.status === 'error') return { kind: 'error' };
  if (q.fetchStatus === 'paused') return { kind: 'offline' };
  if (q.fetchStatus === 'fetching') return { kind: 'loading' };

  // pending + idle: this query was never asked.
  if (opts.gate) {
    const gate = viewOfQuery(opts.gate);
    // A gate that has landed cannot be why we are still idle, so anything but
    // offline/error/idle means the wait is ours and reads as loading.
    if (gate.kind === 'offline' || gate.kind === 'error' || gate.kind === 'idle') return gate;
    return { kind: 'loading' };
  }
  return { kind: 'idle' };
}

/**
 * Project a count out of a query, or refuse to.
 *
 * `(data?.upcoming ?? []).length` renders a confident `0` from a read that
 * never happened. The tab counts on Schedule did exactly that. [project] only
 * runs when the data is really there, so there is nowhere to put a fallback.
 */
export function countOfQuery<T>(
  q: QuerySnapshot<T>,
  project: (data: T) => number,
  opts: Omit<ViewOptions<T>, 'isEmpty'> = {},
): PortalCount {
  // No 'empty' arm to write: the overload above proves it cannot arrive here.
  const view = viewOfQuery(q, opts);
  return view.kind === 'data' ? { kind: 'value', value: project(view.data) } : view;
}

/**
 * How to draw a count that may not be known.
 *
 * `hint` is the screen-reader and tooltip text: a bare glyph tells somebody
 * using a screen reader nothing at all. No dash glyph, because a dash and a
 * zero are too alike at pill size to risk being read as a count.
 */
export function countLabel(count: PortalCount): { text: string; hint: string | null } {
  switch (count.kind) {
    case 'value':
      return { text: String(count.value), hint: null };
    case 'offline':
      return { text: '?', hint: 'Not known while you are offline' };
    case 'error':
      return { text: '?', hint: "This didn't load" };
    case 'loading':
    case 'idle':
      return { text: '…', hint: 'Still loading' };
  }
}

/** True when this query is paused because the device is offline. */
export function isOfflinePaused(q: QuerySnapshot<unknown>, gate?: QuerySnapshot<unknown>): boolean {
  return viewOfQuery(q, gate ? { gate } : {}).kind === 'offline';
}
