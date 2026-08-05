/**
 * PUTTING A RECORDED PAYMENT AGAINST ITS INVOICE: the "Apply: $" box on the
 * operator's Add New Transaction screen.
 *
 * ── ONE PAYMENT, ONE INVOICE ──────────────────────────────────────────────
 *
 * Operator ruling, 2026-08-04, on being offered a split across several
 * invoices: "this is not something i want." Her screen agrees: the client had
 * one open invoice, the Applied Invoices block showed one card, and it carried
 * one Apply box. So this module applies one payment to one invoice, and it is
 * deliberately NOT written as the one-element case of a general allocator. A
 * shape that can express a three-way split invites a three-way split.
 *
 * What happens to the remainder is a different mechanism, not a second apply:
 * it becomes account credit. See `lib/accountCredit.ts`.
 *
 * ── WHAT THIS DOES NOT CHANGE ─────────────────────────────────────────────
 *
 * THE MONEY AUTHORITY IS STILL `invoices/{id}/payments`, and the balance is
 * still the sum of that subcollection and nothing else. An apply writes the one
 * subcollection row `markInvoicePaid` writes, and re-derives the settlement the
 * same way. No new arithmetic, no second settlement path, nothing that could
 * disagree with `getInvoiceLedger` or with the stored balance.
 *
 * The one field that is new on that row is `sourcePaymentId`, the id of the
 * root `payments` row the money came in on. It is what ties the display ledger
 * and the authority together: without it, the two rows a single Venmo transfer
 * produces look like two payments.
 *
 * ── THE REFUSALS ARE `markInvoicePaid`'s ──────────────────────────────────
 *
 * Imported, not restated: see the note above `InvoiceDoc` in that file for why
 * a second copy of "what is payable" is the bug this import prevents.
 *
 * ONE REFUSAL IS THIS MODULE'S OWN. `apply_exceeds_payment`: the amount applied
 * is more than the payment has left once its gross tip is set aside. That
 * credits a bill with money that never arrived, and it is the mis-key the
 * Unapplied Balance figure exists to let her catch before saving.
 *
 * ── ONE HOUSEHOLD ─────────────────────────────────────────────────────────
 *
 * The invoice must belong to the payment's own household. A payment applied
 * across two families is not a data-entry variation, it is one family's money
 * settling another's bill, and no screen would ever show why.
 */
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore, WriteBatch } from 'firebase-admin/firestore';

import {
  alreadySettledRefusal,
  isDraftOrQuote,
  refusedLifecycle,
  type InvoiceDoc,
} from '../admin/markInvoicePaid';
import {
  paidCentsFromPayments,
  invoiceTotalCentsOf,
  settleInvoice,
  centsToDollars,
  type PaymentAmount,
  type InvoiceSettlementState,
} from './invoiceMath';
import { invoiceStateStampOf } from './invoiceStateStamp';

/** What the apply did to the invoice, after the write. */
export interface ApplyOutcome {
  invoiceId: string;
  /** Denormalized for display, `''` when the invoice carries no number. */
  invoiceNumber: string;
  /** The `invoices/{id}/payments/{id}` row this apply wrote. */
  paymentId: string;
  appliedCents: number;
  /** Where the invoice stands AFTER the apply, from every recorded payment. */
  state: InvoiceSettlementState;
  totalCents: number;
  paidCents: number;
  amountDueCents: number;
  overpaidCents: number;
}

/** Why the apply was refused. One reason, because there is one invoice. */
export interface ApplyRefusal {
  code: string;
  message: string;
}

/** The refusal a caller turns into one `failed-precondition`, or the plan to commit. */
export type ApplyPlan = { ok: false; refusal: ApplyRefusal } | { ok: true; step: ApplyStep };

/** The planned application: the invoice as read, and the settlement it lands in. */
export interface ApplyStep {
  invoiceId: string;
  invoiceNumber: string;
  doc: InvoiceDoc;
  appliedCents: number;
  before: ReturnType<typeof settleInvoice>;
  after: ReturnType<typeof settleInvoice>;
}

/** An invoice as read from Firestore, paired with its own payment subcollection. */
export interface InvoiceForApply {
  invoiceId: string;
  /** Null when the doc does not exist. Refused by id rather than thrown on. */
  doc: InvoiceDoc | null;
  existingPayments: readonly PaymentAmount[];
}

function invoiceNumberOf(doc: InvoiceDoc): string {
  return typeof doc.invoiceNumber === 'string' ? doc.invoiceNumber : '';
}

/** "$36.00" from integer cents. Local copy; `invoiceMath`'s is not exported. */
function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * THE WHOLE DECISION, as a pure function. No Firestore, so every refusal below
 * is a unit test rather than an emulator run.
 *
 * `spendableCents` is what the payment has to give: the amount collected less
 * its gross tip. Passed in rather than recomputed here, so `paymentMoney.ts`
 * stays the only place the payment identity is written down.
 */
