import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection,
  documentId,
  getDocs,
  limit as fbLimit,
  orderBy,
  query,
  startAfter as fbStartAfter,
  where,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from './firebase';
import { type Async } from './async';
import { type CollectionSpec } from './firestore';
import { applyTestScope, isSuppressedInTestMode, DOC_ID_FIELD } from './testScope';

/**
 * A bounded collection read that grows a page at a time.
 *
 * This is the generalization of the ONE paging pattern in this app that is
 * already proven in production: `screens/Templates.tsx` + `api/templates.ts`,
 * where `listTemplatesPage` takes a server `limit` plus a `startAfter` cursor,
 * returns the next cursor or null, and the screen appends. That screen owns six
 * pieces of state to do it (rows, cursor, in-flight, page error, plus the two
 * reset paths), and re-implementing those six on KinTales, Invoices and Sessions
 * is three more chances to get the reset wrong. So the state moves here once.
 *
 * WHY A ONE-SHOT READ AND NOT `useCollection`
 * `useCollection` is a live `onSnapshot` listener, and a listener cannot be
 * paged: `startAfter` on a listener re-delivers the whole window on every
 * change, and a second listener per page multiplies the cost of every write.
 * These list screens are archives being browsed, not dashboards being watched,
 * so a `getDocs` per page is the honest trade. Everything ELSE about the
 * `useCollection` contract is kept deliberately identical, so a screen author
 * moving between the two is never surprised:
 *   - `order` and a page bound are REQUIRED, never optional (AO-29).
 *   - the sandbox scope is applied HERE, centrally, so no screen can forget it.
 *   - a suppressed collection resolves to a real empty rather than a scary
 *     permission banner (`lib/testScope.ts`).
 *   - every row is the doc data plus its id as `_id`, `_id` winning.
 *   - a failure is `Async` `error` WITH a retry. Never a silent empty.
 *
 * WHY THE CURSOR IS A DOCUMENT SNAPSHOT
 * Phase 4 pages three collections on three different sort keys: a doc id, an
 * ISO date string, a Firestore Timestamp. `startAfter(snapshot)` is the one
 * cursor that is correct for all three, because Firestore reads the sort values
 * off the document itself rather than making us re-serialize them. A hand-built
 * value cursor would need a per-collection encoder and would silently skip or
 * repeat rows the moment the sort key had ties.
 *
 * WHAT THE GENERATION COUNTER IS FOR
 * The failure this hook exists to make impossible: the operator clicks "Load
 * more" on the Open filter, switches to Paid before the read returns, and page
 * two of OPEN appends itself under the PAID rows. The list is then a confident,
 * silent mixture of two filters. Every read carries the generation it was
 * started in; a read whose generation is stale is DROPPED, results and errors
 * alike. It cannot append, it cannot move the cursor, and it cannot post an
 * error against a filter it was never about.
 */
export interface PagedCollectionSpec extends Omit<CollectionSpec, 'max'> {
  /**
   * Rows per page. Unlike `CollectionSpec.max` this is not a cap on the total:
   * the loaded list grows by this much per "Load more". Named differently from
   * `max` on purpose, so the two contracts cannot be confused at a glance.
   */
  pageSize: number;
}

export interface PagedCollection<T> {
  /**
   * The accumulated rows across every page loaded so far, in the same `Async`
   * shape every screen already renders through `AsyncRegion`. `error` here means
   * the list is UNKNOWN (the first page failed), which is why it is never an
   * empty array.
   */
  state: Async<T[]>;
  /** True when the last page came back full, so there may be another one. */
  hasMore: boolean;
  /**
   * The "load more" action's own state, `Async` too so it renders through the
   * same helpers. `loading` while a page is in flight, `error` with a `retry`
   * when one failed, `ready` when idle (the `null` payload is "nothing to show
   * here", the rows live in `state`).
   *
   * Separate from `state` on purpose: a failed SECOND page leaves the rows
   * already on screen perfectly true. Blanking them, or folding this into
   * `state.error`, would throw away good data to report a partial failure.
   */
  more: Async<null>;
  /** Fetch and append the next page. No-op when exhausted or already in flight. */
  loadMore: () => void;
  /** Re-read from the top. This is what a first-page `error.retry` calls. */
  reload: () => void;
}

const message = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

