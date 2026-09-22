import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotificationDetailed } from '../notifications/dispatcher';
import { INVOICE_REMINDER_RESEND_WINDOW_MS } from '../admin/sendInvoiceReminder';
import { paginateQuery } from '../lib/paginateCollectionGroup';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';
import { businessTodayIso } from '../lib/quoteDecision';
import { paidCentsFromPayments } from '../lib/invoiceMath';
import {
  chaseRefusalOf,
  daysPastDue,
  invoiceDueDayOf,
  isDueWithin,
  legacyEvidenceWanted,
  type ChaseRefusal,
  type PaymentEvidence,
} from '../lib/invoiceChase';

/**
 * #871: THE ONE SENDER OF `invoice.overdue` IS `invoiceOverdueCron`, below.
 *
 * Overdue is a function of the clock. No write happens when a due date passes,
 * so a document trigger cannot see the moment an invoice falls due, and no
 * server writer stamps a `past_due`/`overdue` status (the state stamp writes
 * only the eight classifier states). `onInvoicesWrite` used to carry a branch
 * for that label; it could only fire on a hand-written label, and it is gone.
 * The admin clients compute Overdue the same way this cron does: stored state
 * `open`, due day strictly before today.
 *
 * WHICH INVOICES. Both scans read the top-level `invoices` collection, the store
 * every admin client, every billing callable and the portal read and write. They
 * used to scan `collectionGroup('invoices')`, which also matched the retired
 * `families/{id}/invoices` path. NOTHING writes that path any more: no
 * production writer ever did, and `scripts/seedDemoKinfolk.ts` stopped in #932.
 * That seed used to write a nested copy alongside the flat doc, and it was the
 * reason a demo household could be chased twice. Reading only the live
 * store means a copy left under the retired path by an older seed run can
 * never be chased as a second invoice, and the flat doc is chased once.
 *
 * WHICH DAY. "Today" is the business's own calendar day (`businessTodayIso`),
 * not the UTC day this function runs on, and a due day counts as overdue only
 * when it is strictly before today, as every client counts it. That helper
 * falls back to the ruled `America/Chicago` when the settings doc carries no
 * usable zone, so `runDay` returning null needs BOTH zones to fail in `Intl`:
 * a scan that cannot name the day sends nothing rather than guess it.
 *
 * CADENCE, as it exists today and kept: one due-soon reminder per invoice (this
 * cron, due today or within REMINDER_WINDOW_DAYS; or a button press, which the
 * cron then honours), and one overdue notice per invoice, ever. No catalog key,
 * template or setting describes a second overdue notice, so there is none.
 */
const REMINDER_WINDOW_DAYS = 3;
const NOTIFIED_FIELD_REMINDER = 'reminderNotifiedAtMs';
const NOTIFIED_FIELD_OVERDUE = 'overdueNotifiedAtMs';

/**
 * How far back the dispatcher's ledger looks for an earlier overdue notice
 * (#871). The `overdueNotifiedAtMs` stamp is the once-ever gate; this is the
 * crash net under it. A run that delivered and died before stamping is met by
 * the ledger on every rerun inside the window, which records that delivery
 * instead of sending a second one. Seven days, as #884's credit notice uses,
 * so a week of failed stamp writes still cannot send twice.
 */
export const OVERDUE_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The event id of an invoice's overdue notice. Stable across trigger
 * redelivery, cron reruns and concurrent runs, because one invoice has one
 * overdue period. It replaces the dispatcher's derived identity.
 */
export function overdueDedupeKey(invoiceId: string): string {
  return `invoice:${invoiceId}:overdue`;
}

type InvoiceDoc = {
  status?: string;
  dueDate?: string;
  invoiceDueDate?: string;
  amountDue?: number;
  amountMinor?: number;
  currency?: string;
  kinfolkId?: string;
  [k: string]: unknown;
};

/**
 * Reads the invoice's payment rows ONLY for the legacy total-only shape, the
 * one state the classifier cannot settle without them (lib/invoiceChase.ts).
 * Every other invoice is decided from the doc alone and costs no extra read.
 *
 * #902: the rows go to the classifier now, not to a refusal branch beside it.
 * The reading they change is the same one: a migrated bill whose rows cover its
 * total is settled and is not chased; one with no rows owes its total and is.
 */
async function chaseRefusal(docSnap: QueryDocumentSnapshot, data: InvoiceDoc): Promise<ChaseRefusal | null> {
  let evidence: PaymentEvidence | null = null;
  if (legacyEvidenceWanted(data)) {
    const rows = await docSnap.ref.collection('payments').get();
    evidence = {
      rows: rows.size,
      paidCents: paidCentsFromPayments(rows.docs.map((d) => d.data() as { amount?: number; amountCents?: number })),
    };
  }
  return chaseRefusalOf(data, evidence);
}

