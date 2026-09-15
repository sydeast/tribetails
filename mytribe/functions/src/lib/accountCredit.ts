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
import type { DocumentReference } from 'firebase-admin/firestore';
import {
  PAYMENT_APPLIED_ATTEMPTS_FIELD,
  PAYMENT_APPLIED_LAST_ERROR_FIELD,
  PAYMENT_APPLIED_OWNER_FIELD,
  PAYMENT_APPLIED_PENDING_AT_FIELD,
  PAYMENT_APPLIED_PENDING_FIELD,
  PAYMENT_APPLIED_SENT_AT_FIELD,
  PAYMENT_APPLIED_SKIPPED_FIELD,
  paymentAppliedOwner,
} from './paymentAppliedOwner';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
import { resolveKinfolkUid } from './resolveKinfolkUid';
import { enqueueNotificationDetailed } from '../notifications/dispatcher';
import { isNoRecipientsError } from '../notifications/recipientErrors';

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
            // #884 second review: pending until the notice is delivered, in the
            // same commit as the payment, so a crash anywhere after this point
            // leaves a record a redelivered pass or the scheduled sweep can finish.
            [PAYMENT_APPLIED_PENDING_FIELD]: paymentAppliedOwner('accountCredit', paymentRef.id),
            [PAYMENT_APPLIED_PENDING_AT_FIELD]: Date.now(),
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
  // before). Its own write stamped `accountCredit:<paymentId>` as the owner, so
  // `onInvoicesWrite` stands down, and as pending, so the notice is finished by
  // someone even if this instance stops before it goes out.
  if (pass.applied !== null && pass.applied.settling) {
    await deliverCreditPaymentNotice(firestore, input.invoiceId, {
      owner: paymentAppliedOwner('accountCredit', pass.applied.paymentId),
      kinfolkId: pass.applied.kinfolkId,
      paymentId: pass.applied.paymentId,
      currency: pass.applied.currency,
      dueDate: pass.applied.dueDate,
      amountDueCents: pass.result.amountDueCents,
    });
  }

  // #884 second review: A REDELIVERED PASS FINISHES WHAT THE FIRST ONE COULD NOT.
  // The trigger redelivery or a second press of Run auto-apply finds the bill
  // already paid and draws nothing, and this is the moment it can send a notice
  // the first pass committed but never delivered.
  if (pass.result.skipped === 'invoice_not_collectable') {
    await resendPendingCreditNotice(firestore, input.invoiceId);
  }

  return pass.result;
}

/**
 * How long the dispatcher ledger remembers one credit payment notice. Every
 * sender of it (the pass, a redelivered pass, the sweep) uses the same identity,
 * `invoice:<id>#paymentId:<paymentId>`, so within this window only one copy is
 * delivered however they race. A week covers any redelivery and many sweeps; one
 * payment row is one payment, so the window can never merge two payments.
 */
export const CREDIT_NOTICE_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How old a pending notice must be before `notificationScheduledSweep` sends it.
 * The pass sends within seconds of its commit; this leaves it room to, so the
 * sweep only picks up notices that stopped.
 */
export const CREDIT_NOTICE_SWEEP_GRACE_MS = 10 * 60 * 1000;

/**
 * #884 third review: RETRIES ARE CAPPED. A redelivered pass or a sweep claims one
 * attempt per try, in a transaction. The try after CREDIT_NOTICE_MAX_ATTEMPTS
 * gives up: it stamps `paymentAppliedNoticeSkippedReason: 'gave-up'`, clears the
 * pending stamp, and writes one `BILLING_PAYMENT_NOTIFICATION_GAVE_UP` row to
 * `activity_log` for the office. 12 because the sweep runs every 5 minutes, so a
 * notice that cannot go out is surfaced after about an hour, far inside the
 * dispatcher ledger's 7 day window, which is what stops a copy going out a
 * second time. It also stops permanently failing notices holding sweep slots.
 */
export const CREDIT_NOTICE_MAX_ATTEMPTS = 12;

/**
 * The share of `notificationScheduledSweep`'s run the credit pass may use. The
 * function has the default 60 second timeout, and the queue drain after this
 * pass promotes up to 200 queued notifications, each a small transaction, so it
 * keeps at least 40 seconds. One credit retry is about four round trips (the
 * attempt claim, the recipient lookup, the ledger transaction, the finishing
 * stamp), a few hundred milliseconds warm, so 20 seconds finishes a normal
 * backlog in one run. Whatever is left is picked up 5 minutes later, oldest first.
 */
