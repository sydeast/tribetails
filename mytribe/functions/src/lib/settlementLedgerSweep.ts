/**
 * #2230: FINISHES A `markInvoicePaid` SETTLEMENT WHOSE SECOND CALL NEVER CAME.
 *
 * Admin builds installed before #2269 record a payment as two calls:
 * `markInvoicePaid` pays the bill, then `recordPayment` writes the root
 * `payments` ledger row and sends `invoice.payment.applied`. A reload or a
 * closed app between the two left an invoice reading paid, with no ledger row
 * and nobody told. (The current admin clients make one `recordPayment` call
 * with an `apply`, which does all three in one transaction.)
 *
 * The settling `markInvoicePaid` write stamps `settlementLedgerPending` with its
 * owner, and the `recordPayment` that claims the settlement clears it. One still
 * pending after SETTLEMENT_LEDGER_SWEEP_GRACE_MS had no second call, and this
 * pass, run by `notificationScheduledSweep` every 5 minutes, does that call's
 * two jobs:
 *
 *   1. THE LEDGER ROW, in one transaction with the claim. Created at a fixed id
 *      made from the settlement row's id (`settle_<id>`), so two sweeps racing,
 *      or a sweep re-run after a failed notice, write it once. It is built from
 *      the settlement row alone: the applied amount, method and reference. The
 *      tip and fee the second call would have carried were never sent to the
 *      server, so the row says nothing about them (`tipBasis: 'unknown'`).
 *      Setting the claim in the same commit stops a late second call claiming
 *      the settlement again.
 *   2. THE NOTICE, after the commit: the unticked payoff (#1973), which is the
 *      household's notifications list with nothing emailed, plus the office.
 *      Whether the admin ticked Send Confirmation was never sent either, and the
 *      list-only copy is what an unticked payoff gets. Sent under the ledger
 *      row's id with the same 7 day ledger window `recordPayment` uses, so a
 *      re-run sends nothing twice.
 *
 * The pending stamp is cleared only once the notice is done (delivered, or
 * nobody exists to receive it). A notice that fails is left pending and tried
 * on the next run, up to SETTLEMENT_LEDGER_MAX_ATTEMPTS, then given up and
 * logged; the ledger row stays.
 *
 * WHAT IT CANNOT CATCH. A settlement that left a balance (a partial) stamps
 * nothing, because nothing is owed to anyone until it is paid off and an
 * unticked partial tells nobody. And a pre-#866 client whose second call lands
 * more than OLD_CLIENT_CLAIM_WINDOW_MS late writes its own row without claiming,
 * so a row the sweep wrote first is then joined by a second one for the same
 * payment. The grace is twice that window to keep this to a call that is late
 * by many minutes.
 */
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';

import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
import { centsToDollars, paidCentsFromPayments, type PaymentAmount } from './invoiceMath';
import {
  PAYMENT_APPLIED_CLAIM_FIELD,
  SETTLEMENT_LEDGER_PENDING_AT_FIELD,
  SETTLEMENT_LEDGER_PENDING_FIELD,
  SETTLEMENT_LEDGER_SWEEP_GRACE_MS,
} from './paymentAppliedOwner';

/** Tries per abandoned settlement before it is given up: about an hour at one run every 5 minutes. */
export const SETTLEMENT_LEDGER_MAX_ATTEMPTS = 12;
export const SETTLEMENT_LEDGER_ATTEMPTS_FIELD = 'settlementLedgerAttempts';
/** Stamped `'gave-up'` when the notice could not go out after the cap. */
export const SETTLEMENT_LEDGER_SKIPPED_FIELD = 'settlementLedgerSkippedReason';
/** The share of the sweep's 60 second run this pass may use, the same split the credit notice pass keeps. */
export const SETTLEMENT_LEDGER_SWEEP_BUDGET_MS = 15 * 1000;

const SWEEP_LIMIT = 50;
const OWNER_PREFIX = 'markInvoicePaid:';

