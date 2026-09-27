/**
 * WHICH STRIPE CHECKOUT SESSIONS TO CLOSE WHEN AN INVOICE BECOMES PAID
 * (operator ruling 2026-09-27, docket Q5).
 *
 * `payInvoice` refuses a paid invoice, but a session minted BEFORE the invoice
 * was paid stays payable at Stripe for up to 24 hours: a household with the
 * checkout page still open in a tab, or the Android portal's external browser,
 * could pay a bill that is already settled. Stripe lets a server expire an open
 * session (`checkout.sessions.expire`), after which it can no longer be paid.
 *
 * WHERE THE IDS COME FROM.
 *   `openCheckoutSessionIds`   every session `payInvoice` has minted for this
 *                              invoice (arrayUnion). The web and Android
 *                              portals send different return URLs, so each
 *                              mints its own; one stored id would miss one.
 *   `pendingCheckoutSessionId` the single id sessions minted before the list
 *                              existed carry. Read off BEFORE as well as after,
 *                              because the webhook deletes it in the same write
 *                              that marks the invoice paid.
 *
 * IDEMPOTENT. Every id the sweep has dealt with (expired it, or found it already
 * complete or expired) goes into `closedCheckoutSessionIds`, and the plan
 * subtracts that list. The sweep's own write re-fires the trigger, which then
 * finds nothing to do.
 *
 * Pure: the trigger does the reads and the Stripe calls.
 */
import { invoiceIsPaid, type InvoicePaidDoc } from './invoicePaidGate';

export const OPEN_CHECKOUT_SESSIONS_FIELD = 'openCheckoutSessionIds';
export const CLOSED_CHECKOUT_SESSIONS_FIELD = 'closedCheckoutSessionIds';

export interface SweepDoc extends InvoicePaidDoc {
  pendingCheckoutSessionId?: unknown;
  [OPEN_CHECKOUT_SESSIONS_FIELD]?: unknown;
  [CLOSED_CHECKOUT_SESSIONS_FIELD]?: unknown;
}

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

function oneId(v: unknown): string[] {
  return typeof v === 'string' && v !== '' ? [v] : [];
}

/**
 * The session ids to close for this write, or `[]`.
 *
 * Only when the invoice is paid AFTER the write. A write that leaves an unpaid
 * invoice unpaid closes nothing: those sessions are the household's way to pay.
 */
export function sessionsToClose(before: SweepDoc | undefined, after: SweepDoc | undefined): string[] {
  if (!after || !invoiceIsPaid(after)) return [];
  const closed = new Set(idList(after[CLOSED_CHECKOUT_SESSIONS_FIELD]));
  const all = [
    ...idList(after[OPEN_CHECKOUT_SESSIONS_FIELD]),
    ...oneId(after.pendingCheckoutSessionId),
    ...oneId(before?.pendingCheckoutSessionId),
    ...idList(before?.[OPEN_CHECKOUT_SESSIONS_FIELD]),
  ];
  return [...new Set(all)].filter((id) => !closed.has(id));
}