export const CREDIT_NOTICE_SWEEP_BUDGET_MS = 20 * 1000;

const CREDIT_NOTICE_SWEEP_LIMIT = 100;
const CREDIT_OWNER_PREFIX = 'accountCredit:';

/** The due date the invoice trigger put on this notice, from either spelling. */
function dueDateOf(doc: Record<string, unknown>): string | null {
  for (const key of ['dueDate', 'invoiceDueDate']) {
    const value = doc[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

interface CreditPaymentNotice {
  /** The pending stamp this notice finishes, `accountCredit:<paymentId>`. */
  owner: string;
  kinfolkId: string;
  paymentId: string;
  currency: string | null;
  dueDate: string | null;
  amountDueCents: number;
}

/** The notice a doc's pending stamp still owes, or null. */
function pendingCreditNoticeOf(doc: Record<string, unknown>): CreditPaymentNotice | null {
  const owner = doc[PAYMENT_APPLIED_PENDING_FIELD];
  if (typeof owner !== 'string' || !owner.startsWith(CREDIT_OWNER_PREFIX)) return null;
  const paymentId = owner.slice(CREDIT_OWNER_PREFIX.length);
  const kinfolkId = typeof doc['kinfolkId'] === 'string' ? doc['kinfolkId'] : '';
  if (paymentId === '' || kinfolkId === '') return null;
  const cents = doc['amountDueCents'];
  return {
    owner,
    kinfolkId,
    paymentId,
    currency: typeof doc['currency'] === 'string' ? doc['currency'] : null,
    dueDate: dueDateOf(doc),
    amountDueCents: typeof cents === 'number' && Number.isFinite(cents) ? cents : 0,
  };
}

/** The short code a failure is recorded as: the error's own code when it has one, never its message. */
function noticeErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code.slice(0, 60);
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return 'enqueue-failed';
}

/** Records the last failure's code on the invoice, for the give-up row. Never throws. */
async function recordCreditNoticeError(
  invRef: DocumentReference,
  extra: Record<string, unknown>,
  code: string,
): Promise<void> {
  await invRef.set({ [PAYMENT_APPLIED_LAST_ERROR_FIELD]: code }, { merge: true }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'accountCredit',
      event: 'credit.notice.error.stamp.failed',
      extra: { ...extra, code, err: (err as Error)?.message },
    });
  });
}

type AttemptClaim = 'go' | 'gone' | { attempts: number; lastErrorCode: string | null };

/**
 * One retry of a pending notice claims one attempt, in a transaction, so two
 * retries racing (a sweep and a redelivered pass) count as two. 'gone' when the
 * pending stamp is no longer this notice's (another sender finished it); the cap
 * reached when CREDIT_NOTICE_MAX_ATTEMPTS retries have already been claimed.
 */
async function claimCreditNoticeAttempt(
  firestore: Firestore,
  invRef: DocumentReference,
  notice: CreditPaymentNotice,
): Promise<AttemptClaim> {
  return firestore.runTransaction(async (tx): Promise<AttemptClaim> => {
    const snap = await tx.get(invRef);
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (data[PAYMENT_APPLIED_PENDING_FIELD] !== notice.owner) return 'gone';
    const raw = data[PAYMENT_APPLIED_ATTEMPTS_FIELD];
    const prior = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (prior >= CREDIT_NOTICE_MAX_ATTEMPTS) {
      const last = data[PAYMENT_APPLIED_LAST_ERROR_FIELD];
      return { attempts: prior, lastErrorCode: typeof last === 'string' ? last : null };
    }
    tx.set(invRef, { [PAYMENT_APPLIED_ATTEMPTS_FIELD]: prior + 1 }, { merge: true });
    return 'go';
  });
}

/**
 * The notice will not go out. One `activity_log` row for the office (ids and the
 * last error code only, no names or addresses), at a fixed document id so a
 * retry of the give-up cannot write it twice, then the pending stamp is cleared
 * as 'gave-up'. The row is written first: if the clear fails, the next sweep
 * gives up again and the row is not repeated.
 */
