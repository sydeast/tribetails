/**
 * Typed wrappers for the four invoice callables the kinfolk portal calls.
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
): Promise<PayInvoiceResult> {
  const payload: PayInvoiceArgs = {
    invoiceId,
    successUrl,
    cancelUrl,
    ...(kinfolkId !== undefined ? { kinfolkId } : {}),
  };
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
