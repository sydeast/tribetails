/**
 * ISSUE #519: reading an age off a document that three different writers have
 * stamped three different ways.
 *
 * Both retention purges hit this. `breadcrumbs` carries `timestamp` as epoch
 * MILLISECONDS from Android (`LocationPoint.timestamp: Long`) and as an ISO-8601
 * STRING from the desktop console (`Breadcrumb.timestamp: String`), on the same
 * subcollection. `kin_care_reports` stamps `createdAt`/`updatedAt` as ISO
 * strings, and some migrated rows carry neither.
 *
 * AN UNREADABLE STAMP IS NOT AN OLD DOCUMENT. `null` returned here means "skip
 * this row", never "treat it as epoch zero", which is the difference between a
 * purge that respects its window and one that deletes the entire archive on its
 * first run. It is the same rule `rotateOldFcmTokens` follows for a token whose
 * freshness was never stamped: nothing should be inferred about a document
 * nobody dated.
 *
 * Firestore `Timestamp` is accepted too (duck-typed on `toMillis`) so a future
 * writer that uses the native type does not silently become unpurgeable.
 */

/** Epoch milliseconds for a stamp of any shape this codebase writes, or null when it cannot be read. */
export function stampToMillis(raw: unknown): number | null {
  if (typeof raw === 'number') {
    // Epoch ms from Android. A zero or negative stamp is a default that was
    // never set, not a document from 1970.
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  if (raw && typeof (raw as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (raw as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

/**
 * The age stamp for a document, taking the FIRST readable of `fields` in order.
 *
 * Order is the caller's policy, not a detail: the draft purge asks for
 * `updatedAt` before `createdAt`, because a draft the operator edited last week
 * is not abandoned however long ago it was started.
 */
export function firstReadableStamp(
  data: Record<string, unknown>,
  fields: readonly string[],
): number | null {
  for (const field of fields) {
    const ms = stampToMillis(data[field]);
    if (ms !== null) return ms;
  }
  return null;
}
