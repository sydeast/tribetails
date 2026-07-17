import { useEffect, useState } from 'react';
import {
  collection,
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

/** One server-side predicate: [field, op, value]. */
export type Filter = [string, WhereFilterOp, unknown];

/**
 * A realtime collection query. `order` + `max` are REQUIRED on purpose: every
 * live listener the admin opens is bounded and server-ordered by construction
 * (closes AO-29 — the wasm bridge listened to whole append-only collections with
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
  /** [field, direction] — the server-side sort. */
  order: [string, 'asc' | 'desc'];
  /** Hard cap on rows the listener returns. */
  max: number;
  /** Zero or more server-side predicates (see the composite-index note above). */
  filters?: Filter[];
}

/**
 * Subscribe to a bounded, ordered Firestore query as `Async<T[]>`. Loading until
 * the first snapshot, then `ready` (possibly empty) or `error` — never a silent
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
  const key = JSON.stringify(spec);

  useEffect(() => {
    setState({ status: 'loading' });

    // Query construction can throw synchronously (bad path segment count, invalid
    // limit) — catch it so a copy-paste slip during fan-out fails loud in-region
    // instead of blanking the screen with a render-phase exception.
    let q;
    try {
      const constraints: QueryConstraint[] = [];
      for (const f of spec.filters ?? []) constraints.push(where(f[0], f[1], f[2]));
      constraints.push(orderBy(spec.order[0], spec.order[1]));
      constraints.push(fbLimit(spec.max));
      q = query(collection(db, spec.path), ...constraints);
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
