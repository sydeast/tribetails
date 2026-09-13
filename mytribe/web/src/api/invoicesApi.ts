/**
 * Typed wrappers for the six invoice callables the kinfolk portal calls.
 *
 * THE SHAPES ARE NOT DEFINED HERE. They come from
 * `../contracts/invoiceContracts.generated`, projected from the server zod
 * schemas under ADR-0001. This file used to transcribe them field for field,
 * and that transcription is the exact defect the ADR was written about: a
 * rename in `functions/src/portal/getMyInvoices.ts` reached a household as a
 * blank field on a bill, and nothing between the two failed on the way.
 *
 * What is left below is the part a generator cannot write: the argument order
 * a screen calls, and the prose about what these four operations mean.
 */
import { call } from '../lib/fns';
import type {
  AcceptQuoteArgs,
  AcceptQuoteResult,
  DenyQuoteArgs,
  DenyQuoteResult,
  GetMyInvoicePdfArgs,
  GetMyInvoicePdfResult,
  GetMyInvoicesResult,
  PayInvoiceArgs,
  PayInvoiceResult,
  RedeemCreditArgs,
  RedeemCreditResult,
} from '../contracts/invoiceContracts.generated';

// ── getMyInvoices (functions/src/portal/getMyInvoices.ts) ───────────────────

/**
 * HAND-WRITTEN ON PURPOSE, and the only shape in this file that still is.
 *
 * `getMyInvoices` parses its request against a plain TypeScript interface
 * rather than a zod schema, so there is no authority to generate a request
 * type from and the codegen emits none. The generated file says so where the
 * type would otherwise sit. This mirrors
 * `functions/src/portal/getMyInvoices.ts:19-21`, and it is the one thing here
 * a server rename can still break silently. Converting that handler to zod is
 * a separate concern; it retires this interface when it lands.
 *
 * The RESPONSE half is generated: `GetMyInvoicesResult` and the 22-field
 * `InvoiceDto` behind it now come from the schema that validates the response
 * outbound.
 */
export interface GetMyInvoicesRequest {
  kinfolkId?: string;
}

/** The signed-in kinfolk's invoices, bucketed open/paid/credits + account balance. */
export function getMyInvoices(kinfolkId?: string): Promise<GetMyInvoicesResult> {
  const payload: GetMyInvoicesRequest = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<GetMyInvoicesRequest, GetMyInvoicesResult>('getMyInvoices', payload);
}

// ── getMyInvoicePdf (functions/src/portal/getMyInvoicePdf.ts) ───────────────

/** Renders + stores the invoice PDF server-side and returns a download URL. */
export function getMyInvoicePdf(invoiceId: string, kinfolkId?: string): Promise<GetMyInvoicePdfResult> {
  const payload: GetMyInvoicePdfArgs = { invoiceId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<GetMyInvoicePdfArgs, GetMyInvoicePdfResult>('getMyInvoicePdf', payload);
}

// ── payInvoice (functions/src/portal/payInvoice.ts) ──────────────────────────

/**
 * Creates a Stripe Checkout Session for the invoice and returns its hosted
 * URL. REAL CHARGE FLOW: the caller is expected to redirect the browser to
 * `checkoutUrl` (window.location.href), not fetch/open it programmatically
 * in a way that could be triggered by an automated test.
 *
 * `amountCents` on the result is the REMAINING balance, not the invoice total.
 * On a part-paid invoice those differ, and it is the figure Stripe was
 * actually asked to charge.
 */
export function payInvoice(
  invoiceId: string,
  successUrl: string,
  cancelUrl: string,
  kinfolkId?: string,
  idempotencyKey?: string,
): Promise<PayInvoiceResult> {
  const payload: PayInvoiceArgs = {
    invoiceId,
    successUrl,
    cancelUrl,
    ...(kinfolkId !== undefined ? { kinfolkId } : {}),
    // #825. Handed straight to Stripe as a request option by the callable, not
    // checked here or in Firestore: the duplicate a replay makes is a second
    // Checkout Session in STRIPE's database, so Stripe is the only party that
    // can decline to make it. #826's webhook stops a second charge PAYING the
    // bill twice, but it cannot un-charge a card; this stops the second session
    // existing. `lib/moneyIdempotency.ts` has the full reasoning, including why
    // a key is held per submission rather than per invoice.
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
  // NO `{ idempotent: true }` HERE. `CallOptions.idempotent` retries on
  // `functions/internal`, and the claim it makes is about the SERVER deduping.
  // Stripe dedupes the SESSION, but this callable also writes
  // `pendingCheckoutSessionId` and logs, and more to the point a household
  // watching a Pay button should be told the tap failed rather than have the
  // app quietly try again and then redirect them to a payment page. The retry
  // here is the person, which is exactly what the key protects.
  return call<PayInvoiceArgs, PayInvoiceResult>('payInvoice', payload);
}

// ── redeemCredit (functions/src/portal/redeemCredit.ts) ─────────────────────

/**
 * Redeems a credit invoice into the household's account balance.
 *
 * There is no target to choose: credits are NOT refundable, so a kinfolk cannot
 * ask for money back to their card. The former 'originalPaymentMethod' target
 * and its Stripe refund leg were removed on 2026-07-20.
 *
 * `RedeemCreditArgs` carries an optional `target: 'accountBalance'` that the
 * hand-written request type did not have and that this call still does not
 * send. The server defaults it, so the omission is correct; the single-value
 * literal exists so an older client sending `{target:'accountBalance'}` keeps
 * working while one sending `'originalPaymentMethod'` fails loudly at
 * validation instead of quietly doing something else.
 */
export function redeemCredit(invoiceId: string, kinfolkId?: string): Promise<RedeemCreditResult> {
  const payload: RedeemCreditArgs = { invoiceId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<RedeemCreditArgs, RedeemCreditResult>('redeemCredit', payload);
}

// ── acceptQuote / denyQuote (functions/src/portal/quoteDecision.ts) ─────────

/**
 * The household's answer to a quote. Until issue #385 there was no way to give
 * one: the catalog carried `quote.accepted` and `quote.denied` as switches on
 * the notification gate, and no callable behind either.
 *
 * ACCEPTING TURNS THE QUOTE INTO A BILL. The server re-stamps the doc, so the
 * result's `status` comes back `open` and the Pay button appears on the next
 * read. Declining leaves it a quote, marked with the decision.
 *
 * Both refuse a quote that has already been answered, and accept refuses one
 * whose due date has passed. THE SERVER IS THE AUTHORITY ON BOTH: the screens
 * surface the message it sends rather than re-deriving the rule, so a household
 * is never told "expired" by a client whose clock disagrees with the office's.
 */
export function acceptQuote(invoiceId: string, kinfolkId?: string): Promise<AcceptQuoteResult> {
  const payload: AcceptQuoteArgs = { invoiceId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<AcceptQuoteArgs, AcceptQuoteResult>('acceptQuote', payload);
}

export function denyQuote(invoiceId: string, kinfolkId?: string): Promise<DenyQuoteResult> {
  const payload: DenyQuoteArgs = { invoiceId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<DenyQuoteArgs, DenyQuoteResult>('denyQuote', payload);
}
