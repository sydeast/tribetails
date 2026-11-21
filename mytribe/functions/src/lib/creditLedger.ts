/**
 * THE CREDIT HISTORY (operator ruling 2026-09-27, docket Q6): a household's
 * account credit, when it was given, why, and when it was used.
 *
 * ── THE BALANCE IS STILL THE ONLY AUTHORITY ───────────────────────────────
 *
 * `families/{kinfolkId}.accountBalanceCents` is what a household can spend, and
 * nothing here changes that or keeps a second running figure beside it. Before
 * this there was no per-credit record at all: the balance was one number, filled
 * by `recordPayment` (`creditAccount`), `redeemCredit` and the Stripe duplicate
 * checkout path, and drawn down by `drawAccountCredit`. Nobody could say which
 * credit a draw spent, because a single number does not remember.
 *
 * This module adds an APPEND-ONLY EVENT LOG at
 * `families/{kinfolkId}/creditLedger/{eventId}`, two kinds:
 *
 *   `given`   written by `admin/giveAccountCredit.ts` in the SAME transaction
 *             as the balance increment. Amount, reason, who, when. The doc id
 *             is the caller's idempotency key.
 *   `draw`    written by `drawAccountCredit` in the SAME transaction as the
 *             payment row and the balance decrement. Amount, invoice, when,
 *             and the balance before and after.
 *
 * Neither is ever edited after it is written. "Date applied" is DERIVED from
 * them at read time (`creditHistoryOf`), never stamped back onto a `given`
 * event: stamping would put a query plus N writes inside the draw transaction,
 * whose window #830 kept small on purpose, and one appended event carries the
 * same information.
 *
 * ── WHICH CREDIT A DRAW SPENDS ────────────────────────────────────────────
 *
 * Credit is one pool of money, so "which credit was used" is a convention, and
 * this is it:
 *
 *   1. Money in the balance that no `given` event accounts for is spent FIRST.
 *      That is the untracked pool: every balance that existed before this
 *      shipped, overpayments left as credit through `recordPayment`, redeemed
 *      credit invoices, and Stripe duplicate checkouts. At the moment this
 *      ships all of it is older than every `given` event, so first in, first
 *      out puts it first.
 *   2. Then `given` credits, oldest first.
 *
 * The untracked pool at each draw is `heldBeforeCents` (recorded on the draw
 * event) minus what the given credits still hold at that point. Because each
 * draw event records the balance before and after, the rule can be changed
 * later without losing anything.
 */
import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import type { StagedWriter } from './moneyIdempotency';

/** The subcollection under `families/{kinfolkId}`. Server-only: no rule matches it. */
export const CREDIT_LEDGER_COLLECTION = 'creditLedger';

/** Largest credit one call may give, in cents: $5,000.00. See `giveAccountCredit.ts`. */
export const MAX_GIVEN_CREDIT_CENTS = 500_000;

/** Longest reason, matching the notes fields elsewhere in this tree. */
export const MAX_CREDIT_REASON_LENGTH = 1000;

/** How many events one history read loads. FIFO needs them all, oldest first. */
export const MAX_CREDIT_LEDGER_EVENTS = 2000;

export function creditLedgerRef(firestore: Firestore, kinfolkId: string, eventId: string): DocumentReference {
  return firestore.collection('families').doc(kinfolkId).collection(CREDIT_LEDGER_COLLECTION).doc(eventId);
}

/** The id of a draw's event: one per credit payment row, so a retried write lands on the same doc. */
export function drawEventId(paymentId: string): string {
  return `draw_${paymentId}`;
}

/**
 * Stages the draw event on the draw's own transaction. Called by
 * `drawAccountCredit` beside the payment row and the balance write, so the
 * three land together or not at all.
 */
