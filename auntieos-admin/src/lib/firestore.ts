import { useEffect, useState } from 'react';
import {
  collection,
  doc,
  documentId,
  limit as fbLimit,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryConstraint,
  type WhereFilterOp,
} from 'firebase/firestore';
import { db } from './firebase';
import { type Async } from './async';
import {
  applyTestScope,
  isSuppressedInTestMode,
  isVisibleInTestScope,
  DOC_ID_FIELD,
} from './testScope';

/** One server-side predicate: [field, op, value]. */
export type Filter = [string, WhereFilterOp, unknown];

/**
 * A realtime collection query. `order` + `max` are REQUIRED on purpose: every
 * live listener the admin opens is bounded and server-ordered by construction
 * (closes AO-29, the wasm bridge listened to whole append-only collections with
 * no orderBy/limit and capped client-side).
 *
 * NOTES for screens copying this:
 *  - Combining a `filters` predicate on one field with `order` on another REQUIRES
 *    a composite Firestore index. Deploy it, or the query fails 'failed-precondition'
 *    at runtime.
 *  - Filter VALUES must be stable primitives / ISO strings. A value recreated every
 *    render (Timestamp.now(), new Date()) churns the subscription each render, since
 *    the effect keys off JSON.stringify(spec). Compute the boundary once.
 */
export interface CollectionSpec {
  path: string;
  /** [field, direction], the server-side sort. */
  order: [string, 'asc' | 'desc'];
  /** Hard cap on rows the listener returns. */
  max: number;
  /** Zero or more server-side predicates (see the composite-index note above). */
  filters?: Filter[];
}

/**
 * Subscribe to a bounded, ordered Firestore query as `Async<T[]>`. Loading until
 * the first snapshot, then `ready` (possibly empty) or `error`, never a silent
 * empty on a permission failure (the #1 wasm defect class). A malformed spec and
 * a detached-listener error both land in `error` WITH a `retry` (Firestore
 * detaches a listener permanently after its error callback, so recovery must
 * re-subscribe, not just re-render). Each row is the doc data plus its id as
 * `_id`, with `_id` winning unconditionally over any same-named field.
 */
export function useCollection<T>(spec: CollectionSpec): Async<T[]> {
  const [state, setState] = useState<Async<T[]>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const retry = () => setNonce((n) => n + 1);
  // Sandbox scoping is applied HERE, not in each screen's spec, so a screen
  // cannot forget it. A test admin is permission-denied on an unscoped read of
  // the operator collections; see lib/testScope.ts.
  const scoped = applyTestScope(spec);
  const key = JSON.stringify(scoped);

  useEffect(() => {
    // Not applicable to a sandbox account, and not scopeable either. Resolve to
    // a real empty result rather than letting rules deny it and render a scary
    // permission error. Mirrors android's test-mode suppression.
    if (isSuppressedInTestMode(scoped.path)) {
      setState({ status: 'ready', data: [] });
      return;
    }
    setState({ status: 'loading' });

    // Query construction can throw synchronously (bad path segment count, invalid
    // limit), catch it so a copy-paste slip during fan-out fails loud in-region
    // instead of blanking the screen with a render-phase exception.
    let q;
    try {
      const constraints: QueryConstraint[] = [];
      for (const f of scoped.filters ?? []) {
        // `__name__` is the sandbox doc-id scope (see testScope.ts). Firestore
        // only filters on document id through the documentId() FieldPath, not
        // through a plain field-name string.
        constraints.push(
          f[0] === DOC_ID_FIELD ? where(documentId(), f[1], f[2]) : where(f[0], f[1], f[2]),
        );
      }
      constraints.push(orderBy(scoped.order[0], scoped.order[1]));
      constraints.push(fbLimit(scoped.max));
      q = query(collection(db, scoped.path), ...constraints);
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Invalid query.', retry });
      return;
    }

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => ({ ...d.data(), _id: d.id }) as T);
        setState({ status: 'ready', data: rows });
      },
      (err) => setState({ status: 'error', message: err.message, retry }),
    );
    return unsub;
    // key captures every field of spec; nonce forces a re-subscribe on retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  return state;
}
/**
 * Subscribe to ONE document by id as `Async<T | null>`, where `null` means the
 * document is not there for this operator to see.
 *
 * WHY THIS EXISTS. A deep link names a record; resolving it by searching the
 * rows a screen happens to have loaded answers a different question. Invoices
 * streams one page of one date window (7 days by default), Bookings streams the
 * 200 newest sessions, so `/invoices?invoiceId=<id>` for a 46-day-old invoice
 * found nothing and dropped the operator on the list, which is the whole of
 * issue #389's invoice half. A by-id read does not care what the list shows.
 *
 * A SUBSCRIPTION, not a one-shot get, for the same reason `useCollection` is
 * one: the sheets these ids open host writes (record a payment, approve a
 * booking), and a frozen copy of the record would disagree with the list behind
 * it the moment one landed. Reusable across target types by construction: the
 * path is a parameter, and it shapes nothing (`normalizeInvoice` and friends
 * stay the caller's job, exactly as they are for a row off `useCollection`).
 *
 * THE THREE OUTCOMES, kept apart on purpose (the async.ts rule):
 *   ready + data    the document, its id merged in as `_id` as rows carry it.
 *   ready + null    no such document, or not this account's to read. Callers
 *                   render "no longer available", never a blank sheet.
 *   error           anything else, WITH a retry (a listener that errors is
 *                   detached permanently, so recovery re-subscribes).
 *
 * `permission-denied` resolves to `null` rather than `error` deliberately. To a
 * sandbox operator following a link into another tribe's record, "you may not
 * read this" and "it isn't there" are the same fact and neither is a fault to
 * report; rendering the raw rules message would also turn the screen into an
 * existence oracle for documents the account cannot see.
 */
export function useDocById<T>(path: string, id: string | null | undefined): Async<T | null> {
  const [state, setState] = useState<Async<T | null>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const retry = () => setNonce((n) => n + 1);
  const docId = (id ?? '').trim();
  useEffect(() => {
    // No id to resolve is a settled answer, not a pending one: a screen with no
    // deep link must not sit in `loading` forever waiting for a read that will
    // never be issued.
    if (docId === '') {
      setState({ status: 'ready', data: null });
      return;
    }
    // Same suppression `useCollection` applies, for the same reason: a sandbox
    // account cannot read these collections at all and they carry no field to
    // scope by, so the honest answer is "not available here", not a red banner.
    if (isSuppressedInTestMode(path)) {
      setState({ status: 'ready', data: null });
      return;
    }
    setState({ status: 'loading' });
    let ref;
    try {
      ref = doc(db, path, docId);
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Invalid document path.',
        retry,
      });
      return;
    }
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setState({ status: 'ready', data: null });
          return;
        }
        const data = snap.data();
        // The doc-level half of the sandbox scope `applyTestScope` applies to
        // queries. Rules deny most cross-tribe reads outright (handled in the
        // error branch below), but a collection whose rule is broader would
        // otherwise hand a test admin a record from outside their sandbox.
        if (!isVisibleInTestScope(path, docId, data)) {
          setState({ status: 'ready', data: null });
          return;
        }
        setState({ status: 'ready', data: { ...data, _id: snap.id } as T });
      },
      (err) => {
        if (err.code === 'permission-denied') {
          setState({ status: 'ready', data: null });
          return;
        }
        setState({ status: 'error', message: err.message, retry });
      },
    );
    return unsub;
    // nonce forces a re-subscribe on retry (see useCollection's note).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, docId, nonce]);
  return state;
}