async function giveUpCreditNotice(
  firestore: Firestore,
  invRef: DocumentReference,
  invoiceId: string,
  notice: CreditPaymentNotice,
  cap: { attempts: number; lastErrorCode: string | null },
): Promise<boolean> {
  const extra = { kinfolkId: notice.kinfolkId, invoiceId, paymentId: notice.paymentId, key: 'invoice.payment.applied' };
  try {
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.BILLING_PAYMENT_NOTIFICATION_GAVE_UP,
      severity: 'warn',
      actorRole: 'SYSTEM',
      targetUid: invoiceId,
      targetCollection: 'invoices',
      familyId: notice.kinfolkId,
      description: `Payment notification for invoice ${invoiceId} was not delivered after ${cap.attempts} retries`,
      payload: {
        invoiceId,
        paymentId: notice.paymentId,
        attempts: cap.attempts,
        lastErrorCode: cap.lastErrorCode,
      },
      docId: `credit_notice_gave_up_${invoiceId}_${notice.paymentId}`,
    });
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(invRef);
      if ((snap.data() ?? {})[PAYMENT_APPLIED_PENDING_FIELD] !== notice.owner) return;
      tx.set(
        invRef,
        {
          [PAYMENT_APPLIED_SKIPPED_FIELD]: 'gave-up',
          [PAYMENT_APPLIED_PENDING_FIELD]: '',
          [PAYMENT_APPLIED_PENDING_AT_FIELD]: FieldValue.delete(),
        },
        { merge: true },
      );
    });
    logEvent({
      severity: 'error',
      function: 'accountCredit',
      event: 'credit.notice.gave_up',
      extra: { ...extra, attempts: cap.attempts, lastErrorCode: cap.lastErrorCode },
    });
    return true;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'accountCredit',
      event: 'credit.notice.give_up.failed',
      extra: { ...extra, err: (err as Error)?.message },
    });
    return false;
  }
}

/**
 * Sends one credit payment notice, then clears its pending stamp. NEVER THROWS:
 * the money has committed, and a failure here is finished later by a redelivered
 * pass or the sweep.
 *
 * `mode` 'first' is the draw's own send, straight after its commit. 'retry' is a
 * redelivered pass or the sweep: it claims an attempt first, and past the cap it
 * gives up instead of sending (#884 third review).
 *
 * Returns true when the notice is done: delivered (or already delivered, which
 * the ledger reports as a duplicate), unreachable for good (no household account
 * and no office roster, as the Stripe webhook treats it), or given up. False
 * when it must be tried again: an enqueue error, an audience whose lookup
 * failed, or a stamp that did not land.
 *
 * The clear is a compare-and-set in a transaction: it only clears the stamp this
 * notice owns, so a later draw's pending stamp is never wiped by an older send.
 * It deletes the pending time too, so the sweep's age query never fetches a
 * finished notice.
 */
async function deliverCreditPaymentNotice(
  firestore: Firestore,
  invoiceId: string,
  notice: CreditPaymentNotice,
  mode: 'first' | 'retry' = 'first',
): Promise<boolean> {
  const extra = { kinfolkId: notice.kinfolkId, invoiceId, paymentId: notice.paymentId, key: 'invoice.payment.applied' };
  const invRef = firestore.collection('invoices').doc(invoiceId);

  if (mode === 'retry') {
    let claim: AttemptClaim;
    try {
      claim = await claimCreditNoticeAttempt(firestore, invRef, notice);
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'accountCredit',
        event: 'credit.notice.claim.failed',
        extra: { ...extra, err: (err as Error)?.message },
      });
      return false;
    }
    if (claim === 'gone') return false;
    if (claim !== 'go') return giveUpCreditNotice(firestore, invRef, invoiceId, notice, claim);
  }

  let finished: Record<string, unknown>;
  try {
    const recipientUid = await resolveKinfolkUid(notice.kinfolkId);
    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.payment.applied',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: notice.kinfolkId,
        invoiceId,
        amountDue: centsToDollars(notice.amountDueCents),
        currency: notice.currency,
        dueDate: notice.dueDate,
        paymentId: notice.paymentId,
      },
      targetType: 'invoice',
      targetId: invoiceId,
      dedupeWindowMs: CREDIT_NOTICE_DEDUPE_WINDOW_MS,
    });
    const unresolved = outcome.unresolved ?? [];
    if (unresolved.length > 0) {
      // Some audience's lookup failed (the office roster read). Left pending: the
      // retry's ledger stops the copies that went out from repeating.
      logEvent({
        severity: 'warn',
        function: 'accountCredit',
        event: 'credit.notice.partial',
        extra: { ...extra, unresolved: unresolved.map((u) => u.resolver) },
      });
      await recordCreditNoticeError(invRef, extra, 'recipients-unresolved');
      return false;
    }
    finished = { [PAYMENT_APPLIED_SENT_AT_FIELD]: FieldValue.serverTimestamp() };
  } catch (err) {
    if (!isNoRecipientsError(err)) {
      logEvent({
        severity: 'warn',
        function: 'accountCredit',
        event: 'notification.dispatch.failed',
        extra: { ...extra, err: (err as Error)?.message },
      });
      await recordCreditNoticeError(invRef, extra, noticeErrorCode(err));
      return false;
    }
    logEvent({
      severity: 'error',
      function: 'accountCredit',
      event: 'credit.notice.unreachable',
      extra: { ...extra, err: (err as Error)?.message },
    });
    finished = { [PAYMENT_APPLIED_SKIPPED_FIELD]: 'no-recipients' };
  }

  try {
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(invRef);
      if ((snap.data() ?? {})[PAYMENT_APPLIED_PENDING_FIELD] !== notice.owner) return;
      tx.set(
        invRef,
        { ...finished, [PAYMENT_APPLIED_PENDING_FIELD]: '', [PAYMENT_APPLIED_PENDING_AT_FIELD]: FieldValue.delete() },
        { merge: true },
      );
    });
    return true;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'accountCredit',
      event: 'credit.notice.stamp.failed',
      extra: { ...extra, err: (err as Error)?.message },
    });
    return false;
  }
}