/**
 * Reminds on one invoice doc if it is a live bill, due today or within the
 * reminder window, and not yet reminded. Exported for unit testing of the
 * per-doc decision. Returns true when a reminder was enqueued.
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
  todayIso: string,
): Promise<boolean> {
  const data = docSnap.data() as InvoiceDoc;
  if (data[NOTIFIED_FIELD_REMINDER]) return false;
  const dueDay = invoiceDueDayOf(data);
  if (!isDueWithin(dueDay, todayIso, REMINDER_WINDOW_DAYS)) return false;
  const familyId = data.kinfolkId;
  if (!familyId) return false;
  if (await chaseRefusal(docSnap, data)) return false;
  const recipientUid = await resolveKinfolkUid(familyId);
  try {
    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.reminder',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: familyId,
        invoiceId: docSnap.id,
        invoiceDueDate: data.invoiceDueDate ?? data.dueDate ?? null,
        amountMinor: data.amountMinor ?? null,
        currency: data.currency ?? null,
      },
      targetType: 'invoice',
      targetId: docSnap.id,
      fireAtMs: now,
      // #832: look back the reminder button's whole window, as the button does.
      // A press that delivered and lost its stamp an hour ago is past the
      // dispatcher's 5-minute default; with the default this run would send a
      // second reminder instead of recording the first.
      dedupeWindowMs: INVOICE_REMINDER_RESEND_WINDOW_MS,
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
 * The business's calendar day for this run, or null (logged) when no zone can
 * be resolved. A scan with no day sends nothing: guessing the day is how "due
 * today" gets called overdue.
 */
async function runDay(now: number, functionName: string): Promise<string | null> {
  const todayIso = await businessTodayIso(db(), now);
  if (todayIso !== '') return todayIso;
  logEvent({ severity: 'error', function: functionName, event: 'business.day.unresolved', extra: { now } });
  return null;
}

/**
 * Drains the top-level `invoices` collection, page by page (WARNING-25): the
 * old single `.limit(1000)` never reminded any invoice past the cap. Exported
 * so a test can drive the full scan against a paged mock.
 */
export async function runInvoiceRemindersScan(now: number = Date.now()): Promise<number> {
  const todayIso = await runDay(now, 'invoiceRemindersCron');
  if (todayIso === null) return 0;
  let reminded = 0;
  await paginateQuery(
    db().collection('invoices'),
    async (docSnap) => {
      if (await processReminderInvoice(docSnap, now, todayIso)) reminded += 1;
    },
    { functionName: 'invoiceRemindersCron' },
  );
  return reminded;
}

/**
 * Runs daily 09:00 ET. Scans live bills due today or within
 * REMINDER_WINDOW_DAYS and not yet reminded, and enqueues `invoice.reminder`
 * once per invoice.
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
 * When this invoice's overdue notice was last suppressed (ms epoch). Kept apart
 * from `overdueNotifiedAtMs` on purpose (#832): that stamp means a notice
 * reached the household, and a suppressed run reached nobody.
 *
 * WHO CAN SUPPRESS IT. Not the household: `invoice.overdue` has catalog-required
 * email, and `resolveChannels` puts a required channel above the recipient's
 * own prefs. Two things can:
 *
 *   - the OPERATOR, by disabling the notification (or its email channel along
 *     with the others) in the business notification override. (`alwaysEnabled`
 *     on the row is advisory and enforces nothing.) Reported as `reason: 'prefs'`.
 *   - the PRE-LAUNCH HOUSEHOLD GATE (notifications/householdSendGate.ts), which
 *     holds back every household-bound copy until the operator opens the
 *     product. Reported as `reason: 'gate'`.
 *
 * Both belong here and neither may write `overdueNotifiedAtMs`, because neither
 * delivered anything. They are kept distinguishable in the log line below
 * because the expected duration differs by orders of magnitude: a gate
 * suppression can stand for weeks, and every invoice it held back is still owed
 * its notice on the day the gate opens.
 *
 * THE RETRY WINDOW IS RIGHT FOR BOTH. This field is a backoff, never a record of
 * delivery: `OVERDUE_SUPPRESSED_RETRY_MS` is under one run period, so a gated
 * invoice is retried by the next daily run and goes out on the first run after
 * the operator flips the gate. What would break the launch is stamping
 * `overdueNotifiedAtMs` instead, and nothing on this path does.
 */
const SUPPRESSED_FIELD_OVERDUE = 'overdueSuppressedAtMs';

