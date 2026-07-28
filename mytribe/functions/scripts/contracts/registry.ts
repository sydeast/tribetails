/**
 * What gets generated: the invoice surface, both directions (ADR-0001
 * decision 2, step W3-2).
 *
 * THIS LIST IS THE SCOPE, and it is hand-written on purpose. Discovering
 * callables by globbing `src/**` would silently start generating a client type
 * the moment someone exported a `Result`, which is how a half-designed
 * response shape ends up shipped to three apps. Adding a line here is the
 * decision to publish that contract.
 *
 * The 19 callables below are exactly the ones PR #112 gave response schemas
 * and outbound validation. The remaining ~150 callables have no response
 * schema yet, so there is nothing to generate from; they arrive as their
 * schemas do.
 *
 * `getMyInvoices` is the one entry with no request schema. Its handler reads a
 * hand-written `interface GetMyInvoicesRequest`, not zod, so there is no
 * authority to generate a request type from. The generated files say so at
 * that callable rather than leaving a reader to wonder.
 */
import type { z } from 'zod';

import { Args as ArchiveInvoiceArgs, Result as ArchiveInvoiceResult } from '../../src/admin/archiveInvoice';
import { Args as CreateInvoiceArgs, Result as CreateInvoiceResult } from '../../src/admin/createInvoice';
import { Args as CreateQuoteArgs, Result as CreateQuoteResult } from '../../src/admin/createQuote';
import { Args as GenerateInvoicePdfArgs, Result as GenerateInvoicePdfResult } from '../../src/admin/generateInvoicePdf';
import { Args as GenerateReceiptArgs, Result as GenerateReceiptResult } from '../../src/admin/generateReceipt';
import { Args as LinkInvoiceSessionsArgs, Result as LinkInvoiceSessionsResult } from '../../src/admin/linkInvoiceSessions';
import { Args as ListUninvoicedSessionsArgs, Result as ListUninvoicedSessionsResult } from '../../src/admin/listUninvoicedSessions';
import { Args as MarkInvoicePaidArgs, Result as MarkInvoicePaidResult } from '../../src/admin/markInvoicePaid';
import { Args as PostInvoiceEventArgs, Result as PostInvoiceEventResult } from '../../src/admin/postInvoiceEvent';
import { Args as RecordPaymentArgs, Result as RecordPaymentResult } from '../../src/admin/recordPayment';
import { Args as RepairInvoicePaymentsArgs, Result as RepairInvoicePaymentsResult } from '../../src/admin/repairInvoicePayments';
import { Args as ReviewAndSendDraftInvoiceArgs, Result as ReviewAndSendDraftInvoiceResult } from '../../src/admin/reviewAndSendDraftInvoice';
import { Args as SendInvoiceReminderArgs, Result as SendInvoiceReminderResult } from '../../src/admin/sendInvoiceReminder';
import { Args as UnarchiveInvoiceArgs, Result as UnarchiveInvoiceResult } from '../../src/admin/unarchiveInvoice';
import { Args as UpdateInvoiceArgs, Result as UpdateInvoiceResult } from '../../src/admin/updateInvoice';
import { Args as GetMyInvoicePdfArgs, Result as GetMyInvoicePdfResult } from '../../src/portal/getMyInvoicePdf';
import {
  InvoiceDtoSchema,
  InvoiceLineItemDtoSchema,
  Result as GetMyInvoicesResult,
} from '../../src/portal/getMyInvoices';
import { Args as PayInvoiceArgs, Result as PayInvoiceResult } from '../../src/portal/payInvoice';
import { Args as RedeemCreditArgs, Result as RedeemCreditResult } from '../../src/portal/redeemCredit';

/** One callable's request and response authority. */
export interface CallableContract {
  /** The deployed callable name, as the clients call it. */
  name: string;
  /** The exported zod `Args`, or null when the callable has no zod request schema. */
  args: z.ZodType | null;
  /** The exported zod `Result`. Required: a callable with no response schema is out of scope. */
  result: z.ZodType;
}

/**
 * A schema reached from more than one place, named once.
 *
 * Without this, `getMyInvoices`'s three buckets would generate three identical
 * copies of the 20-field invoice DTO named after whichever bucket happened to
 * be walked first. The name is pinned by SCHEMA IDENTITY, not by shape, so two
 * types that merely look alike today stay two types.
 */
export interface SharedContractSchema {
  name: string;
  schema: z.ZodType;
  /** Whether the shared type needs an encoder, a decoder, or (via a callable) both. */
  direction: 'request' | 'response';
}

export interface ContractRegistry {
  shared: SharedContractSchema[];
  callables: CallableContract[];
}

export const INVOICE_CONTRACT_REGISTRY: ContractRegistry = {
  shared: [
    { name: 'InvoiceLineItemDto', schema: InvoiceLineItemDtoSchema, direction: 'response' },
    { name: 'InvoiceDto', schema: InvoiceDtoSchema, direction: 'response' },
  ],
  callables: [
    { name: 'archiveInvoice', args: ArchiveInvoiceArgs, result: ArchiveInvoiceResult },
    { name: 'createInvoice', args: CreateInvoiceArgs, result: CreateInvoiceResult },
    { name: 'createQuote', args: CreateQuoteArgs, result: CreateQuoteResult },
    { name: 'generateInvoicePdf', args: GenerateInvoicePdfArgs, result: GenerateInvoicePdfResult },
    { name: 'generateReceipt', args: GenerateReceiptArgs, result: GenerateReceiptResult },
    { name: 'getMyInvoicePdf', args: GetMyInvoicePdfArgs, result: GetMyInvoicePdfResult },
    // No zod request schema; see the module header.
    { name: 'getMyInvoices', args: null, result: GetMyInvoicesResult },
    { name: 'linkInvoiceSessions', args: LinkInvoiceSessionsArgs, result: LinkInvoiceSessionsResult },
    { name: 'listUninvoicedSessions', args: ListUninvoicedSessionsArgs, result: ListUninvoicedSessionsResult },
    { name: 'markInvoicePaid', args: MarkInvoicePaidArgs, result: MarkInvoicePaidResult },
    { name: 'payInvoice', args: PayInvoiceArgs, result: PayInvoiceResult },
    { name: 'postInvoiceEvent', args: PostInvoiceEventArgs, result: PostInvoiceEventResult },
    { name: 'recordPayment', args: RecordPaymentArgs, result: RecordPaymentResult },
    { name: 'redeemCredit', args: RedeemCreditArgs, result: RedeemCreditResult },
    { name: 'repairInvoicePayments', args: RepairInvoicePaymentsArgs, result: RepairInvoicePaymentsResult },
    { name: 'reviewAndSendDraftInvoice', args: ReviewAndSendDraftInvoiceArgs, result: ReviewAndSendDraftInvoiceResult },
    { name: 'sendInvoiceReminder', args: SendInvoiceReminderArgs, result: SendInvoiceReminderResult },
    { name: 'unarchiveInvoice', args: UnarchiveInvoiceArgs, result: UnarchiveInvoiceResult },
    { name: 'updateInvoice', args: UpdateInvoiceArgs, result: UpdateInvoiceResult },
  ],
};
