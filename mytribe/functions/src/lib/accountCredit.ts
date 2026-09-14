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
import type { Firestore } from 'firebase-admin/firestore';

import type { StagedWriter } from './moneyIdempotency';

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
import { PAYMENT_APPLIED_OWNER_FIELD, paymentAppliedOwner } from './paymentAppliedOwner';
import { resolveKinfolkUid } from './resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';

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
 * because it runs inside a transaction; this runs alongside the payment it
 * belongs to, and the two must land together.
 *
 * #825 widened `batch` to `StagedWriter`, the one `set` a `WriteBatch` and a
 * `Transaction` both carry. `recordPayment` now stages this inside a
 * transaction, so the increment is authorised by the same snapshot that found
 * no existing payment row for the caller's key: a replay increments nothing,
 * because it never reaches this call at all. The `increment` stays an
 * increment — the dedupe is what stops the second one, not a re-read of the
 * balance, and re-reading it would reintroduce the lost-update this comment
 * has always been about.
 */
export function creditAccount(
  firestore: Firestore,
  batch: StagedWriter,
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
 * The balance a draw leaves behind, and the LAST GUARD in front of the write.
 *
 * An absolute figure, computed from the balance read in the same transaction,
 * rather than `increment(-draw)`. An increment cannot be bounded: it applies
 * whatever the stored value turns out to be, so a plan built on a stale read
 * writes a negative balance and nothing anywhere refuses it. This returns a
 * figure that is non-negative or it throws, and a throw inside the transaction
 * aborts it, so an overdraw commits NOTHING rather than committing a debt.
 *
 * `planCreditDraw` already makes the throw unreachable by never planning a draw
 * larger than the balance. That is the point: the arithmetic is what keeps it
 * from happening, and this is what makes it impossible to store even if the
 * arithmetic is one day changed by someone who does not read it.
 */
export function balanceAfterDraw(heldCents: number, drawCents: number): number {
  const remaining = Math.round(heldCents) - Math.round(drawCents);
  if (remaining < 0) {
    throw new Error(
      `accountCredit: refusing to overdraw a household balance (held ${heldCents}, draw ${drawCents})`,
    );
  }
  return remaining;
}

/**
 * ONE PASS over one invoice: draw the household's credit down onto it.
 *
 * The invoice, its subcollection row and the family balance move together in a
 * single transaction or not at all. A half-commit would spend a household's
 * credit without crediting their bill, which is the same money vanishing that
 * the dropped fee was.
 *
 * ── WHY A TRANSACTION AND NOT A BATCH (#830) ──────────────────────────────
 *
 * A batch is atomic and that was never the gap. The gap was that the plan was
 * not conditioned on the balance still being what it was when it was read: the
 * three reads, the plan and the commit were four separate round trips, and two
 * passes could sit inside one another's window, both read the same held credit
 * and both spend it. There are two callers — `admin/runAutoApply.ts` on demand
 * and `triggers/onInvoiceAutoApply.ts` by itself — so that overlap needs no
 * retry and no replay to happen; it is one operator pressing a button while the
 * trigger for the same invoice is in flight.
 *
 * Everything now reads inside `runTransaction`, so the balance that decides the
 * draw and the write that applies it share one snapshot. The serialisation
 * point is BOTH documents: every pass reads and writes `invoices/{id}` and
 * `families/{kinfolkId}`, so a second pass cannot commit against a snapshot the
 * first has already moved — it re-runs and re-plans against what the first
 * actually committed.
 *
 * ── WHAT THE SECOND PASS OF A RACE DOES ───────────────────────────────────
 *
 * It re-plans, and the plan is what decides. This is not a coin toss between
 * "draw the rest" and "draw nothing": `planCreditDraw` takes the SMALLER of
 * what is owed and what is held, so after any successful draw either the
 * invoice owes nothing or the household holds nothing.
 *
 *   same invoice      the second pass draws ZERO, always. It finds the first
 *                     pass's payment row and the decremented balance, and one
 *                     of the two is exhausted, so it reports
 *                     `invoice_not_collectable` or `no_credit`. That is what
 *                     makes a duplicate trigger delivery, a double click and a
 *                     retried pass all harmless.
 *   another invoice   the second pass draws WHAT IS LEFT, which is the correct
 *                     answer and the whole meaning of "future invoices",
 *                     plural. Two bills racing over one balance now share it
 *                     instead of each spending all of it.
 *
 * So a concurrent pair behaves exactly like the same pair run one after the
 * other. Ordering decides which invoice gets the credit, never how much credit
 * exists — and the balance can no longer go negative, because the decrement is
 * an absolute figure `balanceAfterDraw` refuses to make negative.
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

  /** The committed outcome, plus what only the transaction knew, to log with. */
  const pass = await firestore.runTransaction(async (tx) => {
    // ALL READS BEFORE WRITES, the same order `redeemCredit` keeps: Firestore
    // refuses a read after a write on the same transaction.
    const invSnap = await tx.get(invRef);
    if (!invSnap.exists) return { result: nothing('invoice_missing'), applied: null };
    const doc = (invSnap.data() ?? {}) as InvoiceDoc;

    const kinfolkId = typeof doc.kinfolkId === 'string' ? doc.kinfolkId : '';
    if (kinfolkId === '') return { result: nothing('no_household'), applied: null };

    const paymentsSnap = await tx.get(invRef.collection('payments'));
    const existingPayments = paymentsSnap.docs.map((d) => d.data() as PaymentAmount);
    if (!invoiceAcceptsCredit(doc, existingPayments)) {
      return { result: nothing('invoice_not_collectable'), applied: null };
    }

    const before = settleInvoice(invoiceTotalCentsOf(doc), paidCentsFromPayments(existingPayments));

    const famRef = firestore.collection('families').doc(kinfolkId);
    const famSnap = await tx.get(famRef);
    const heldCents = readAccountBalanceCents((famSnap.data() ?? {})[ACCOUNT_BALANCE_FIELD]);

    const drawCents = planCreditDraw({
      amountDueCents: before.amountDueCents,
      accountBalanceCents: heldCents,
    });
    if (drawCents === 0) {
      return {
        result: nothing('no_credit', {
          accountBalanceCents: heldCents,
          amountDueCents: before.amountDueCents,
        }),
        applied: null,
      };
    }

    // Throws rather than writes if this would ever be negative, which aborts
    // the whole transaction: no payment row, no invoice update, no decrement.
    const remainingCents = balanceAfterDraw(heldCents, drawCents);

    const after = settleInvoice(before.totalCents, before.paidCents + drawCents);
    const settling = after.state === 'settled' || after.state === 'overpaid';

    const paymentRef = invRef.collection('payments').doc();
    tx.set(paymentRef, {
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

    // The ABSOLUTE remainder, not `increment(-drawCents)`. Inside the
    // transaction the read that produced it is the read this write is
    // conditioned on, which is exactly what `creditAccount` cannot say about
    // its own increment — and unlike an increment, this cannot store a debt.
    tx.set(
      famRef,
      {
        [ACCOUNT_BALANCE_FIELD]: remainingCents,
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
      ...(settling
        ? {
            paidAt: FieldValue.serverTimestamp(),
            paidBy: input.actorUid,
            // #884 review: the draw is a real payment and sends its own notice
            // (below, after the commit), so the write that pays the bill names it
            // and `onInvoicesWrite` stands down. The trigger cannot be relied on
            // here: a legacy invoice with a `total` and no `amountDue` already
            // reads paid to invoiceStateOf, so paying it off is paid to paid.
            [PAYMENT_APPLIED_OWNER_FIELD]: paymentAppliedOwner('accountCredit', paymentRef.id),
          }
        : {}),
      lastPaymentAt: FieldValue.serverTimestamp(),
      lastPaymentBy: input.actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(
      invRef,
      { ...invoiceUpdate, ...invoiceStateStampOf({ ...doc, ...invoiceUpdate }, after.paidCents) },
      { merge: true },
    );

    return {
      result: {
        invoiceId: input.invoiceId,
        skipped: null,
        appliedCents: drawCents,
        accountBalanceCents: remainingCents,
        amountDueCents: after.amountDueCents,
      } satisfies AutoApplyResult,
      applied: {
        kinfolkId,
        state: after.state,
        settling,
        paymentId: paymentRef.id,
        currency: typeof (doc as Record<string, unknown>)['currency'] === 'string'
          ? ((doc as Record<string, unknown>)['currency'] as string)
          : null,
        dueDate: dueDateOf(doc as Record<string, unknown>),
      },
    };
  });

  // AFTER the commit, never inside it. A transaction callback re-runs on
  // contention, and a log line written from an attempt that was discarded would
  // report money that never moved — which is the failure mode this whole change
  // is about, wearing a different hat.
  if (pass.applied !== null) {
    logEvent({
      severity: 'info',
      function: 'accountCredit',
      event: 'payment.autoapply.applied',
      uid: input.actorUid,
      extra: {
        invoiceId: input.invoiceId,
        kinfolkId: pass.applied.kinfolkId,
        appliedCents: pass.result.appliedCents,
        accountBalanceCents: pass.result.accountBalanceCents,
        amountDueCents: pass.result.amountDueCents,
        state: pass.applied.state,
      },
    });
  }

  // #884 review: THE DRAW SENDS ITS OWN PAYMENT NOTICE, after the commit and
  // only when this draw paid the bill off (a partial draw tells nobody, as
  // before). Its own write stamped `accountCredit:<paymentId>`, so
  // `onInvoicesWrite` stands down for it. The notice carries the payment row's
  // id, so the dispatcher ledger dedupes a repeat of this same pass; a second
  // pass over the paid bill draws nothing and never reaches here. A failed
  // enqueue is logged, the same outcome the trigger had when it sent this.
  if (pass.applied !== null && pass.applied.settling) {
    await sendCreditPaymentNotice(input.invoiceId, pass.applied, pass.result.amountDueCents);
  }

  return pass.result;
}

/** The due date the invoice trigger put on this notice, from either spelling. */
function dueDateOf(doc: Record<string, unknown>): string | null {
  for (const key of ['dueDate', 'invoiceDueDate']) {
    const value = doc[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

async function sendCreditPaymentNotice(
  invoiceId: string,
  applied: { kinfolkId: string; paymentId: string; currency: string | null; dueDate: string | null },
  amountDueCents: number,
): Promise<void> {
  try {
    const recipientUid = await resolveKinfolkUid(applied.kinfolkId);
    await enqueueNotification({
      key: 'invoice.payment.applied',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: applied.kinfolkId,
        invoiceId,
        amountDue: centsToDollars(amountDueCents),
        currency: applied.currency,
        dueDate: applied.dueDate,
        paymentId: applied.paymentId,
      },
      targetType: 'invoice',
      targetId: invoiceId,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'accountCredit',
      event: 'notification.dispatch.failed',
      extra: {
        kinfolkId: applied.kinfolkId,
        invoiceId,
        paymentId: applied.paymentId,
        key: 'invoice.payment.applied',
        err: (err as Error)?.message,
      },
    });
  }
}
