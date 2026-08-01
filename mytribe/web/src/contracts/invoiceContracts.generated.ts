// GENERATED FILE. DO NOT EDIT.
//
// The Contracts module (CONTEXT.md), generated from the server zod schemas
// under ADR-0001 decision 2. The schema is the authority for both directions;
// this file is a projection of it and any hand edit is lost on the next run.
//
// Source:      mytribe/functions/src/{admin,portal}/*.ts (zod Args + Result)
// Regenerate:  npm --prefix mytribe/functions run contracts:generate
// Verify:      npm --prefix mytribe/functions run contracts:check
//
// CI runs the verify command and fails on any difference, so a schema change
// and its generated fallout land in one reviewable commit.

// ---------- Types shared by more than one callable ----------

/**
 * `InvoiceLineItemDto`, shared across callables.
 */
export interface InvoiceLineItemDto {
  lineId: string;
  source: 'stored' | 'session';
  sessionId: string;
  label: string;
  dateIso: string | null;
  amountCents: number | null;
  qty: number | null;
  unitCents: number | null;
}

/**
 * `InvoiceDto`, shared across callables.
 */
export interface InvoiceDto {
  id: string;
  kinfolkId: string;
  kinfolkName: string | null;
  client: string | null;
  total: number;
  amountDue: number;
  isPaid: boolean;
  status: 'quote' | 'draft' | 'cancelled' | 'credit' | 'redeemed' | 'paid' | 'zero' | 'open';
  editScope: 'all' | 'metadataOnly' | 'none' | null;
  paidCents: number;
  partiallyPaid: boolean;
  date: string | null;
  dueDate: string | null;
  discount: string | null;
  terms: string | null;
  paymentsHistory: string | null;
  address: string | null;
  viewed: boolean;
  creditAmountCents: number | null;
  creditTarget: 'accountBalance' | null;
  creditRedeemedAtMs: number | null;
  lineItems?: InvoiceLineItemDto[];
}

// ---------- archiveInvoice ----------

/**
 * Request payload for the `archiveInvoice` callable.
 */
export interface ArchiveInvoiceArgs {
  invoiceId: string;
  force?: boolean;
}

/**
 * Response from the `archiveInvoice` callable.
 */
export interface ArchiveInvoiceResult {
  ok: true;
  invoiceId: string;
}

// ---------- createInvoice ----------

/**
 * Nested in the `createInvoice` contract.
 */
export interface CreateInvoiceArgsLineItem {
  description: string;
  qty: number;
  unitCents: number;
  discountCents?: number;
}

/**
 * Request payload for the `createInvoice` callable.
 */
export interface CreateInvoiceArgs {
  familyId: string;
  /** Optional in the request; the server defaults it to ''. */
  kinfolkName?: string;
  invoiceNumber: string;
  /** Optional in the request; the server defaults it to ''. */
  client?: string;
  /** Optional in the request; the server defaults it to ''. */
  address?: string;
  /** Optional in the request; the server defaults it to ''. */
  date?: string;
  /** Optional in the request; the server defaults it to ''. */
  terms?: string;
  /** Optional in the request; the server defaults it to ''. */
  dueDate?: string;
  /** Optional in the request; the server defaults it to ''. */
  discount?: string;
  total: number;
  amountDue: number;
  /** Optional in the request; the server defaults it to ''. */
  status?: string;
  /** Optional in the request; the server defaults it to []. */
  sessionIds?: string[];
  lineItems?: CreateInvoiceArgsLineItem[];
  invoiceDiscountCents?: number;
}

/**
 * Response from the `createInvoice` callable.
 */
export interface CreateInvoiceResult {
  ok: true;
  invoiceId: string;
}

// ---------- createQuote ----------

/**
 * Request payload for the `createQuote` callable.
 */
