import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import {
  PAY_METHOD_SNAPSHOT_FIELD,
  payMethodSettingsFrom,
  payMethodSettingsSnapshotOf,
  type OperatorSettings,
  type PayMethodSettingsSnapshot,
} from './paymentMethods';

/**
 * THE ONE PLACE `business_settings` IS READ FOR PAYMENT METHODS (issue #409).
 *
 * `paymentMethods.ts` is deliberately pure — it takes settings and gives back
 * a resolved list, and its whole test suite runs without Firestore. This
 * module is the Firestore half: the read, and the snapshot write the issue-
 * time callables need.
 *
 * ── WHY THE SNAPSHOT IS WRITTEN AT ISSUE TIME ─────────────────────────────
 *
 * Operator ruling on issue #409: turning a payment method off stops offering
 * it on NEW invoices; invoices already issued keep working. So the settings
 * live at the moment an invoice becomes a bill are copied onto that bill, and
 * the portal resolves against the copy.
 *
 * "Issue time" is the three writes that put an invoice in front of a
 * household: `createInvoice`, `createQuote`, and `reviewAndSendDraftInvoice`
 * (draft to open). Nothing else stamps it and nothing backfills it. An
 * invoice with no snapshot falls back to live settings, which is exactly the
 * behaviour it has today, so this ships with no migration and no invoice
 * changing under anybody.
 *
 * ── FAIL-SOFT, ALWAYS ─────────────────────────────────────────────────────
 *
 * A settings read that fails must never fail the invoice. The bill is the
 * deliverable; the snapshot is an optimisation on top of a fallback that
 * already works. `payMethodSnapshotForIssue` therefore returns an empty patch
 * on any error, logs it at warn so the gap is visible in monitoring, and lets
 * the invoice write proceed. Same call as `invoicePdf.ts` makes for the same
 * read.
 */

export const BUSINESS_SETTINGS_DOC = 'business_settings';

/**
 * The live `business_settings` payment configuration.
 *
 * Throws on a genuine read failure, for the caller to decide about: a portal
 * read that cannot reach settings should surface, while an invoice write that
 * cannot reach them should carry on (see `payMethodSnapshotForIssue`).
 */
export async function readLivePayMethodSettings(): Promise<OperatorSettings> {
  const snap = await db().collection(BUSINESS_SETTINGS_DOC).doc(BUSINESS_SETTINGS_DOC).get();
  return payMethodSettingsFrom(snap.data() ?? {});
}

/**
 * The `{ payMethodSettingsSnapshot: ... }` patch an issue-time write merges
 * onto the invoice, or `{}` when settings could not be read.
 *
 * Spread into the invoice write, never written separately: the snapshot and
 * the status flip it describes belong in one write, so a retry cannot produce
 * an invoice that is open with a snapshot from a different moment.
 */
export async function payMethodSnapshotForIssue(
  fn: string,
): Promise<{ [PAY_METHOD_SNAPSHOT_FIELD]?: PayMethodSettingsSnapshot }> {
  try {
    const snap = await db().collection(BUSINESS_SETTINGS_DOC).doc(BUSINESS_SETTINGS_DOC).get();
    return { [PAY_METHOD_SNAPSHOT_FIELD]: payMethodSettingsSnapshotOf(snap.data() ?? {}) };
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: fn,
      event: 'invoice.paymethods.snapshot.skipped',
      errorMessage: (err as Error)?.message,
    });
    return {};
  }
}
