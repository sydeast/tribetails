import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotificationDetailed } from '../notifications/dispatcher';
import { paginateQuery } from '../lib/paginateCollectionGroup';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';

const REMINDER_WINDOW_DAYS = 3;
const NOTIFIED_FIELD_REMINDER = 'reminderNotifiedAtMs';
const NOTIFIED_FIELD_OVERDUE = 'overdueNotifiedAtMs';

type InvoiceDoc = {
  status?: string;
  paymentStatus?: string;
  dueDate?: string;
  invoiceDueDate?: string;
  amountDue?: number;
  amountMinor?: number;
  currency?: string;
  kinfolkId?: string;
  [k: string]: unknown;
};

// `createInvoice.ts`/`createQuote.ts` stamp `dueDate`; `invoiceDueDate` is
// read as a legacy/alternate key (matches the same hedge in
// sendInvoiceReminder.ts and enrichTemplateData.ts) so this never regresses
// again if a future writer picks the other name.
function parseDueMs(d: InvoiceDoc): number | null {
  const s = d.dueDate || d.invoiceDueDate;
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// `paymentStatus`/`status==='paid'` cover the Stripe webhook path
// (stripeWebhook.ts sets both `status` and `amountDue:0` together); the
// `amountDue <= 0` check covers every other write path (e.g. AuntieOS
// manual payments) — the same reading the portal's retired `resolveStatus`
// used. The portal now renders the stored state stamp (ADR-0002); this cron
// still money-checks defensively because a missed reminder is cheaper than a
// wrongly sent one, and `amountDue <= 0` can only ever SUPPRESS a reminder.
function isPaid(d: InvoiceDoc): boolean {
  if (d.paymentStatus === 'PAID' || d.status === 'paid') return true;
  return typeof d.amountDue === 'number' && d.amountDue <= 0;
}

/**
 * Reminds on one invoice doc if it is unpaid, due within the reminder window,
 * and not yet reminded. Exported for unit testing of the per-doc decision.
 * Returns true when a reminder was enqueued.
 *
 * #832: `reminderNotifiedAtMs` means "a reminder reached this household", and
 * the reminder button, the cron's own skip and every client's "Last reminder"
 * row all read it that way. So it is written only for a reminder that really
 * went out: now, when this run's was written; or the earlier send's time, when
 * the dispatcher reports a duplicate (a button press whose own stamp did not
 * land). When prefs suppressed every recipient nothing went out and nothing is
 * stamped, so the invoice stays eligible if the household turns reminders on.
 */
export async function processReminderInvoice(
  docSnap: QueryDocumentSnapshot,
  now: number,
): Promise<boolean> {
  const windowEnd = now + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const data = docSnap.data() as InvoiceDoc;
  if (isPaid(data)) return false;
  if (data[NOTIFIED_FIELD_REMINDER]) return false;
  const dueMs = parseDueMs(data);
  if (dueMs === null) return false;
  if (dueMs < now || dueMs > windowEnd) return false;
  // Invoices live in the flat top-level `invoices` collection (O-14), so
  // `docSnap.ref.parent.parent` is always null here — read the stamped field.
  const familyId = data.kinfolkId;
  if (!familyId) return false;
  const recipientUid = await resolveKinfolkUid(familyId);
  try {
    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.reminder',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: familyId,
        invoiceId: docSnap.id,
        invoiceDueDate: data.invoiceDueDate ?? null,
        amountMinor: data.amountMinor ?? null,
        currency: data.currency ?? null,
      },
      fireAtMs: now,
    });
    if (outcome.written.length > 0) {
      await docSnap.ref.set({ [NOTIFIED_FIELD_REMINDER]: now }, { merge: true });
      return true;
    }
    const duplicate = outcome.suppressed.find((s) => s.reason === 'duplicate');
    if (duplicate) {
      // A reminder already reached this household; record THAT one.
      await docSnap.ref.set({ [NOTIFIED_FIELD_REMINDER]: duplicate.lastAtMs ?? now }, { merge: true });
    }
    logEvent({
      severity: 'info',
      function: 'invoiceRemindersCron',
      event: duplicate ? 'reminder.already-delivered' : 'reminder.suppressed',
      extra: { familyId, invoiceId: docSnap.id, lastAtMs: duplicate?.lastAtMs ?? null },
    });
    return false;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'invoiceRemindersCron',
      event: 'notification.dispatch.failed',
      extra: { familyId, invoiceId: docSnap.id, err: (err as Error)?.message },
    });
    return false;
  }
}

/**
 * Drains the whole `invoices` collection-group, page by page (WARNING-25): the
 * old single `.limit(1000)` never reminded any invoice past the cap. Exported
 * so a test can drive the full scan against a paged mock.
 */
export async function runInvoiceRemindersScan(now: number = Date.now()): Promise<number> {
  let reminded = 0;
  await paginateQuery(
    db().collectionGroup('invoices'),
    async (docSnap) => {
      if (await processReminderInvoice(docSnap, now)) reminded += 1;
    },
    { functionName: 'invoiceRemindersCron' },
  );
  return reminded;
}

/**
 * Runs daily 09:00 ET. Scans invoices with a due date within REMINDER_WINDOW_DAYS,
 * unpaid, and not yet reminded, enqueues `invoice.reminder` once per invoice.
 */
