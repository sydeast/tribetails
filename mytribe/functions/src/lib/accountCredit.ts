/**
 * ACCOUNT CREDIT: money a household has paid that is not against any bill yet,
 * and the auto-apply that spends it on the next one.
 *
 * ── WHERE THE CREDIT LIVES, AND WHY NOT SOMEWHERE NEW ─────────────────────
 *
 * `families/{kinfolkId}.accountBalanceCents`. THIS FIELD ALREADY EXISTS and
 * this module deliberately does not put a second credit ledger beside it:
 *
 *   `portal/redeemCredit.ts`   writes it. A credit invoice is redeemed by
 *                              bumping this balance, and account balance is the
 *                              ONLY destination there is. Operator ruling,
 *                              2026-07-20, mirrored in the portal mockup named
 *                              `...NoRefundtoOP-onlyAccountCredit.html`. Money
 *                              that cannot go back to a card becomes credit.
 *   `portal/getMyInvoices.ts`  reads it and ships it to the household.
 *   `web/src/screens/Invoices` renders it as their spendable balance.
 *
 * So "money held for a household, to spend on future care" is a solved concept
 * here, with a ruling behind it and a surface already showing it. The operator's
 * Unapplied Balance is the same thing arriving by a different door.
 *
 * ── WHAT THIS MODULE EXTENDS ──────────────────────────────────────────────
 *
 * The existing mechanism could only FILL the balance. Nothing in the repo ever
 * spent it: `accountBalanceCents` went up when a credit was redeemed and then
 * sat there, visible to the household and unusable by anything. A balance that
 * can only grow is not a credit, it is a number on a screen.
 *
 * Two additions, and they are the whole extension:
 *
 *   `creditAccount`     puts a payment's unapplied remainder into the balance,
 *                       so auto-apply routes through the existing ledger rather
 *                       than inventing a parallel one.
 *   `drawAccountCredit` takes it back out onto an invoice that is owed. This is
 *                       the consumer that did not exist.
 *
 * ── "APPLY ANY UNAPPLIED AMOUNT TO FUTURE INVOICES" ───────────────────────
 *
 * The operator's own label is the specification, and the important word is
 * FUTURE. The remainder is not split across today's bills; it is held, and
 * consumed later against invoices that do not exist yet, one at a time. So:
 *
 *   at record time    the remainder goes into the balance, if she ticked the box
 *   at invoice time   `triggers/onInvoiceAutoApply.ts` draws it back down when
 *                     an invoice BECOMES collectable
 *   on demand         `admin/runAutoApply.ts`, the same pass, for the invoice
 *                     that already existed when she ticked the box
 *
 * ── WHY IT CANNOT LOOP, AND CANNOT OVERDRAW ───────────────────────────────
 *
 * The trigger writes to the collection it watches. It terminates because it
 * fires only on the TRANSITION into collectable: after a draw the invoice was
 * already collectable before that write, so the next invocation returns at the
 * transition check. The money bounds it too: every draw decrements the
 * balance, and a draw is never larger than the smaller of the balance and what
 * the invoice is owed, so auto-apply can neither overdraw an account nor turn
 * a bill into an overpayment the household did not choose to make.
 */
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore, WriteBatch } from 'firebase-admin/firestore';

import {
  isDraftOrQuote,
  refusedLifecycle,
  alreadySettledRefusal,
  type InvoiceDoc,
} from '../admin/markInvoicePaid';
import {
  paidCentsFromPayments,
  invoiceTotalCentsOf,
  settleInvoice,
  centsToDollars,
  type PaymentAmount,
} from './invoiceMath';
import { invoiceStateStampOf } from './invoiceStateStamp';
import { logEvent } from './logger';

/** The stored balance field. Named once so every reader and writer agrees. */
export const ACCOUNT_BALANCE_FIELD = 'accountBalanceCents';

/**
 * The method stamped on a subcollection row paid out of account credit.
 *
 * A LITERAL, not the original payment's method. The household did not hand over
 * a second Venmo transfer; credit they already had was moved onto a new bill,
 * and a row saying "venmo" would have an operator hunting for a transfer that
 * never happened.
 */
export const ACCOUNT_CREDIT_METHOD = 'account credit';

/** Reads a stored balance. Anything unreadable is no credit, never a negative one. */
export function readAccountBalanceCents(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : 0;
}

/**
 * Adds a payment's unapplied remainder to the household's balance, on a batch
 * the caller also writes the payment row on.
 *
 * `increment` rather than read-then-write. Two payments recorded in the same
 * second would otherwise each write the balance they had read, and one of the
 * two credits would vanish. `redeemCredit` gets away with read-then-write
 * because it runs inside a transaction; this runs inside a batch alongside the
 * payment it belongs to, and the two must land together.
 */
