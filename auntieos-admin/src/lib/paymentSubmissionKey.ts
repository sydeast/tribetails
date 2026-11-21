import type { GetInvoiceLedgerResult, RecordPaymentResult } from '../contracts/invoiceContracts.generated';
import { mintPaymentIdempotencyKey } from './moneyIdempotency';

/**
 * #2297: THE KEY A RECORD PAYMENT ENTRY HOLDS.
 *
 * `recordPayment` dedupes on the key (#825): a second press with the same key
 * is answered from the row the first press wrote, if it wrote one, and the
 * server's create of `payments/{key}` lets only one of two overlapping presses
 * write. That create is the only thing that makes two presses one payment, so
 * the rule is about when a press may carry a DIFFERENT key. The rules, the same
 * on admin web, admin Android and the desktop console:
 *
 *   - A KEY IS HELD FROM ITS FIRST PRESS UNTIL THE SERVER ANSWERS ONE. A
 *     failed press keeps it whatever is edited next, and across Cancel and the
 *     next opening of the form. A failure can be a request that never arrived
 *     or a payment whose answer was lost, and a payment can still commit after
 *     the check that looked for it found nothing. A new key while an earlier
 *     press is unresolved is the one way to record a payment twice.
 *   - AN ANSWER LETS THE KEY GO. The next press after it is a new payment, even
 *     when every box matches (two equal cash instalments on one day).
 *   - A REPLAYED ANSWER IS CHECKED (`settle`). The server marks an answer that
 *     came from an earlier press's row (`replayed`). When the presses under the
 *     key all had these figures, in this opening, that is this entry's answer.
 *     When the figures changed under the key, the row's money says whose it
 *     is (`answerIsThisEntry`): the press now answered may be the one that
 *     wrote it (an earlier press was refused, or never left the device).
 *     Otherwise it is an earlier entry's: the screen says that payment is the
 *     one on record and the figures typed since were not recorded, instead of
 *     reporting the earlier payment as the one just typed.
 *   - A KEY NEVER CROSSES INVOICES (`scope`).
 */
export class PaymentSubmissionKey {
  private held: { key: string; scope: string; figures: Set<string>; opening: number } | null = null;
  private opening = 0;

  constructor(private readonly mint: () => string = mintPaymentIdempotencyKey) {}

  /** A new opening of the form. A key still unresolved from an earlier one stays held. */
  open(): void {
    this.opening += 1;
  }

  /** The key for a press of these figures on this invoice, minting one only when none is held. */
  keyFor(scope: string, figures: string): string {
    const held = this.held;
    if (held !== null && held.scope === scope) {
      held.figures.add(figures);
      return held.key;
    }
    const key = this.mint();
    this.held = { key, scope, figures: new Set([figures]), opening: this.opening };
    return key;
  }

  /**
   * The server answered a press under the held key, which lets the key go.
   * `'recorded'`: this entry is the payment on record. `'earlier'`: the answer
   * is a replay of a press made in an earlier opening, or of one made with
   * other figures whose money the row carries, and that earlier payment is
   * the one on record. `sameMoney` is `answerIsThisEntry` for the press just
   * answered.
   */
  settle(replayed: boolean, sameMoney: boolean): 'recorded' | 'earlier' {
    const held = this.held;
    this.held = null;
    if (!replayed || held === null) return 'recorded';
    if (held.opening !== this.opening) return 'earlier';
    return held.figures.size === 1 || sameMoney ? 'recorded' : 'earlier';
  }

  /** The payment is known to be on record without an answer: the next press is a new payment. */
  release(): void {
    this.held = null;
  }

  get current(): string | null {
    return this.held?.key ?? null;
  }
}

/**
 * The money figures of one Record payment entry, as typed. A replayed answer
 * to a press whose figures differ from an earlier press under the same key is
 * an earlier entry's answer; see `PaymentSubmissionKey.settle`.
 */
export function paymentFigures(boxes: {
  amount: string;
  tip: string;
  fee: string;
  total: string;
  credit: string;
}): string {
  return [boxes.amount, boxes.tip, boxes.fee, boxes.total, boxes.credit]
    .map((b) => b.trim())
    .join('\u001F'); // a separator no typed amount can contain
}

/**
 * Is the money on the answered row the money this press sent? The answer
 * carries the row's own figures, so a replay of an earlier press with other
 * figures differs from this press, and a replay of this press's own row (its
 * first answer was lost) matches. A `null` figure is one the server works out
 * (a blank Amount, #2299) and is not compared.
 */
export function answerIsThisEntry(
  answer: Pick<RecordPaymentResult, 'amountCents' | 'tipCents' | 'feeCents' | 'appliedCents' | 'creditedToAccountCents'>,
  sent: {
    amountCents: number | null;
    tipCents: number | null;
    feeCents: number;
    appliedCents: number | null;
    creditCents: number;
  },
): boolean {
  const same = (got: number, want: number | null) => want === null || got === want;
  return (
    same(answer.amountCents, sent.amountCents) &&
    same(answer.tipCents, sent.tipCents) &&
    same(answer.feeCents, sent.feeCents) &&
    same(answer.appliedCents, sent.appliedCents) &&
    same(answer.creditedToAccountCents, sent.creditCents)
  );
}

/**
 * Did the press that failed land after all? `recordPayment` writes its ledger
 * row at `payments/{key}`, and `getInvoiceLedger` lists that row under this
 * invoice with the key as its `paymentId`.
 *
 * `'unknown'` when the read itself fails. The key stays held either way.
 */
export async function paymentLandedCheck(
  readLedger: () => Promise<GetInvoiceLedgerResult>,
  key: string,
): Promise<{ landed: 'yes' | 'no' | 'unknown'; ledger: GetInvoiceLedgerResult | null }> {
  try {
    const ledger = await readLedger();
    const landed = ledger.ledgerPayments.some((row) => row.paymentId === key) ? 'yes' : 'no';
    return { landed, ledger };
  } catch {
    return { landed: 'unknown', ledger: null };
  }
}

/**
 * The callable codes that are the server's own refusal. With one of these the
 * server read the request and said no, so nothing was recorded and there is
 * nothing to look for. Every other failure (`internal`, `unavailable`,
 * `deadline-exceeded`, a timeout, a lost signal, an error with no code) may
 * have landed.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'invalid-argument',
  'failed-precondition',
  'permission-denied',
  'unauthenticated',
  'not-found',
  'already-exists',
  'out-of-range',
  'resource-exhausted',
  'aborted',
]);

/** True when a failed press may have recorded the payment anyway. */
export function paymentMayHaveLanded(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return true;
  return !REFUSAL_CODES.has(code.replace(/^functions\//, ''));
}

/**
 * What the panel says when the press that failed did land, and the second ask
 * for its answer failed as well. The payment is on the invoice; only its answer
 * is missing.
 */
export const PAYMENT_LANDED_NO_ANSWER =
  'The payment was recorded, but this screen did not get its details back. Check the payments below before recording another one.';

/**
 * What the panel says when the answer is a replay of an earlier press made
 * with other figures, or in an earlier opening of the form (see
 * `PaymentSubmissionKey.settle`). Money was recorded once: the earlier press.
 */
export const PAYMENT_EARLIER_ON_RECORD =
  'An earlier press of Record went through, and that payment is the one on record. The amounts typed after it were not recorded. Check the payments below before recording another one.';
