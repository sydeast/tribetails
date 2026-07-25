/**
 * Runtime coercion for values that came out of Firestore.
 *
 * Every `*Entry` / `*Row` interface in `api/` is a CAST over raw document data,
 * not a validation of it. TypeScript will happily promise you `status: string`
 * for a document that has no `status` at all, and then `.trim()` throws
 * "Cannot read properties of undefined" — which React's error boundary turns
 * into a BLANK PAGE. One legacy row takes down the whole screen.
 *
 * Verified live on 2026-07-20: Invoices died on a seeded doc with no `status`
 * and no `sessionIds`; Bookings died the same way on a session row. Both were
 * green in tsc and in 1859 unit tests, because the tests build their fixtures
 * from the interface — which is exactly the shape production data violates.
 *
 * Use these at the point of use in formatters. They are deliberately boring:
 * a non-string reads as empty, a non-array reads as empty. Numbers are NOT
 * included on purpose — coercing an absent amount to 0 would invent a
 * financial fact (see normalizeInvoice for the same reasoning).
 */

/** A string field that may be absent, null, or the wrong type. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** An array field that may be absent, null, or the wrong type. */
export function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * A nested-object field that may be absent, null, or the wrong type. Returns a
 * fresh empty object so `rec(doc.data)['kinfolkId']` is always a safe read.
 * Arrays read as empty: `notifications.data` is a template-merge bag written by
 * `enqueueNotification`, and an array there is malformed, not a one-key object.
 */
export function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
