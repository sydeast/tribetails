/**
 * #2437: A FINISHED CARD PAYMENT THAT IS NOT ON THE INVOICE YET.
 *
 * After a household pays at Stripe, the invoice keeps reading owed until the
 * card webhook records the payment, usually a few seconds later. In that gap
 * `payInvoice` used to open a second checkout: it read the invoice's last
 * checkout back from Stripe, saw it was no longer open, and made a new one. A
 * second payment made then is a real charge, the webhook holds it for the
 * owner (#2385), and there are no refunds. The screens hold Pay back after a
 * return from Stripe, but a second window, a reload, or a return by hand does
 * not carry that hold. So the server refuses.
 *
 * ── TWO FACTS, FROM THE TWO PLACES THAT HOLD THEM ─────────────────────────
 *
 *   FINISHED   Stripe. A Checkout Session reading `complete` and `paid` for
 *              this invoice. Nothing this server stores says so before the
 *              webhook lands, which is the whole gap.
 *   RECORDED   This server. `stripePayments/{paymentIntentId}`, the claim the
 *              webhook writes in the same commit as its decision, whether the
 *              payment went on the invoice or was held for the owner. A
 *              payment with a claim has been dealt with, and Pay is offered
 *              again for whatever is still owed.
 *
 * The settlement round is not asked. A held payment never moves it, so it
 * cannot say "recorded".
 *
 * ── WHICH CHECKOUTS ARE READ ──────────────────────────────────────────────
 *
 * The ones `payInvoice` stored on the invoice: `pendingCheckoutSessionId`
 * first, then `openCheckoutSessionIds` newest first, without those the sweep
 * has closed. More than one exists when two clients sent different return
 * addresses (an older Android build), and the household can pay on either
 * page. At most `MAX_CHECKOUT_SESSIONS_READ`, read together.
 *
 * ── A PAYMENT THAT NEVER LANDS DOES NOT HOLD PAY FOR EVER ─────────────────
 *
 * The hold lasts `PAYMENT_RECORDING_WINDOW_MS` from the moment the card was
 * charged (the charge's own time at Stripe, never the time the checkout was
 * opened: a checkout can sit open for hours before it is paid). After that
 * `payInvoice` carries on as it did before, with a warning for the operator,
 * and the webhook still decides what each payment becomes when it arrives.
 *
 * ANY DOUBT OPENS THE CHECKOUT. A checkout that cannot be read, one that
 * finished unpaid or names another invoice, a payment whose time cannot be
 * read: none of them holds Pay. A household is never stopped from paying a
 * bill because an old id could not be inspected.
 *
 * Pure: `portal/payInvoice.ts` does the reads.
 */
import { CLOSED_CHECKOUT_SESSIONS_FIELD, OPEN_CHECKOUT_SESSIONS_FIELD } from './checkoutSessionSweep';

/** `HttpsError` `details.code` when `payInvoice` refuses for a payment still being recorded. */
export const PAYMENT_BEING_RECORDED_CODE = 'payment_being_recorded';

/**
 * The sentence the household is given. It is the error's own message, so a
 * portal build from before this change prints it where it prints any refusal.
 * "A payment", not "your payment": the person pressing Pay may not be the one
 * who paid.
 */
export const PAYMENT_BEING_RECORDED = 'A payment on this invoice is still being recorded. Check again in a minute.';

/** How long after the card was charged an unrecorded payment holds Pay. */
export const PAYMENT_RECORDING_WINDOW_MS = 15 * 60 * 1000;

/** The most stored checkouts read back from Stripe for one Pay. */
export const MAX_CHECKOUT_SESSIONS_READ = 4;

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/**
 * The stored checkout ids to read for this invoice, most likely first: the
 * pending one, then the rest newest first (`arrayUnion` appends). Ids the
 * sweep has closed are left out, except the pending one, which the reuse
 * reads anyway.
 */
export function checkoutSessionIdsToRead(invoice: Record<string, unknown> | null | undefined): string[] {
  const pending = invoice?.['pendingCheckoutSessionId'];
  const closed = new Set(idList(invoice?.[CLOSED_CHECKOUT_SESSIONS_FIELD]));
  const stored = idList(invoice?.[OPEN_CHECKOUT_SESSIONS_FIELD])
    .filter((id) => !closed.has(id))
    .reverse();
  const all = typeof pending === 'string' && pending !== '' ? [pending, ...stored] : stored;
  return [...new Set(all)].slice(0, MAX_CHECKOUT_SESSIONS_READ);
}

/** A checkout Stripe says finished with the money collected. */
export interface FinishedCheckout {
  sessionId: string;
  paymentIntentId: string;
}

/**
 * The finished, paid checkout in a Stripe session read, or null.
 *
 * `complete` alone is not enough: a session can complete with the money still
 * pending (`payment_status: 'unpaid'`), and the webhook ignores that one too.
 * It must name this invoice, and it must name its PaymentIntent, because that
 * id is the only way to ask whether the payment was recorded.
 */
export function finishedCheckoutOf(raw: unknown, invoiceId: string): FinishedCheckout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as {
    id?: unknown;
    status?: unknown;
    payment_status?: unknown;
    payment_intent?: unknown;
    metadata?: Record<string, unknown> | null;
  };
  if (s.status !== 'complete' || s.payment_status !== 'paid') return null;
  if (typeof s.id !== 'string' || s.id === '') return null;
  if (s.metadata?.['invoiceId'] !== invoiceId) return null;
  const intent = s.payment_intent;
  const paymentIntentId =
    typeof intent === 'string'
      ? intent
      : typeof intent === 'object' && intent !== null && typeof (intent as { id?: unknown }).id === 'string'
        ? (intent as { id: string }).id
        : '';
  if (paymentIntentId === '') return null;
  return { sessionId: s.id, paymentIntentId };
}

/**
 * When the card was charged, in epoch milliseconds, off a PaymentIntent read
 * with its `latest_charge` expanded. Null when the charge or its time is not
 * there, and the caller then holds nothing.
 */
export function chargeTimeMsOf(paymentIntent: unknown): number | null {
  if (typeof paymentIntent !== 'object' || paymentIntent === null) return null;
  const charge = (paymentIntent as { latest_charge?: unknown }).latest_charge;
  if (typeof charge !== 'object' || charge === null) return null;
  const created = (charge as { created?: unknown }).created;
  return typeof created === 'number' && Number.isFinite(created) && created > 0 ? created * 1000 : null;
}

/** Whether a payment charged at `paidAtMs` and not yet recorded still holds Pay at `nowMs`. */
export function holdsPay(paidAtMs: number, nowMs: number): boolean {
  return nowMs - paidAtMs < PAYMENT_RECORDING_WINDOW_MS;
}
