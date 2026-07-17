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

/**
 * A realtime collection query. The `order` + `max` are REQUIRED on purpose:
 * every live listener the admin opens is bounded and server-ordered by
 * construction (closes AO-29 — the wasm bridge listened to whole append-only
 * collections with no orderBy/limit and capped client-side). Add `filter` for a
 * scoped read (e.g. recipientUid).
 */
export interface CollectionSpec {
  path: string;
  /** [field, direction] — the server-side sort. */
  order: [string, 'asc' | 'desc'];
  /** Hard cap on rows the listener returns. */
  max: number;
  /** Optional server-side predicate: [field, op, value]. */
  filter?: [string, WhereFilterOp, unknown];
}

/**
 * Subscribe to a bounded, ordered Firestore query as `Async<T[]>`. Loading until
 * the first snapshot, then `ready` (possibly empty) or `error` — never a silent
 * empty on a permission failure (the #1 wasm defect class). Each row is the doc
 * data plus its id as `_id`, matching the model convention.
 *
 * The spec is deep-compared via its JSON so a caller can pass an inline object
 * without re-subscribing every render.
 */
export function useCollection<T>(spec: CollectionSpec): Async<T[]> {
  const [state, setState] = useState<Async<T[]>>({ status: 'loading' });
  const key = JSON.stringify(spec);

  useEffect(() => {
    setState({ status: 'loading' });
    const constraints: QueryConstraint[] = [];
    if (spec.filter) constraints.push(where(spec.filter[0], spec.filter[1], spec.filter[2]));
    constraints.push(orderBy(spec.order[0], spec.order[1]));
    constraints.push(fbLimit(spec.max));
    const q = query(collection(db, spec.path), ...constraints);

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => ({ _id: d.id, ...d.data() }) as T);
        setState({ status: 'ready', data: rows });
      },
      (err) => setState({ status: 'error', message: err.message }),
    );
    return unsub;
    // key captures every field of spec; the eslint dep-array is intentionally the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