/**
 * How long a suppressed invoice is left alone before the cron tries its overdue
 * notice again: at most one attempt (and one log line) per daily run, instead
 * of one per run forever, and the notice goes out on the first run after the
 * operator turns it back on.
 *
 * DELIBERATELY SHORTER THAN THE 24-HOUR RUN PERIOD. Equal to it, a run that
 * starts a little early, or the 23-hour day when clocks spring forward, would
 * fall inside the wait and skip a whole extra day.
 */
export const OVERDUE_SUPPRESSED_RETRY_MS = 20 * 60 * 60 * 1000;

/**
 * Notifies on one overdue live bill if not yet notified. Exported for unit
 * testing. Returns true when an overdue notice was enqueued.
 *
 * #832: `overdueNotifiedAtMs` is written only for a notice that reached the
 * household. Three outcomes:
 *   - written: stamp now.
 *   - duplicate (#871): an earlier run delivered this invoice's notice, under
 *     the same `overdueDedupeKey`, and its stamp write did not land. Stamp the
 *     ledger's last-sent time; send nothing.
 *   - suppressed (only by an operator override; see SUPPRESSED_FIELD_OVERDUE):
 *     no notified stamp, so a later run sends once the operator turns the
 *     notice back on; `overdueSuppressedAtMs` skips the invoice for
 *     OVERDUE_SUPPRESSED_RETRY_MS so it is not retried and logged every run.
 */
export async function processOverdueInvoice(
  docSnap: QueryDocumentSnapshot,
  now: number,
  todayIso: string,
): Promise<boolean> {
  const data = docSnap.data() as InvoiceDoc;
  if (data[NOTIFIED_FIELD_OVERDUE]) return false;
  const suppressedAt = data[SUPPRESSED_FIELD_OVERDUE];
  if (typeof suppressedAt === 'number' && now - suppressedAt < OVERDUE_SUPPRESSED_RETRY_MS) return false;
  const pastDue = daysPastDue(invoiceDueDayOf(data), todayIso);
  if (pastDue === null) return false;
  const familyId = data.kinfolkId;
  if (!familyId) return false;
  if (await chaseRefusal(docSnap, data)) return false;
  const recipientUid = await resolveKinfolkUid(familyId);
  try {
    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.overdue',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: familyId,
        invoiceId: docSnap.id,
        invoiceDueDate: data.invoiceDueDate ?? data.dueDate ?? null,
        amountMinor: data.amountMinor ?? null,
        currency: data.currency ?? null,
        daysPastDue: pastDue,
      },
      targetType: 'invoice',
      targetId: docSnap.id,
      fireAtMs: now,
      dedupeKey: overdueDedupeKey(docSnap.id),
      dedupeWindowMs: OVERDUE_DEDUPE_WINDOW_MS,
    });
    if (outcome.written.length > 0) {
      await docSnap.ref.set({ [NOTIFIED_FIELD_OVERDUE]: now }, { merge: true });
      return true;
    }
    const duplicate = outcome.suppressed.find((s) => s.reason === 'duplicate');
    if (duplicate) {
      // An earlier run's notice already reached this household; record THAT one.
      await docSnap.ref.set({ [NOTIFIED_FIELD_OVERDUE]: duplicate.lastAtMs ?? now }, { merge: true });
    } else {
      await docSnap.ref.set({ [SUPPRESSED_FIELD_OVERDUE]: now }, { merge: true });
    }
    logEvent({
      severity: 'info',
      function: 'invoiceOverdueCron',
      event: duplicate ? 'overdue.already-delivered' : 'overdue.suppressed',
      extra: {
        familyId,
        invoiceId: docSnap.id,
        lastAtMs: duplicate?.lastAtMs ?? null,
        // The dispatcher's own words for why. Without this the log cannot tell
        // an operator override from the pre-launch gate, and those want
        // different responses: one is a setting the operator chose, the other
        // is the whole product still being shut.
        reasons: outcome.suppressed.map((s) => s.reason),
      },
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
 * Drains the top-level `invoices` collection for overdue notices (WARNING-25).
 */
export async function runInvoiceOverdueScan(now: number = Date.now()): Promise<number> {
  const todayIso = await runDay(now, 'invoiceOverdueCron');
  if (todayIso === null) return 0;
  let notified = 0;
  await paginateQuery(
    db().collection('invoices'),
    async (docSnap) => {
      if (await processOverdueInvoice(docSnap, now, todayIso)) notified += 1;
    },
    { functionName: 'invoiceOverdueCron' },
  );
  return notified;
}

/**
 * Runs daily 09:30 ET. Scans live bills whose due day has passed, and enqueues
 * `invoice.overdue` once per invoice. The only sender of that notice (#871).
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