/** Sends the notice an invoice's pending stamp still owes, if any, as a retry. Never throws. */
async function resendPendingCreditNotice(firestore: Firestore, invoiceId: string): Promise<boolean> {
  try {
    const snap = await firestore.collection('invoices').doc(invoiceId).get();
    const notice = snap.exists ? pendingCreditNoticeOf((snap.data() ?? {}) as Record<string, unknown>) : null;
    if (notice === null) return false;
    return await deliverCreditPaymentNotice(firestore, invoiceId, notice, 'retry');
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'accountCredit',
      event: 'credit.notice.resend.failed',
      extra: { invoiceId, err: (err as Error)?.message },
    });
    return false;
  }
}

export interface CreditNoticeSweepOptions {
  /** How long the pass may run before leaving the rest for the next run. Default CREDIT_NOTICE_SWEEP_BUDGET_MS. */
  budgetMs?: number;
  /** The clock the budget is measured on. Tests pass one. */
  clock?: () => number;
}

/**
 * THE SAFETY NET (#884 second review), run by `notificationScheduledSweep`
 * every 5 minutes: every credit payment notice still pending after
 * CREDIT_NOTICE_SWEEP_GRACE_MS is retried. Covers the crash that no redelivery
 * follows (the trigger does not retry, and nobody presses Run auto-apply again).
 *
 * #884 third review: the query is on the pending TIME, `< now - grace`, ordered
 * by it. A range filter and an order on the same single field need no composite
 * index; the oldest notices come first; notices still inside the grace period,
 * and finished ones (which delete the field), are never fetched, so they cannot
 * take the 100 slots from a due one. Permanently failing notices give up after
 * CREDIT_NOTICE_MAX_ATTEMPTS and leave the query. The pass stops once its budget
 * is spent. Returns how many notices it finished.
 */
export async function sweepPendingCreditNotices(
  firestore: Firestore,
  nowMs: number,
  options: CreditNoticeSweepOptions = {},
): Promise<number> {
  const budgetMs = options.budgetMs ?? CREDIT_NOTICE_SWEEP_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const snap = await firestore
    .collection('invoices')
    .where(PAYMENT_APPLIED_PENDING_AT_FIELD, '<', nowMs - CREDIT_NOTICE_SWEEP_GRACE_MS)
    .orderBy(PAYMENT_APPLIED_PENDING_AT_FIELD)
    .limit(CREDIT_NOTICE_SWEEP_LIMIT)
    .get();
  let finished = 0;
  let tried = 0;
  for (const doc of snap.docs) {
    if (clock() - startedAt >= budgetMs) {
      logEvent({
        severity: 'info',
        function: 'accountCredit',
        event: 'credit.notice.sweep.budget_spent',
        extra: { finished, left: snap.size - tried, budgetMs },
      });
      break;
    }
    tried += 1;
    const notice = pendingCreditNoticeOf((doc.data() ?? {}) as Record<string, unknown>);
    if (notice === null) continue;
    if (await deliverCreditPaymentNotice(firestore, doc.id, notice, 'retry')) finished += 1;
  }
  return finished;
}