export interface CreateQuoteArgs {
  familyId: string;
  /** Optional in the request; the server defaults it to ''. */
  kinfolkName?: string;
  invoiceNumber: string;
  /** Optional in the request; the server defaults it to ''. */
  client?: string;
  /** Optional in the request; the server defaults it to ''. */
  address?: string;
  /** Optional in the request; the server defaults it to ''. */
  date?: string;
  /** Optional in the request; the server defaults it to ''. */
  terms?: string;
  /** Optional in the request; the server defaults it to ''. */
  dueDate?: string;
  /** Optional in the request; the server defaults it to ''. */
  discount?: string;
  total: number;
  amountDue: number;
  /** Optional in the request; the server defaults it to ''. */
  status?: string;
  /** Optional in the request; the server defaults it to []. */
  sessionIds?: string[];
  /** Optional in the request; the server defaults it to false. */
  sendToKinfolk?: boolean;
}

/**
 * Response from the `createQuote` callable.
 */
export interface CreateQuoteResult {
  ok: true;
  invoiceId: string;
}

// ---------- generateInvoicePdf ----------

/**
 * Request payload for the `generateInvoicePdf` callable.
 */
export interface GenerateInvoicePdfArgs {
  invoiceId: string;
}

/**
 * Response from the `generateInvoicePdf` callable.
 */
export interface GenerateInvoicePdfResult {
  ok: true;
  invoiceId: string;
  pdfUrl: string;
}

// ---------- generateReceipt ----------

/**
 * Request payload for the `generateReceipt` callable.
 */
export interface GenerateReceiptArgs {
  invoiceId: string;
}

/**
 * Response from the `generateReceipt` callable.
 */
export interface GenerateReceiptResult {
  ok: true;
}

// ---------- getInvoiceLedger ----------

/**
 * Request payload for the `getInvoiceLedger` callable.
 */
export interface GetInvoiceLedgerArgs {
  invoiceId: string;
}

/**
 * Nested in the `getInvoiceLedger` contract.
 */
export interface GetInvoiceLedgerResultPayment {
  paymentId: string;
  amountCents: number;
  method: string | null;
  reference: string | null;
  paidAt: string | null;
  recordedBy: string | null;
}

/**
 * Nested in the `getInvoiceLedger` contract.
 */
export interface GetInvoiceLedgerResultLedgerPayment {
  paymentId: string;
  amountCents: number;
  tipCents: number;
  method: string;
  reference: string;
  date: string;
  notes: string;
  recordedBy: string | null;
}

/**
 * Nested in the `getInvoiceLedger` contract.
 */
export interface GetInvoiceLedgerResultSession {
  sessionId: string;
  serviceType: string;
  status: string;
  startTime: string;
  completedAt: string | null;
  durationMinutes: number | null;
  linkedBack: boolean;
}

/**
 * Response from the `getInvoiceLedger` callable.
 */
export interface GetInvoiceLedgerResult {
  invoiceId: string;
  payments: GetInvoiceLedgerResultPayment[];
  paidCents: number;
  totalCents: number;
  amountDueCents: number;
  ledgerPayments: GetInvoiceLedgerResultLedgerPayment[];
  sessions: GetInvoiceLedgerResultSession[];
  missingSessionIds: string[];
  orphanSessionIds: string[];
  truncated: boolean;
}

// ---------- getMyInvoicePdf ----------

/**
 * Request payload for the `getMyInvoicePdf` callable.
 */
export interface GetMyInvoicePdfArgs {
  invoiceId: string;
  kinfolkId?: string;
}

/**
 * Response from the `getMyInvoicePdf` callable.
 */
export interface GetMyInvoicePdfResult {
  ok: true;
  invoiceId: string;
  pdfUrl: string;
}

// ---------- getMyInvoices ----------

// No request type: `getMyInvoices` has no zod request schema on the server,
// so there is no authority to generate one from.

/**
 * Response from the `getMyInvoices` callable.
 */
export interface GetMyInvoicesResult {
  open: InvoiceDto[];
  paid: InvoiceDto[];
  credits: InvoiceDto[];
  accountBalanceCents: number;
}

// ---------- linkInvoiceSessions ----------

/**
 * Request payload for the `linkInvoiceSessions` callable.
 */
export interface LinkInvoiceSessionsArgs {
  invoiceId: string;
  sessionIds: string[];
}

/**
 * Response from the `linkInvoiceSessions` callable.
 */
export interface LinkInvoiceSessionsResult {
  ok: true;
  invoiceId: string;
  sessionIds: string[];
  added: string[];
  removed: string[];
  status: 'quote' | 'draft' | 'cancelled' | 'credit' | 'redeemed' | 'paid' | 'zero' | 'open';
  editScope: 'all' | 'metadataOnly' | 'none';
}

