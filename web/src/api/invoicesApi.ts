/**
 * Wire types + typed wrappers for the S3 invoices callables. Self-contained
 * (mirrors api/portal.ts's `call` pattern) to avoid touching api/types.ts or
 * api/portal.ts while other S3 sessions port other screens in parallel.
 *
 * Every DTO below is transcribed from its backend handler; each block cites
 * its source file. Field names/types/defaults MUST stay in sync with those
 * files.
 */
import { call } from '../lib/fns';

// ── getMyInvoices (functions/src/portal/getMyInvoices.ts) ───────────────────

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'credit' | 'cancelled';
export type CreditTarget = 'accountBalance' | 'originalPaymentMethod';

export interface InvoiceLineItemDto {
  sessionId: string;
  /** Service type of the visit, e.g. "30Minute". */
  label: string;
  /** Session start (ISO string) or its date field; null when the session carries neither. */
  dateIso: string | null;
  amountCents: number | null;
}

export interface InvoiceDto {
  id: string;
  kinfolkId: string;
  kinfolkName: string | null;
  client: string | null;
  total: number;
  amountDue: number;
  isPaid: boolean;
  status: InvoiceStatus;
  date: string | null;
  dueDate: string | null;
  discount: string | null;
  terms: string | null;
  paymentsHistory: string | null;
  address: string | null;
  viewed: boolean;
  // Credit-specific (only meaningful when status === 'credit')
  creditAmountCents: number | null;
  creditTarget: CreditTarget | null;
  creditRedeemedAtMs: number | null;
  originalPaymentIntentId: string | null;
  /**
   * Per-visit line items resolved from the invoice's `sessionIds`. OPTIONAL:
   * absent when the invoice carries no sessionIds or the session lookups
   * failed — never fails the whole call.
   */
  lineItems?: InvoiceLineItemDto[];
}

export interface GetMyInvoicesRequest {
  kinfolkId?: string;
}

export interface GetMyInvoicesResult {
  open: InvoiceDto[];
  paid: InvoiceDto[];
  credits: InvoiceDto[];
  accountBalanceCents: number;
}

/** The signed-in kinfolk's invoices, bucketed open/paid/credits + account balance. */
export function getMyInvoices(kinfolkId?: string): Promise<GetMyInvoicesResult> {
  const payload: GetMyInvoicesRequest = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<GetMyInvoicesRequest, GetMyInvoicesResult>('getMyInvoices', payload);
}

// ── getMyInvoicePdf (functions/src/portal/getMyInvoicePdf.ts) ───────────────

export interface GetMyInvoicePdfRequest {
  invoiceId: string;
  kinfolkId?: string;
}

export interface GetMyInvoicePdfResult {
  ok: true;
  invoiceId: string;
  pdfUrl: string;
}

/** Renders + stores the invoice PDF server-side and returns a download URL. */
export function getMyInvoicePdf(invoiceId: string, kinfolkId?: string): Promise<GetMyInvoicePdfResult> {
  const payload: GetMyInvoicePdfRequest = { invoiceId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<GetMyInvoicePdfRequest, GetMyInvoicePdfResult>('getMyInvoicePdf', payload);
}

// ── payInvoice (functions/src/portal/payInvoice.ts) ──────────────────────────

export interface PayInvoiceRequest {
  invoiceId: string;
  kinfolkId?: string;
  successUrl: string;
  cancelUrl: string;
}

export interface PayInvoiceResult {
  /** Stripe-hosted Checkout URL; open via window.location on web. */
  checkoutUrl: string;
  sessionId: string;
  amountCents: number;
  currency: string;
}

/**
 * Creates a Stripe Checkout Session for the invoice and returns its hosted
 * URL. REAL CHARGE FLOW: the caller is expected to redirect the browser to
 * `checkoutUrl` (window.location.href), not fetch/open it programmatically
 * in a way that could be triggered by an automated test.
 */
export function payInvoice(
  invoiceId: string,
  successUrl: string,
  cancelUrl: string,
  kinfolkId?: string,
): Promise<PayInvoiceResult> {
  const payload: PayInvoiceRequest = {
    invoiceId,
    successUrl,
    cancelUrl,
    ...(kinfolkId !== undefined ? { kinfolkId } : {}),
  };
  return call<PayInvoiceRequest, PayInvoiceResult>('payInvoice', payload);
}

// ── redeemCredit (functions/src/portal/redeemCredit.ts) ─────────────────────

export interface RedeemCreditRequest {
  invoiceId: string;
  kinfolkId?: string;
  target: CreditTarget;
}

export interface RedeemCreditResult {
  ok: true;
  redeemedAmountCents: number;
  target: CreditTarget;
  newAccountBalanceCents: number | null;
  refundId: string | null;
}

/** Redeems a credit invoice into the account balance or a refund to the original card. */
export function redeemCredit(invoiceId: string, target: CreditTarget, kinfolkId?: string): Promise<RedeemCreditResult> {
  const payload: RedeemCreditRequest = { invoiceId, target, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<RedeemCreditRequest, RedeemCreditResult>('redeemCredit', payload);
}