export function stageDrawEvent(
  firestore: Firestore,
  tx: StagedWriter,
  input: {
    kinfolkId: string;
    paymentId: string;
    invoiceId: string;
    invoiceNumber: string | null;
    amountCents: number;
    heldBeforeCents: number;
    heldAfterCents: number;
    actorUid: string;
    atMs: number;
  },
): void {
  tx.set(creditLedgerRef(firestore, input.kinfolkId, drawEventId(input.paymentId)), {
    kind: 'draw',
    amountCents: input.amountCents,
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
    paymentId: input.paymentId,
    heldBeforeCents: input.heldBeforeCents,
    heldAfterCents: input.heldAfterCents,
    actorUid: input.actorUid,
    atMs: input.atMs,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/**
 * `accountCredit.ts#ACCOUNT_BALANCE_FIELD`, restated because that module
 * imports this one (the draw event) and a cycle would leave one of the two
 * undefined at load. `creditLedger.test.ts` asserts the two agree.
 */
export const ACCOUNT_BALANCE_FIELD_NAME = 'accountBalanceCents';

/** The writer `stageGivenCredit` needs: a transaction's `create` and `set`. */
export interface GivenCreditWriter extends StagedWriter {
  create(ref: DocumentReference, data: Record<string, unknown>): unknown;
}

/**
 * Stages a `given` event and the balance it adds, on one transaction.
 *
 * THE ONE PATH CREDIT IS GIVEN BY. `admin/giveAccountCredit.ts` gives credit
 * outright, and `admin/resolveUnappliedPayment.ts` (#1003) gives credit out of
 * a card payment the admin decided about. Both stage through here, so a credit
 * from either shows in the history the same way and moves the balance the same
 * way: the absolute figure read in the same transaction plus the amount.
 *
 * `create`, so a second attempt at the same event id fails the commit instead
 * of adding the credit twice. The caller has already read the balance
 * (`balanceBeforeCents`) inside the same transaction; every read comes before
 * every write.
 *
 * `sourcePaymentId` is set when the credit came out of a payment and left off
 * for a credit given outright. `readCreditLedgerEvent` ignores it, so the
 * history reads both the same way.
 */
export function stageGivenCredit(
  firestore: Firestore,
  tx: GivenCreditWriter,
  input: {
    kinfolkId: string;
    eventId: string;
    amountCents: number;
    reason: string;
    givenBy: string;
    balanceBeforeCents: number;
    atMs: number;
    testMode: boolean;
    sourcePaymentId?: string;
  },
): { balanceAfterCents: number } {
  const balanceAfterCents = input.balanceBeforeCents + input.amountCents;
  tx.create(creditLedgerRef(firestore, input.kinfolkId, input.eventId), {
    kind: 'given',
    amountCents: input.amountCents,
    reason: input.reason,
    givenBy: input.givenBy,
    balanceBeforeCents: input.balanceBeforeCents,
    balanceAfterCents,
    atMs: input.atMs,
    testMode: input.testMode,
    ...(input.sourcePaymentId ? { sourcePaymentId: input.sourcePaymentId } : {}),
    createdAt: FieldValue.serverTimestamp(),
  });
  tx.set(
    firestore.collection('families').doc(input.kinfolkId),
    {
      [ACCOUNT_BALANCE_FIELD_NAME]: balanceAfterCents,
      accountBalanceUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { balanceAfterCents };
}

/**
 * #1939, #1969: WHERE ELSE CREDIT COMES FROM. Two writers raise the balance
 * without going through `stageGivenCredit`, and until these events existed
 * neither left a trace in this log, so the history listed no credit beside a
 * balance that plainly held some:
 *
 *   `payment`        `recordPayment` keeps part of a payment as credit, the
 *                    amount the admin typed (#988). Its balance write is an
 *                    `increment` beside the payment row (`creditAccount`), and
 *                    that stays exactly as it is.
 *   `creditInvoice`  `redeemCredit` turns a credit invoice into balance.
 *
 * Each stages ONE `given` event in the same transaction as its balance write,
 * so the history lists the credit with the rest and the FIFO rule above spends
 * it like any other. The event carries no balance figures (those writers do not
 * read the balance; one increments it), and `readCreditLedgerEvent` never reads
 * balance figures off a `given` event anyway.
 *
 * The id comes from the source, `payment_<payment row id>` or
 * `redeem_<invoice id>`, so a second write for the same source lands on the
 * same doc instead of listing the credit twice. Both callers already refuse a
 * replay before they reach this, so that is a backstop, not the dedupe.
 *
 * The reason is written here, in the household's words, because both portals
 * and all three admin clients print `reason` as it is stored.
 */
export type CreditInSource = 'payment' | 'creditInvoice';

export function paymentCreditEventId(paymentId: string): string {
  return `payment_${paymentId}`;
}

export function redeemedCreditEventId(invoiceId: string): string {
  return `redeem_${invoiceId}`;
}

/** "From a payment on invoice 1020", "From the credit on invoice 1019". */
export function creditInReason(source: CreditInSource, invoiceNumber: string): string {
  const n = invoiceNumber.trim();
  if (source === 'payment') return n === '' ? 'From a payment' : `From a payment on invoice ${n}`;
  return n === '' ? 'From a credit' : `From the credit on invoice ${n}`;
}

export function stageCreditInEvent(
  firestore: Firestore,
  tx: StagedWriter,
  input: {
    kinfolkId: string;
    source: CreditInSource;
    /** The payment row id for `payment`, the credit invoice id for `creditInvoice`. */
    sourceId: string;
    invoiceId: string;
    invoiceNumber: string;
    amountCents: number;
    actorUid: string;
    atMs: number;
  },
): void {
  if (input.kinfolkId === '' || input.sourceId === '' || !(input.amountCents > 0)) return;
  const eventId =
    input.source === 'payment' ? paymentCreditEventId(input.sourceId) : redeemedCreditEventId(input.sourceId);
  tx.set(creditLedgerRef(firestore, input.kinfolkId, eventId), {
    kind: 'given',
    source: input.source,
    amountCents: input.amountCents,
    reason: creditInReason(input.source, input.invoiceNumber),
    givenBy: input.actorUid,
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
    ...(input.source === 'payment' ? { sourcePaymentId: input.sourceId } : {}),
    atMs: input.atMs,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/** One stored event, as the history reads it. Anything unreadable is skipped, never guessed. */
export type CreditLedgerEvent =
  | {
      kind: 'given';
      id: string;
      amountCents: number;
      reason: string;
      atMs: number;
    }
  | {
      kind: 'draw';
      id: string;
      amountCents: number;
      invoiceId: string;
      invoiceNumber: string | null;
      heldBeforeCents: number | null;
      atMs: number;
    };

function intOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : null;
}

/** Reads one stored event. Returns null for anything that is not a well-formed event. */
export function readCreditLedgerEvent(id: string, data: Record<string, unknown>): CreditLedgerEvent | null {
  const amountCents = intOf(data['amountCents']);
  const atMs = intOf(data['atMs']);
  if (amountCents === null || amountCents <= 0 || atMs === null) return null;
  if (data['kind'] === 'given') {
    return {
      kind: 'given',
      id,
      amountCents,
      reason: typeof data['reason'] === 'string' ? data['reason'] : '',
      atMs,
    };
  }
  if (data['kind'] === 'draw') {
    return {
      kind: 'draw',
      id,
      amountCents,
      invoiceId: typeof data['invoiceId'] === 'string' ? data['invoiceId'] : '',
      invoiceNumber: typeof data['invoiceNumber'] === 'string' ? data['invoiceNumber'] : null,
      heldBeforeCents: intOf(data['heldBeforeCents']),
      atMs,
    };
  }
  return null;
}

/** One use of one given credit. */
export interface CreditApplication {
  atMs: number;
  amountCents: number;
  invoiceId: string;
  invoiceNumber: string | null;
}

/** One given credit, with what the FIFO rule says happened to it. */
export interface GivenCreditHistory {
  id: string;
  amountCents: number;
  reason: string;
  givenAtMs: number;
  /** What is still unspent of this credit. */
  remainingCents: number;
  /** Every draw that spent part of it, oldest first. */
  applications: CreditApplication[];
  /** When the last of it was spent, or null while any is left. */
  fullyAppliedAtMs: number | null;
}

/** One draw, as a use of credit, whichever credit it spent. */
export interface CreditUse {
  id: string;
  atMs: number;
  amountCents: number;
  invoiceId: string;
  invoiceNumber: string | null;
}

export interface CreditHistory {
  /** Given credits, newest first. */
  credits: GivenCreditHistory[];
  /** Every draw of credit onto an invoice, newest first. */
  uses: CreditUse[];
}

/**
 * The history, derived. PURE, so every boundary of the FIFO rule is a unit test.
 *
 * Events are replayed oldest first. A `given` event opens a credit. A `draw`
 * spends the untracked pool first (its `heldBeforeCents` minus what open given
 * credits still hold), then open given credits oldest first. A draw with no
 * recorded `heldBeforeCents` treats the untracked pool as empty.
 */
export function creditHistoryOf(events: readonly CreditLedgerEvent[]): CreditHistory {
  const ordered = [...events].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
  const credits: GivenCreditHistory[] = [];
  const uses: CreditUse[] = [];

  for (const ev of ordered) {
    if (ev.kind === 'given') {
      credits.push({
        id: ev.id,
        amountCents: ev.amountCents,
        reason: ev.reason,
        givenAtMs: ev.atMs,
        remainingCents: ev.amountCents,
        applications: [],
        fullyAppliedAtMs: null,
      });
      continue;
    }
    uses.push({
      id: ev.id,
      atMs: ev.atMs,
      amountCents: ev.amountCents,
      invoiceId: ev.invoiceId,
      invoiceNumber: ev.invoiceNumber,
    });
    const trackedOpen = credits.reduce((sum, c) => sum + c.remainingCents, 0);
    const untracked = ev.heldBeforeCents === null ? 0 : Math.max(0, ev.heldBeforeCents - trackedOpen);
    let left = ev.amountCents - Math.min(ev.amountCents, untracked);
    for (const credit of credits) {
      if (left <= 0) break;
      if (credit.remainingCents <= 0) continue;
      const take = Math.min(left, credit.remainingCents);
      credit.remainingCents -= take;
      left -= take;
      credit.applications.push({
        atMs: ev.atMs,
        amountCents: take,
        invoiceId: ev.invoiceId,
        invoiceNumber: ev.invoiceNumber,
      });
      if (credit.remainingCents === 0) credit.fullyAppliedAtMs = ev.atMs;
    }
  }

  return { credits: credits.reverse(), uses: uses.reverse() };
}

/**
 * #1939, #1969: THE CREDIT THE LOG DOES NOT ITEMISE, so the history always adds
 * up to the balance beside it.
 *
 * Balance that came in before the log listed every source has no event: credit
 * redeemed or kept from a payment before those writers staged one, balances
 * brought over from the old system, and the Stripe duplicate checkouts the
 * webhook credited before docket Q5. A screen listing only the events then shows
 * "$957.00 on account" over "No credit given yet." and three uses, and the
 * household's page is $15.00 out.
 *
 * The balance is the authority, so the missing money is worked out from it:
 *
 *   earlier credit   = balance + every use - every listed credit
 *   still unspent    = balance - what the listed credits still hold
 *
 * so listed credits + earlier credit - uses = balance, to the cent. The FIFO
 * rule spends this pool first, which is why its unspent part is whatever the
 * balance holds beyond the listed credits.
 *
 * `none` when there is nothing to itemise. `mismatch` when the figures cannot
 * describe a pool at all (the balance is below what the listed credits still
 * hold, or the log was cut at its read limit): the caller logs it and shows no
 * row rather than a made-up one.
 */
export type EarlierCredit =
  | { kind: 'none' }
  | { kind: 'pool'; amountCents: number; remainingCents: number }
  | { kind: 'mismatch'; amountCents: number; remainingCents: number };

export function earlierCreditOf(history: CreditHistory, balanceCents: number): EarlierCredit {
  const listedCents = history.credits.reduce((sum, c) => sum + c.amountCents, 0);
  const listedLeftCents = history.credits.reduce((sum, c) => sum + c.remainingCents, 0);
  const usedCents = history.uses.reduce((sum, u) => sum + u.amountCents, 0);
  const amountCents = balanceCents + usedCents - listedCents;
  const remainingCents = balanceCents - listedLeftCents;
  if (amountCents === 0 && remainingCents === 0) return { kind: 'none' };
  if (amountCents < 0 || remainingCents < 0 || remainingCents > amountCents) {
    return { kind: 'mismatch', amountCents, remainingCents };
  }
  return { kind: 'pool', amountCents, remainingCents };
}
