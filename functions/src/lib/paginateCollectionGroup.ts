import { FieldPath, type Query, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { logEvent } from './logger';

/**
 * Drains a (collection-group) query in document-id order, page by page, so a
 * cron is NEVER silently capped at a single `.limit(N)` page (WARNING-25). The
 * old `.limit(1000)` swallowed every record past the cap: those invoices /
 * bookings were never reminded and nothing logged.
 *
 * Each page is ordered by `documentId()` and the next page resumes
 * `.startAfter(lastDoc)`. An UNFILTERED collectionGroup().orderBy(documentId())
 * uses only the automatic single-field index — no composite index needed.
 * IMPORTANT: if the caller chains a `.where(...)` predicate on a collection-group
 * query before passing it here, Firestore REQUIRES a composite index for that
 * field plus __name__. To stay index-free, pass an unfiltered query and perform
 * any status/field filtering inside the `onDoc` callback instead.
 *
 * A `safetyMaxPages` ceiling bounds the loop. If the data set is larger than
 * `pageSize * safetyMaxPages` the drain stops and a CRITICAL log is emitted so
 * the cap is VISIBLE (fail-loud), never silent.
 *
 * @param baseQuery  the query to drain (may already carry `.where(...)`).
 * @param onDoc      invoked once per doc; may be async. Throwing aborts the drain.
 * @param opts.pageSize         docs per page (default 500).
 * @param opts.safetyMaxPages   hard ceiling on pages (default 1000).
 * @param opts.functionName     name used in the CRITICAL cap log.
 * @returns total docs processed.
 */
export async function paginateQuery(
  baseQuery: Query,
  onDoc: (doc: QueryDocumentSnapshot) => Promise<void> | void,
  opts: { pageSize?: number; safetyMaxPages?: number; functionName: string },
): Promise<number> {
  const pageSize = opts.pageSize ?? 500;
  const safetyMaxPages = opts.safetyMaxPages ?? 1000;
  const ordered = baseQuery.orderBy(FieldPath.documentId());

  let processed = 0;
  let pages = 0;
  let cursor: QueryDocumentSnapshot | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = ordered.limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.docs.length === 0) break;

    for (const doc of snap.docs) {
      await onDoc(doc);
      processed += 1;
    }
    cursor = snap.docs[snap.docs.length - 1];
    pages += 1;

    // Last partial page -> drained.
    if (snap.docs.length < pageSize) break;

    // Safety ceiling hit: stop and FAIL LOUD so the cap is never silent.
    if (pages >= safetyMaxPages) {
      logEvent({
        severity: 'critical',
        function: opts.functionName,
        event: 'cron.pagination.cap-hit',
        extra: {
          pages,
          pageSize,
          processed,
          note: 'safetyMaxPages reached; remaining records NOT processed this run',
        },
      });
      break;
    }
  }
  return processed;
}