// ---------- listUninvoicedSessions ----------

/**
 * Request payload for the `listUninvoicedSessions` callable.
 * The server also enforces a cross-field rule this type cannot express (zod .refine);
 * a payload that satisfies the type can still be refused.
 */
export interface ListUninvoicedSessionsArgs {
  from: string;
  to: string;
}

/**
 * Nested in the `listUninvoicedSessions` contract.
 */
export interface ListUninvoicedSessionsResultSession {
  sessionId: string;
  kinfolkId: string;
  serviceType: string;
  durationMinutes: number;
  startTime: string;
  unitCents: number | null;
}

/**
 * Nested in the `listUninvoicedSessions` contract.
 */
export interface ListUninvoicedSessionsResultUnpriceable {
  sessionId: string;
  serviceType: string;
}

/**
 * Nested in the `listUninvoicedSessions` contract.
 */
export interface ListUninvoicedSessionsResultUnplaceable {
  sessionId: string;
  kinfolkId: string;
}

/**
 * Response from the `listUninvoicedSessions` callable.
 */
export interface ListUninvoicedSessionsResult {
  sessions: ListUninvoicedSessionsResultSession[];
  unpriceable: ListUninvoicedSessionsResultUnpriceable[];
  unplaceable: ListUninvoicedSessionsResultUnplaceable[];
  rateCardLoaded: boolean;
  scanned: number;
  truncated: boolean;
}

// ---------- markInvoicePaid ----------

/**
 * Request payload for the `markInvoicePaid` callable.
 */
export interface MarkInvoicePaidArgs {
  invoiceId: string;
  amount?: number;
  method?: string;
  reference?: string;
  paidAt?: string;
}

/**
 * Response from the `markInvoicePaid` callable.
 */
export interface MarkInvoicePaidResult {
  ok: true;
  invoiceId: string;
  paymentId: string;
  state: 'unpaid' | 'partial' | 'settled' | 'overpaid';
  totalCents: number;
  paidCents: number;
  amountDueCents: number;
  overpaidCents: number;
}

// ---------- payInvoice ----------

/**
 * Request payload for the `payInvoice` callable.
 */