export const invoiceRemindersCron = onSchedule(
  // Walks open invoices and fans out reminders inside the default 60s
  // timeout. See notificationDebounceSweep.
  {
    schedule: 'every day 09:00',
    timeZone: 'America/New_York',
    secrets: ['SENTRY_DSN'],
    ...FULL_CPU_SERIAL,
  },
  wrapScheduled('invoiceRemindersCron', async () => {
    await runInvoiceRemindersScan(Date.now());
  }),
);

/**
 * When prefs last suppressed this invoice's overdue notice (ms epoch). Kept
 * apart from `overdueNotifiedAtMs` on purpose (#832): that stamp means a notice
 * reached the household, and a suppressed run reached nobody.
 */
const SUPPRESSED_FIELD_OVERDUE = 'overdueSuppressedAtMs';

/**
 * How long a prefs-suppressed invoice is left alone before the cron tries its
 * overdue notice again. The cron runs daily, so a day means one attempt (and
 * one log line) per day at most, instead of one per run forever, while a
 * household that turns notices back on is picked up on the next run after.
 */
export const OVERDUE_SUPPRESSED_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Notifies on one past-due unpaid invoice doc if not yet notified. Exported for
 * unit testing. Returns true when an overdue notice was enqueued.
 *
 * #832: `overdueNotifiedAtMs` is written only for a notice that reached the
 * household. Three outcomes:
 *   - written: stamp now.
 *   - duplicate: the `onInvoicesWrite` trigger already sent this notice (it
 *     shares the `invoice:<id>` identity) and wrote no stamp of its own, so
 *     stamp the ledger's last-sent time.
 *   - prefs suppressed: no notified stamp, so a later run can send once prefs
 *     allow it; `overdueSuppressedAtMs` skips the invoice for
 *     OVERDUE_SUPPRESSED_RETRY_MS so it is not retried and logged every run.
 */
export async function processOverdueInvoice(
  docSnap: QueryDocumentSnapshot,
  now: number,
): Promise<boolean> {
  const data = docSnap.data() as InvoiceDoc;
  if (isPaid(data)) return false;
  if (data[NOTIFIED_FIELD_OVERDUE]) return false;
  const suppressedAt = data[SUPPRESSED_FIELD_OVERDUE];
  if (typeof suppressedAt === 'number' && now - suppressedAt < OVERDUE_SUPPRESSED_RETRY_MS) return false;
  const dueMs = parseDueMs(data);
  if (dueMs === null) return false;
  if (dueMs >= now) return false;
  const familyId = data.kinfolkId;
  if (!familyId) return false;
  const recipientUid = await resolveKinfolkUid(familyId);
  try {
    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.overdue',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: familyId,
        invoiceId: docSnap.id,
        invoiceDueDate: data.invoiceDueDate ?? null,
        amountMinor: data.amountMinor ?? null,
        currency: data.currency ?? null,
        daysPastDue: Math.floor((now - dueMs) / (24 * 60 * 60 * 1000)),
      },
      fireAtMs: now,
    });
    if (outcome.written.length > 0) {
      await docSnap.ref.set({ [NOTIFIED_FIELD_OVERDUE]: now }, { merge: true });
      return true;
    }
    const duplicate = outcome.suppressed.find((s) => s.reason === 'duplicate');
    if (duplicate) {
      // The trigger's notice already reached this household; record THAT one.
      await docSnap.ref.set({ [NOTIFIED_FIELD_OVERDUE]: duplicate.lastAtMs ?? now }, { merge: true });
    } else {
      await docSnap.ref.set({ [SUPPRESSED_FIELD_OVERDUE]: now }, { merge: true });
    }
    logEvent({
      severity: 'info',
      function: 'invoiceOverdueCron',
      event: duplicate ? 'overdue.already-delivered' : 'overdue.suppressed',
      extra: { familyId, invoiceId: docSnap.id, lastAtMs: duplicate?.lastAtMs ?? null },
    });
    return false;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'invoiceOverdueCron',
      event: 'notification.dispatch.failed',
      extra: { familyId, invoiceId: docSnap.id, err: (err as Error)?.message },
    });
    return false;
  }
}

/**
 * Drains the whole `invoices` collection-group for overdue notices (WARNING-25).
 */
export async function runInvoiceOverdueScan(now: number = Date.now()): Promise<number> {
  let notified = 0;
  await paginateQuery(
    db().collectionGroup('invoices'),
    async (docSnap) => {
      if (await processOverdueInvoice(docSnap, now)) notified += 1;
    },
    { functionName: 'invoiceOverdueCron' },
  );
  return notified;
}

/**
 * Runs daily 09:30 ET. Scans invoices past due and unpaid, enqueues
 * `invoice.overdue` once per invoice.
 */
export const invoiceOverdueCron = onSchedule(
  // Walks overdue invoices and fans out notices. See invoiceRemindersCron.
  {
    schedule: 'every day 09:30',
    timeZone: 'America/New_York',
    secrets: ['SENTRY_DSN'],
    ...FULL_CPU_SERIAL,
  },
  wrapScheduled('invoiceOverdueCron', async () => {
    await runInvoiceOverdueScan(Date.now());
  }),
);