export function creditAccount(
  firestore: Firestore,
  batch: WriteBatch,
  input: { kinfolkId: string; cents: number },
): void {
  if (input.kinfolkId === '' || input.cents <= 0) return;
  batch.set(
    firestore.collection('families').doc(input.kinfolkId),
    {
      [ACCOUNT_BALANCE_FIELD]: FieldValue.increment(input.cents),
      accountBalanceUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * How much credit to spend on this invoice. PURE, so every boundary below is a
 * unit test.
 *
 * The smaller of what is owed and what is held, never more. Auto-apply cannot
 * create an overpayment: an overpayment is a decision a household makes, and
 * `settleInvoice` treats it as an excess to act on rather than a credit, so
 * manufacturing one here would put the operator in front of a number she has to
 * unpick.
 */
export function planCreditDraw(input: {
  amountDueCents: number;
  accountBalanceCents: number;
}): number {
  const owed = Math.max(0, Math.round(input.amountDueCents));
  const held = Math.max(0, Math.round(input.accountBalanceCents));
  return Math.min(owed, held);
}

/**
 * Can this invoice take credit at all?
 *
 * The SAME refusals `markInvoicePaid` applies to a manual payment, imported
 * rather than restated. Credit landing on a cancelled invoice or a credit note
 * is exactly as wrong when a trigger did it, and worse, because nobody was
 * watching.
 */
export function invoiceAcceptsCredit(
  doc: InvoiceDoc,
  existingPayments: readonly PaymentAmount[],
): boolean {
  if (isDraftOrQuote(doc)) return false;
  if (refusedLifecycle(doc) !== null) return false;
  const settlement = settleInvoice(
    invoiceTotalCentsOf(doc),
    paidCentsFromPayments(existingPayments),
  );
  if (alreadySettledRefusal(doc, existingPayments.length, settlement.state) !== null) return false;
  return settlement.amountDueCents > 0;
}

/** What one auto-apply pass did. Every `skipped` value is a normal outcome. */
export interface AutoApplyResult {
  invoiceId: string;
  skipped:
    | null
    | 'invoice_missing'
    | 'invoice_not_collectable'
    | 'no_household'
    | 'no_credit';
  /** Credit moved onto the invoice. */
  appliedCents: number;
  /** The household's remaining balance afterwards. */
  accountBalanceCents: number;
  /** The invoice's balance afterwards. */
  amountDueCents: number;
}

/**
 * ONE PASS over one invoice: draw the household's credit down onto it.
 *
 * The invoice, its subcollection row and the family balance move together in a
 * single batch or not at all. A half-commit would spend a household's credit
 * without crediting their bill, which is the same money vanishing that the
 * dropped fee was.
 */
export async function drawAccountCredit(
  firestore: Firestore,
  input: { invoiceId: string; actorUid: string },
): Promise<AutoApplyResult> {
  const nothing = (
    skipped: NonNullable<AutoApplyResult['skipped']>,
    over: Partial<AutoApplyResult> = {},
  ): AutoApplyResult => ({
    invoiceId: input.invoiceId,
    skipped,
    appliedCents: 0,
    accountBalanceCents: 0,
    amountDueCents: 0,
    ...over,
  });

  const invRef = firestore.collection('invoices').doc(input.invoiceId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) return nothing('invoice_missing');
  const doc = (invSnap.data() ?? {}) as InvoiceDoc;

  const kinfolkId = typeof doc.kinfolkId === 'string' ? doc.kinfolkId : '';
  if (kinfolkId === '') return nothing('no_household');

  const paymentsSnap = await invRef.collection('payments').get();
  const existingPayments = paymentsSnap.docs.map((d) => d.data() as PaymentAmount);
  if (!invoiceAcceptsCredit(doc, existingPayments)) return nothing('invoice_not_collectable');

  const before = settleInvoice(invoiceTotalCentsOf(doc), paidCentsFromPayments(existingPayments));

  const famRef = firestore.collection('families').doc(kinfolkId);
  const famSnap = await famRef.get();
  const heldCents = readAccountBalanceCents(
    (famSnap.data() ?? {})[ACCOUNT_BALANCE_FIELD],
  );

  const drawCents = planCreditDraw({
    amountDueCents: before.amountDueCents,
    accountBalanceCents: heldCents,
  });
  if (drawCents === 0) {
    return nothing('no_credit', {
      accountBalanceCents: heldCents,
      amountDueCents: before.amountDueCents,
    });
  }

  const after = settleInvoice(before.totalCents, before.paidCents + drawCents);
  const settling = after.state === 'settled' || after.state === 'overpaid';
  const batch = firestore.batch();

  batch.set(invRef.collection('payments').doc(), {
    amount: centsToDollars(drawCents),
    amountCents: drawCents,
    method: ACCOUNT_CREDIT_METHOD,
    reference: null,
    paidAt: new Date().toISOString(),
    recordedBy: input.actorUid,
    // The row says where the money came from. An operator asking "why is this
    // bill already part paid" gets an answer from the row itself.
    fromAccountCredit: true,
    createdAt: FieldValue.serverTimestamp(),
  });

  batch.set(
    famRef,
    {
      [ACCOUNT_BALANCE_FIELD]: FieldValue.increment(-drawCents),
      accountBalanceUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const invoiceUpdate = {
    status: settling ? 'paid' : 'open',
    paymentStatus: settling ? 'PAID' : 'PARTIAL',
    totalCents: after.totalCents,
    paidCents: after.paidCents,
    amountDueCents: after.amountDueCents,
    overpaidCents: after.overpaidCents,
    amountDue: centsToDollars(after.amountDueCents),
    ...(settling ? { paidAt: FieldValue.serverTimestamp(), paidBy: input.actorUid } : {}),
    lastPaymentAt: FieldValue.serverTimestamp(),
    lastPaymentBy: input.actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  };
  batch.set(
    invRef,
    { ...invoiceUpdate, ...invoiceStateStampOf({ ...doc, ...invoiceUpdate }, after.paidCents) },
    { merge: true },
  );

  await batch.commit();

  logEvent({
    severity: 'info',
    function: 'accountCredit',
    event: 'payment.autoapply.applied',
    uid: input.actorUid,
    extra: {
      invoiceId: input.invoiceId,
      kinfolkId,
      appliedCents: drawCents,
      accountBalanceCents: heldCents - drawCents,
      amountDueCents: after.amountDueCents,
      state: after.state,
    },
  });

  return {
    invoiceId: input.invoiceId,
    skipped: null,
    appliedCents: drawCents,
    accountBalanceCents: heldCents - drawCents,
    amountDueCents: after.amountDueCents,
  };
}