export function planApply(input: {
  invoice: InvoiceForApply;
  appliedCents: number;
  /** The payment's own household. The invoice must match it. */
  kinfolkId: string;
  /** Amount less gross tip: the most that may be applied. */
  spendableCents: number;
}): ApplyPlan {
  const { invoice, appliedCents } = input;

  if (invoice.doc === null) {
    return {
      ok: false,
      refusal: {
        code: 'apply_invoice_not_found',
        message: `Invoice '${invoice.invoiceId}' does not exist, so nothing can be applied to it.`,
      },
    };
  }
  const doc = invoice.doc;
  const label = invoiceNumberOf(doc) || invoice.invoiceId;

  if (appliedCents <= 0) {
    return {
      ok: false,
      refusal: {
        code: 'apply_zero_amount',
        message: `Nothing was entered against invoice ${label}. Enter an amount to apply, or leave the invoice off the payment.`,
      },
    };
  }

  if (appliedCents > input.spendableCents) {
    return {
      ok: false,
      refusal: {
        code: 'apply_exceeds_payment',
        message:
          `${usd(appliedCents)} was applied to invoice ${label}, but this payment has only ` +
          `${usd(input.spendableCents)} to give once its tip is set aside. Lower the applied ` +
          `amount, lower the tip, or raise the payment amount.`,
      },
    };
  }

  // ONE HOUSEHOLD. `''` on the payment means a standalone row belonging to no
  // household, and a standalone payment that applies to an invoice is
  // contradicting itself: the invoice says whose money it is.
  const invoiceKin = typeof doc.kinfolkId === 'string' ? doc.kinfolkId : '';
  if (input.kinfolkId !== '' && invoiceKin !== '' && invoiceKin !== input.kinfolkId) {
    return {
      ok: false,
      refusal: {
        code: 'apply_wrong_household',
        message: `Invoice ${label} belongs to a different household than this payment.`,
      },
    };
  }

  if (isDraftOrQuote(doc)) {
    return {
      ok: false,
      refusal: {
        code: 'apply_invoice_not_sent',
        message: `Invoice ${label} is a draft or quote; send it before applying a payment to it.`,
      },
    };
  }
  const lifecycle = refusedLifecycle(doc);
  if (lifecycle !== null) {
    return { ok: false, refusal: { code: 'apply_invoice_not_payable', message: lifecycle } };
  }

  const existingPaidCents = paidCentsFromPayments(invoice.existingPayments);
  const totalCents = invoiceTotalCentsOf(doc);
  const before = settleInvoice(totalCents, existingPaidCents);

  const settled = alreadySettledRefusal(doc, invoice.existingPayments.length, before.state);
  if (settled !== null) return { ok: false, refusal: settled };

  return {
    ok: true,
    step: {
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoiceNumberOf(doc),
      doc,
      appliedCents,
      before,
      after: settleInvoice(totalCents, existingPaidCents + appliedCents),
    },
  };
}

/** Reads the invoice a plan needs, with its payment subcollection. */
export async function readInvoiceForApply(
  firestore: Firestore,
  invoiceId: string,
): Promise<InvoiceForApply> {
  const ref = firestore.collection('invoices').doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) return { invoiceId, doc: null, existingPayments: [] };
  const paymentsSnap = await ref.collection('payments').get();
  return {
    invoiceId,
    doc: (snap.data() ?? {}) as InvoiceDoc,
    existingPayments: paymentsSnap.docs.map((d) => d.data() as PaymentAmount),
  };
}

/**
 * Stages the application onto a batch, and reports what it did.
 *
 * THE SUBCOLLECTION ROW IS `markInvoicePaid`'s ROW, field for field, plus
 * `sourcePaymentId`. Both denominations are written for the same reason it
 * writes both: `amountCents` is what the settlement was computed from, and
 * `amount` is what the PDF and the Android payments join read.
 *
 * The invoice update is `markInvoicePaid`'s too, including the state stamp in
 * the SAME write as the money it describes (ADR-0002). A stamp written
 * separately opens a window where the money has moved and the stored state
 * still describes the old money.
 */
export function stageApply(
  firestore: Firestore,
  batch: WriteBatch,
  input: {
    step: ApplyStep;
    /** The root `payments` row this money arrived on. The link back. */
    sourcePaymentId: string;
    method: string | null;
    reference: string | null;
    paidAtIso: string;
    uid: string;
  },
): ApplyOutcome {
  const { step } = input;
  const invRef = firestore.collection('invoices').doc(step.invoiceId);
  const paymentRef = invRef.collection('payments').doc();

  batch.set(paymentRef, {
    amount: centsToDollars(step.appliedCents),
    amountCents: step.appliedCents,
    method: input.method,
    reference: input.reference,
    paidAt: input.paidAtIso,
    recordedBy: input.uid,
    // THE LINK BACK, so the display row in the root ledger and the settlement
    // row in the authority read as one payment rather than two.
    sourcePaymentId: input.sourcePaymentId,
    createdAt: FieldValue.serverTimestamp(),
  });

  const settling = step.after.state === 'settled' || step.after.state === 'overpaid';
  const invoiceUpdate = {
    status: settling ? 'paid' : 'open',
    paymentStatus: settling ? 'PAID' : 'PARTIAL',
    totalCents: step.after.totalCents,
    paidCents: step.after.paidCents,
    amountDueCents: step.after.amountDueCents,
    overpaidCents: step.after.overpaidCents,
    amountDue: centsToDollars(step.after.amountDueCents),
    paymentMethod: input.method,
    paymentReference: input.reference,
    ...(settling ? { paidAt: FieldValue.serverTimestamp(), paidBy: input.uid } : {}),
    lastPaymentAt: FieldValue.serverTimestamp(),
    lastPaymentBy: input.uid,
    updatedAt: FieldValue.serverTimestamp(),
  };

  batch.set(
    invRef,
    { ...invoiceUpdate, ...invoiceStateStampOf({ ...step.doc, ...invoiceUpdate }, step.after.paidCents) },
    { merge: true },
  );

  return {
    invoiceId: step.invoiceId,
    invoiceNumber: step.invoiceNumber,
    paymentId: paymentRef.id,
    appliedCents: step.appliedCents,
    state: step.after.state,
    totalCents: step.after.totalCents,
    paidCents: step.after.paidCents,
    amountDueCents: step.after.amountDueCents,
    overpaidCents: step.after.overpaidCents,
  };
}