/** The root `payments` id the sweep writes for one settlement row. */
export function settlementLedgerRowId(settlementPaymentId: string): string {
  return `settle_${settlementPaymentId}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The settled-on date as the ledger's free-text `date`: the day part of the stored ISO time, or '' . */
function ledgerDateOf(paidAt: unknown): string {
  const s = str(paidAt);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

type Staged =
  | { kind: 'gone' }
  | { kind: 'claimed' }
  | {
      kind: 'ready';
      owner: string;
      kinfolkId: string;
      invoiceNumber: string;
      rowId: string;
      created: boolean;
      amountCents: number;
      recordedBy: string;
      attempts: number;
    };

/**
 * Step 1 for one invoice, in a transaction: the ledger row (once) and the
 * claim. Every read before every write. Returns what the notice needs, or why
 * there is nothing to do.
 */
async function stageLedgerRow(firestore: Firestore, invoiceId: string): Promise<Staged> {
  const invRef = firestore.collection('invoices').doc(invoiceId);
  return firestore.runTransaction(async (tx): Promise<Staged> => {
    const snap = await tx.get(invRef);
    const inv = (snap.data() ?? {}) as Record<string, unknown>;
    const owner = inv[SETTLEMENT_LEDGER_PENDING_FIELD];
    if (!snap.exists || typeof owner !== 'string' || !owner.startsWith(OWNER_PREFIX)) return { kind: 'gone' };
    const settlementId = owner.slice(OWNER_PREFIX.length);
    const settlementRef = invRef.collection('payments').doc(settlementId);
    const rowRef = firestore.collection('payments').doc(settlementLedgerRowId(settlementId));
    const settlementSnap = await tx.get(settlementRef);
    const rowSnap = await tx.get(rowRef);
    const clear = {
      [SETTLEMENT_LEDGER_PENDING_FIELD]: '',
      [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null,
    };
    // Claimed by a second call this sweep did not write: that call owns the row
    // and the notice. (The current `recordPayment` clears the stamp itself.)
    if (inv[PAYMENT_APPLIED_CLAIM_FIELD] === owner && !rowSnap.exists) {
      tx.set(invRef, clear, { merge: true });
      return { kind: 'claimed' };
    }
    const kinfolkId = str(inv['kinfolkId']);
    // No settlement row or no household: nothing to build a row from or to tell.
    if (!settlementSnap.exists || kinfolkId === '') {
      tx.set(invRef, { ...clear, [SETTLEMENT_LEDGER_SKIPPED_FIELD]: 'nothing-to-record' }, { merge: true });
      return { kind: 'gone' };
    }
    const settlement = (settlementSnap.data() ?? {}) as Record<string, unknown>;
    const amountCents = paidCentsFromPayments([settlement as PaymentAmount]);
    const invoiceNumber = str(inv['invoiceNumber']);
    const recordedBy = str(settlement['recordedBy']);
    const rawAttempts = inv[SETTLEMENT_LEDGER_ATTEMPTS_FIELD];
    const attempts = (typeof rawAttempts === 'number' && Number.isFinite(rawAttempts) ? rawAttempts : 0) + 1;
    if (!rowSnap.exists) {
      // The shape `recordPayment` writes for the second of the two calls, from
      // what the settlement row knows. `appliedInvoiceId` stays '' as it does
      // there: `markInvoicePaid` moved the balance, not this row.
      tx.create(rowRef, {
        kinfolkId,
        kinfolkName: str(inv['kinfolkName']),
        client: str(inv['client']),
        address: '',
        date: ledgerDateOf(settlement['paidAt']),
        paymentMethod: str(settlement['method']),
        referenceNumber: str(settlement['reference']),
        email: '',
        amount: centsToDollars(amountCents),
        tip: 0,
        notes: '',
        invoiceId,
        invoiceNumber,
        fee: 0,
        feeCents: 0,
        tipCents: 0,
        amountCents,
        // Not 'gross': no tip was sent to the server for this payment, so the
        // row cannot say there was none.
        tipBasis: 'unknown',
        appliedInvoiceId: '',
        appliedInvoiceNumber: '',
        appliedCents: amountCents,
        unappliedCents: 0,
        proceedsCents: amountCents,
        autoApply: false,
        creditedToAccountCents: 0,
        settledByInvoicePaymentId: settlementId,
        recordedBy,
        createdAt: FieldValue.serverTimestamp(),
        application: null,
        settlesInvoice: true,
        confirmationEmailSent: false,
        confirmationAppOnly: false,
        // Which writer made it, for anyone reading the row later.
        recordedByServer: 'settlementLedgerSweep',
      });
    }
    tx.set(
      invRef,
      { [PAYMENT_APPLIED_CLAIM_FIELD]: owner, [SETTLEMENT_LEDGER_ATTEMPTS_FIELD]: attempts },
      { merge: true },
    );
    return {
      kind: 'ready',
      owner,
      kinfolkId,
      invoiceNumber,
      rowId: rowRef.id,
      created: !rowSnap.exists,
      amountCents,
      recordedBy,
      attempts,
    };
  });
}

/** Clears the pending stamp, only while it is still this settlement's. */
async function clearPending(
  firestore: Firestore,
  invoiceId: string,
  owner: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const invRef = firestore.collection('invoices').doc(invoiceId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(invRef);
    if ((snap.data() ?? {})[SETTLEMENT_LEDGER_PENDING_FIELD] !== owner) return;
    tx.set(
      invRef,
      { ...extra, [SETTLEMENT_LEDGER_PENDING_FIELD]: '', [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null },
      { merge: true },
    );
  });
}

/**
 * Finishes one abandoned settlement. NEVER THROWS: a failure is left pending
 * for the next run. True when this call finished it (its notice done, or given
 * up); false when it is left for the next run, or there was nothing to finish.
 */
export async function finishAbandonedSettlement(firestore: Firestore, invoiceId: string): Promise<boolean> {
  let staged: Staged;
  try {
    staged = await stageLedgerRow(firestore, invoiceId);
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'settlementLedgerSweep',
      event: 'settlement.ledger.stage.failed',
      extra: { invoiceId, err: (err as Error)?.message },
    });
    return false;
  }
  if (staged.kind !== 'ready') return false;

  const extra = { invoiceId, kinfolkId: staged.kinfolkId, paymentId: staged.rowId };
  if (staged.created) {
    logEvent({ severity: 'warn', function: 'settlementLedgerSweep', event: 'settlement.ledger.recovered', extra });
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.BILLING_PAYMENT_RECORDED,
      severity: 'info',
      actorRole: 'SYSTEM',
      targetUid: staged.rowId,
      targetCollection: 'payments',
      familyId: staged.kinfolkId,
      description:
        `Payment ledger row recorded for invoice ${staged.invoiceNumber || invoiceId}: ` +
        'the app stopped after paying it off and before recording the row',
      payload: {
        paymentId: staged.rowId,
        kinfolkId: staged.kinfolkId,
        invoiceId,
        amountCents: staged.amountCents,
        recordedBy: staged.recordedBy,
        recoveredBy: 'settlementLedgerSweep',
      },
      // A fixed id, so a re-run after a failed notice cannot write it twice.
      docId: `payment_recorded_${staged.rowId}`,
    }).catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'settlementLedgerSweep',
        event: 'audit.write.failed',
        extra: { ...extra, err: (err as Error)?.message },
      });
    });
  }

  // Loaded here so the scheduled sweep's cold start does not pay for the
  // callable module until there is an abandoned settlement to finish.
  const { sendPaymentConfirmation, noticeStamps } = await import('../admin/recordPayment.js');
  const sent = await sendPaymentConfirmation({
    kinfolkId: staged.kinfolkId,
    invoiceId,
    paymentId: staged.rowId,
    uid: staged.recordedBy || 'system:settlement-ledger-sweep',
    householdRequested: false,
    settlesInvoice: true,
    officeDue: true,
    householdOnPayoff: true,
  });
  const done = (sent.household || sent.office || sent.skipped === true) && !sent.officePending;
  try {
    if (sent.household || sent.office || sent.skipped) {
      await firestore.collection('payments').doc(staged.rowId).update(noticeStamps(sent));
    }
    if (done) {
      await clearPending(firestore, invoiceId, staged.owner);
      return true;
    }
    if (staged.attempts >= SETTLEMENT_LEDGER_MAX_ATTEMPTS) {
      await clearPending(firestore, invoiceId, staged.owner, { [SETTLEMENT_LEDGER_SKIPPED_FIELD]: 'gave-up' });
      logEvent({
        severity: 'error',
        function: 'settlementLedgerSweep',
        event: 'settlement.notice.gave_up',
        extra: { ...extra, attempts: staged.attempts },
      });
      return true;
    }
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'settlementLedgerSweep',
      event: 'settlement.ledger.stamp.failed',
      extra: { ...extra, err: (err as Error)?.message },
    });
  }
  return false;
}

export interface SettlementLedgerSweepOptions {
  budgetMs?: number;
  clock?: () => number;
}

/**
 * Every settlement still pending after SETTLEMENT_LEDGER_SWEEP_GRACE_MS,
 * oldest first. A range filter and an order on one field need no composite
 * index, and a finished settlement sets the field to null, which no numeric
 * range matches, so it is never fetched again. Returns how many it finished.
 */
export async function sweepAbandonedSettlements(
  firestore: Firestore,
  nowMs: number,
  options: SettlementLedgerSweepOptions = {},
): Promise<number> {
  const budgetMs = options.budgetMs ?? SETTLEMENT_LEDGER_SWEEP_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const snap = await firestore
    .collection('invoices')
    .where(SETTLEMENT_LEDGER_PENDING_AT_FIELD, '<', nowMs - SETTLEMENT_LEDGER_SWEEP_GRACE_MS)
    .orderBy(SETTLEMENT_LEDGER_PENDING_AT_FIELD)
    .limit(SWEEP_LIMIT)
    .get();
  let finished = 0;
  for (const doc of snap.docs) {
    if (clock() - startedAt >= budgetMs) break;
    if (await finishAbandonedSettlement(firestore, doc.id)) finished += 1;
  }
  return finished;
}
