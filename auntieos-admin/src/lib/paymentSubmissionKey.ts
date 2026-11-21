import type { GetInvoiceLedgerResult } from '../contracts/invoiceContracts.generated';
import { mintPaymentIdempotencyKey } from './moneyIdempotency';

/**
 * #2297: THE KEY ONE OPENING OF RECORD PAYMENT HOLDS.
 *
 * `recordPayment` dedupes on the key (#825): a second press with the same key
 * is answered from the row the first press wrote, if it wrote one. So whether
 * a lost reply turns into one payment or two is decided by when the screen
 * keeps its key and when it mints a new one. The rules, the same on admin web,
 * admin Android and the desktop console:
 *
 *   - ONE OPENING, ONE KEY. Opening Record payment starts with no key, and
 *     closing it (Cancel, or a payment that went through) lets the key go. A
 *     second payment entered after the form was closed is a new payment, even
 *     when every box matches the first (two equal cash instalments on one day).
 *   - A RE-PRESS OF THE SAME FIGURES KEEPS THE KEY. Only the money decides
 *     what "the same entry" is: the amount, the tip, the fee, the payment
 *     amount and the credit. Fixing a note, the method, the reference, or
 *     ticking the confirmation is a retry of the same payment, and before this
 *     the web screen minted a new key for each of those, so a lost reply
 *     followed by a fixed note recorded the payment twice.
 *   - PINNED WHEN NOBODY KNOWS. After a failed press the screen reads the
 *     invoice's payments again (`paymentLandedCheck`). When that read fails
 *     too, nobody knows whether the first press landed, so the key is pinned
 *     for the rest of this opening, whatever is edited. A changed figure then
 *     gets the first payment's answer if it did land, which is the truth,
 *     rather than a second payment.
 */
export class PaymentSubmissionKey {
  private held: { key: string; figures: string; pinned: boolean } | null = null;

  constructor(private readonly mint: () => string = mintPaymentIdempotencyKey) {}

  /** The key for a press of these figures, minting one only when needed. */
  keyFor(figures: string): string {
    const held = this.held;
    if (held !== null && (held.pinned || held.figures === figures)) return held.key;
    const key = this.mint();
    this.held = { key, figures, pinned: false };
    return key;
  }

  /** The last press failed and the read that would have said whether it landed failed as well. */
  pin(): void {
    if (this.held !== null) this.held = { ...this.held, pinned: true };
  }

  /** The form closed, or the payment went through: the next press is a new payment. */
  release(): void {
    this.held = null;
  }

  get current(): string | null {
    return this.held?.key ?? null;
  }
}

/**
 * The money figures of one Record payment entry, as typed. Two presses with
 * the same figures are the same payment; see `PaymentSubmissionKey`.
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
 * Did the press that failed land after all? `recordPayment` writes its ledger
 * row at `payments/{key}`, and `getInvoiceLedger` lists that row under this
 * invoice with the key as its `paymentId`.
 *
 * `'unknown'` when the read itself fails: the caller then pins the key.
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