function buildQuery(spec: CollectionSpec, after: QueryDocumentSnapshot<DocumentData> | null) {
  const constraints: QueryConstraint[] = [];
  for (const f of spec.filters ?? []) {
    // `__name__` is the sandbox doc-id scope; Firestore only filters on document
    // id through the documentId() FieldPath, never a plain field name.
    constraints.push(f[0] === DOC_ID_FIELD ? where(documentId(), f[1], f[2]) : where(f[0], f[1], f[2]));
  }
  constraints.push(orderBy(spec.order[0], spec.order[1]));
  if (after) constraints.push(fbStartAfter(after));
  constraints.push(fbLimit(spec.max));
  return query(collection(db, spec.path), ...constraints);
}

export function usePagedCollection<T>(spec: PagedCollectionSpec): PagedCollection<T> {
  const { pageSize, ...rest } = spec;
  // Sandbox scoping is applied HERE and not in each screen's spec, so a screen
  // cannot forget it (same reasoning as useCollection).
  //
  // The key is both the effect dependency AND the query source: the effect and
  // `loadMore` parse it back rather than closing over `spec`, so the two can
  // never disagree about which filter a read belongs to. That round trip is safe
  // by the contract `CollectionSpec` already states, filter values are stable
  // primitives or ISO strings, which is the same contract that makes keying off
  // JSON.stringify correct in the first place.
  const key = JSON.stringify(applyTestScope({ ...rest, max: pageSize }));

  const [state, setState] = useState<Async<T[]>>({ status: 'loading' });
  const [hasMore, setHasMore] = useState(false);
  const [moreState, setMoreState] = useState<Async<null>>({ status: 'ready', data: null });
  const [nonce, setNonce] = useState(0);

  /** The last doc of the newest loaded page: what the next page starts after. */
  const cursor = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  /** Bumped on every reset. A read from an older generation is discarded. */
  const generation = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const rows = (docs: QueryDocumentSnapshot<DocumentData>[]) =>
    docs.map((d) => ({ ...d.data(), _id: d.id }) as T);

  useEffect(() => {
    const gen = ++generation.current;
    // A reset is total: the cursor, the exhausted flag and any page error all
    // belonged to the filter that just went away.
    cursor.current = null;
    setHasMore(false);
    setMoreState({ status: 'ready', data: null });

    const resolved = JSON.parse(key) as CollectionSpec;

    // Not applicable to a sandbox account and not scopeable either. Resolve to a
    // real empty rather than letting rules deny it and render a permission error.
    if (isSuppressedInTestMode(resolved.path)) {
      setState({ status: 'ready', data: [] });
      return;
    }
    setState({ status: 'loading' });

    // Query construction throws synchronously on a bad path or an invalid limit.
    // Catch it so a copy-paste slip fails loud in-region instead of blanking the
    // screen with a render-phase exception.
    let q;
    try {
      q = buildQuery(resolved, null);
    } catch (err) {
      setState({ status: 'error', message: message(err, 'Invalid query.'), retry: reload });
      return;
    }

    void getDocs(q)
      .then((snap) => {
        if (gen !== generation.current) return;
        setState({ status: 'ready', data: rows(snap.docs) });
        cursor.current = snap.docs[snap.docs.length - 1] ?? null;
        // A full page MIGHT have a successor; a short one provably does not.
        setHasMore(snap.docs.length === resolved.max);
      })
      .catch((err: unknown) => {
        if (gen !== generation.current) return;
        setState({ status: 'error', message: message(err, 'Load failed.'), retry: reload });
      });
    // key carries every field of the scoped spec; nonce forces a re-read on retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const loadMore = useCallback(() => {
    if (!hasMore || moreState.status === 'loading' || cursor.current === null) return;
    const gen = generation.current;
    const after = cursor.current;
    setMoreState({ status: 'loading' });

    const resolved = JSON.parse(key) as CollectionSpec;
    let q;
    try {
      q = buildQuery(resolved, after);
    } catch (err) {
      setMoreState({ status: 'error', message: message(err, 'Invalid query.') });
      return;
    }

    void getDocs(q)
      .then((snap) => {
        if (gen !== generation.current) return;
        setState((prev) =>
          prev.status === 'ready' ? { status: 'ready', data: [...prev.data, ...rows(snap.docs)] } : prev,
        );
        // Only advance past a page that actually arrived, so a failed page is
        // retried from where it was rather than silently skipped.
        cursor.current = snap.docs[snap.docs.length - 1] ?? cursor.current;
        setHasMore(snap.docs.length === resolved.max);
        setMoreState({ status: 'ready', data: null });
      })
      .catch((err: unknown) => {
        if (gen !== generation.current) return;
        setMoreState({ status: 'error', message: message(err, 'Load more failed.') });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hasMore, moreState.status]);

  const more: Async<null> =
    moreState.status === 'error'
      ? { status: 'error', message: moreState.message, retry: loadMore }
      : moreState;

  return { state, hasMore, more, loadMore, reload };
}
