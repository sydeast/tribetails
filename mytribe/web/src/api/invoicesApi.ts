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

/**
 * The stored Invoice State Stamp's vocabulary (ADR-0002): all eight canonical
 * lowercase states, persisted server-side by every money-touching callable
 * and shipped verbatim — the portal renders this, it never classifies.
 * Bucketing (which of open/paid/credits an invoice arrives in) is also
 * decided server-side: open/draft/quote/zero → `open`, paid → `paid`,
 * credit/redeemed → `credits`, cancelled → excluded.
 */
export type InvoiceStatus = 'quote' | 'draft' | 'cancelled' | 'credit' | 'redeemed' | 'paid' | 'zero' | 'open';
/** The stamp's edit-affordance half. The portal has no edit UI; shipped for parity. */
export type InvoiceEditScope = 'all' | 'metadataOnly' | 'none';
/** Account balance is the only redemption target: credits are NOT refundable. */
export type CreditTarget = 'accountBalance';

export interface InvoiceLineItemDto {
  /**
   * Stable key for one row, unique within an invoice. Use this and NOT
   * `sessionId`, which is empty on a stored line, so every stored row would
   * otherwise share one key.
   */
  lineId: string;
  /**
   * `stored` is what the operator actually billed, read off the invoice's own
   * `lineItems`. `session` is the legacy fallback derived from `sessionIds` for
   * an invoice with no lines. Never mixed on one invoice.
   */
  source: 'stored' | 'session';
  /** The session behind a derived row. Empty on a stored line. */
  sessionId: string;
  /** The billed description, or the visit's service type on a derived row. */
  label: string;
  /** Visit date on a derived row. Null on a stored line, which carries no date. */
  dateIso: string | null;
  amountCents: number | null;
  /** Stored lines only. */
  qty: number | null;
  unitCents: number | null;
}

export interface InvoiceDto {
  id: string;
  kinfolkId: string;
  kinfolkName: string | null;
  client: string | null;
  total: number;
  amountDue: number;
  isPaid: boolean;
  /**
   * The stored Invoice State Stamp (ADR-0002), read off the doc server-side,
   * never re-derived. See the bucket map on `InvoiceStatus`.
   */
  status: InvoiceStatus;
  /**
   * The stamp's second half: how much of this invoice may still change.
   * Null when the doc carries no stored scope (pre-backfill sandbox seeds).
   * No portal screen branches on it yet; it ships for stamp parity.
   */
  editScope: InvoiceEditScope | null;
  /**
   * What has been collected against this invoice, in integer cents.
   *
   * 0 on an invoice that predates the field, which is honest rather than
   * flattering. NEVER re-derive it from `total - amountDue`: those are float
   * dollars, and on every invoice the pre-2026-07-25 partial-payment write
   * touched `amountDue` reads 0 while a real balance is owed, so that
   * subtraction reports the entire total as collected on exactly the wrong ones.
   */
  paidCents: number;
  /**
   * Money has come in and it does NOT cover this invoice.
   *
   * `status` stays `open`, so the invoice keeps its payable behaviour and its
   * bucket; this is the flag that lets the screen say what is actually true.
   * Showing a part-paid invoice as plain "PENDING" hides the payment already
   * made; showing it as paid hides the balance still owed.
   */
  partiallyPaid: boolean;
  date: string | null;
  dueDate: string | null;
  discount: string | null;
  terms: string | null;
  paymentsHistory: string | null;
  address: string | null;
  viewed: boolean;
  // Credit-specific (only meaningful when status is 'credit' or 'redeemed' —
  // 'redeemed' is what the stamp writes once `creditRedeemedAt` is set)
  creditAmountCents: number | null;
  creditTarget: CreditTarget | null;
  creditRedeemedAtMs: number | null;
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
}

export interface RedeemCreditResult {
  ok: true;
  redeemedAmountCents: number;
  target: 'accountBalance';
  newAccountBalanceCents: number | null;
}

/**
 * Redeems a credit invoice into the household's account balance.
 *
 * There is no target to choose: credits are NOT refundable, so a kinfolk cannot
 * ask for money back to their card. The former 'originalPaymentMethod' target
 * and its Stripe refund leg were removed on 2026-07-20.
 */
export function redeemCredit(invoiceId: string, kinfolkId?: string): Promise<RedeemCreditResult> {
  const payload: RedeemCreditRequest = { invoiceId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<RedeemCreditRequest, RedeemCreditResult>('redeemCredit', payload);
}