export interface PayInvoiceArgs {
  invoiceId: string;
  kinfolkId?: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Response from the `payInvoice` callable.
 */
export interface PayInvoiceResult {
  checkoutUrl: string;
  sessionId: string;
  amountCents: number;
  currency: string;
}

// ---------- postInvoiceEvent ----------

/**
 * Request payload for the `postInvoiceEvent` callable.
 */
export interface PostInvoiceEventArgs {
  familyId: string;
  invoiceId: string;
  payload: Record<string, unknown>;
}

/**
 * Response from the `postInvoiceEvent` callable.
 */
export interface PostInvoiceEventResult {
  ok: true;
}

// ---------- recordPayment ----------

/**
 * Request payload for the `recordPayment` callable.
 */
export interface RecordPaymentArgs {
  /** Optional in the request; the server defaults it to ''. */
  kinfolkId?: string;
  /** Optional in the request; the server defaults it to ''. */
  kinfolkName?: string;
  /** Optional in the request; the server defaults it to ''. */
  client?: string;
  /** Optional in the request; the server defaults it to ''. */
  address?: string;
  /** Optional in the request; the server defaults it to ''. */
  date?: string;
  /** Optional in the request; the server defaults it to ''. */
  paymentMethod?: string;
  /** Optional in the request; the server defaults it to ''. */
  referenceNumber?: string;
  /** Optional in the request; the server defaults it to ''. */
  email?: string;
  amount: number;
  /** Optional in the request; the server defaults it to 0. */
  tip?: number;
  /** Optional in the request; the server defaults it to ''. */
  notes?: string;
  /** Optional in the request; the server defaults it to ''. */
  invoiceId?: string;
  /** Optional in the request; the server defaults it to ''. */
  invoiceNumber?: string;
}

/**
 * Response from the `recordPayment` callable.
 */
export interface RecordPaymentResult {
  ok: true;
  paymentId: string;
  kinfolkId: string;
}

// ---------- redeemCredit ----------

/**
 * Request payload for the `redeemCredit` callable.
 */
export interface RedeemCreditArgs {
  invoiceId: string;
  kinfolkId?: string;
  /** Optional in the request; the server defaults it to 'accountBalance'. */
  target?: 'accountBalance';
}

/**
 * Response from the `redeemCredit` callable.
 */
export interface RedeemCreditResult {
  ok: true;
  redeemedAmountCents: number;
  target: 'accountBalance';
  newAccountBalanceCents: number | null;
}

// ---------- repairInvoicePayments ----------

/**
 * Request payload for the `repairInvoicePayments` callable.
 */
export interface RepairInvoicePaymentsArgs {
  /** Optional in the request; the server defaults it to 'detect'. */
  mode?: 'detect' | 'repair';
  /** Optional in the request; the server defaults it to 200. */
  limit?: number;
  startAfterId?: string;
}

/**
 * Nested in the `repairInvoicePayments` contract.
 */
export interface RepairInvoicePaymentsResultFinding {
  invoiceId: string;
  invoiceNumber: string | null;
  kinfolkId: string | null;
  totalCents: number;
  paidCents: number;
  claimedAmountDueCents: number;
  correctAmountDueCents: number;
  understatedCents: number;
  status: string;
}

/**
 * Response from the `repairInvoicePayments` callable.
 */
export interface RepairInvoicePaymentsResult {
  ok: true;
  mode: 'detect' | 'repair';
  scanned: number;
  findings: RepairInvoicePaymentsResultFinding[];
  repaired: number;
  skipped: Record<'no_payments' | 'payments_cover_total' | 'no_total' | 'balance_already_correct' | 'would_lower_balance', number>;
  nextCursor: string | null;
}

// ---------- reviewAndSendDraftInvoice ----------

/**
 * Request payload for the `reviewAndSendDraftInvoice` callable.
 */
export interface ReviewAndSendDraftInvoiceArgs {
  invoiceId: string;
}

/**
 * Response from the `reviewAndSendDraftInvoice` callable.
 */
export interface ReviewAndSendDraftInvoiceResult {
  ok: true;
  invoiceId: string;
}

// ---------- sendInvoiceReminder ----------

/**
 * Request payload for the `sendInvoiceReminder` callable.
 */
export interface SendInvoiceReminderArgs {
  invoiceId: string;
}

/**
 * Response from the `sendInvoiceReminder` callable.
 */
export interface SendInvoiceReminderResult {
  ok: true;
  invoiceId: string;
}

// ---------- unarchiveInvoice ----------

/**
 * Request payload for the `unarchiveInvoice` callable.
 */
export interface UnarchiveInvoiceArgs {
  invoiceId: string;
}

/**
 * Response from the `unarchiveInvoice` callable.
 */
export interface UnarchiveInvoiceResult {
  ok: true;
  invoiceId: string;
}

// ---------- updateInvoice ----------

/**
 * Nested in the `updateInvoice` contract.
 */
export interface UpdateInvoiceArgsPatchLineItem {
  description: string;
  qty: number;
  unitCents: number;
  discountCents?: number;
}

/**
 * Nested in the `updateInvoice` contract.
 * The server also enforces a cross-field rule this type cannot express (zod .refine);
 * a payload that satisfies the type can still be refused.
 */
export interface UpdateInvoiceArgsPatch {
  invoiceNumber?: string;
  date?: string;
  dueDate?: string;
  terms?: string;
  kinfolkName?: string;
  client?: string;
  address?: string;
  discount?: string;
  lineItems?: UpdateInvoiceArgsPatchLineItem[];
  invoiceDiscountCents?: number;
}

/**
 * Request payload for the `updateInvoice` callable.
 */
export interface UpdateInvoiceArgs {
  invoiceId: string;
  patch: UpdateInvoiceArgsPatch;
}

/**
 * Nested in the `updateInvoice` contract.
 */
export interface UpdateInvoiceResultTotals {
  subtotalCents: number;
  totalCents: number;
  paidCents: number;
  amountDueCents: number;
}

/**
 * Response from the `updateInvoice` callable.
 */
export interface UpdateInvoiceResult {
  ok: true;
  invoiceId: string;
  totals: UpdateInvoiceResultTotals;
}
