/**
 * The shared reading of `archivedAt`, used by both archiveInvoice and
 * unarchiveInvoice so the two can never disagree about what "archived" means.
 *
 * WHY PRESENCE, NOT TRUTHINESS, AND WHY THIS IS NOT A FIRESTORE PREDICATE.
 *
 * Every invoice that exists today lacks this field entirely: nothing wrote it
 * before Task 5.1. Firestore's `== null` matches ONLY documents that HAVE the
 * field set to null, so `where('archivedAt', '==', null)` would return zero
 * invoices, and it would do it silently rather than erroring. This task starts
 * writing the field, which does NOT retroactively give it to the invoices
 * already in the collection.
 *
 * So the admin list keeps excluding archived rows with a presence check over the
 * rows it has already loaded (`auntieos-admin/src/api/invoices.ts#isArchivedInvoice`),
 * and the deployed `invoices (archivedAt ASC, date DESC)` index stays unused for
 * that purpose. Converting the exclusion to a server-side predicate needs a
 * backfill stamping `archivedAt: null` onto every legacy invoice FIRST. That is
 * a migration, and it is deliberately not part of this task.
 *
 * `unarchiveInvoice` writes `archivedAt: null` rather than deleting the field,
 * for two reasons: a restored invoice then carries the same shape a backfill
 * would give it, and the admin's reader already treats null as "not archived".
 */

import { HttpsError } from 'firebase-functions/v2/https';
import { formatUsd, formatUsdCents } from './invoiceMath';

export interface ArchivableInvoice {
  kinfolkId?: string;
  invoiceNumber?: string;
  status?: unknown;
  amountDue?: unknown;
  amountDueCents?: unknown;
  total?: unknown;
  archivedAt?: unknown;
  [k: string]: unknown;
}

/** Archived iff `archivedAt` is present AND not null. */
export function isArchived(doc: ArchivableInvoice): boolean {
  return doc.archivedAt !== undefined && doc.archivedAt !== null;
}

/**
 * What is still owed, in DOLLARS.
 *
 * Prefers `amountDueCents` when the invoice has been itemized (it is the exact
 * figure), and falls back to the legacy dollar scalar otherwise. A non-finite or
 * absent value reads as 0, which means "no evidence of a debt" rather than a
 * fabricated one: refusing to archive on the strength of a number we could not
 * read would block the operator over a field that is not there.
 */
export function amountStillOwed(doc: ArchivableInvoice): number {
  if (typeof doc.amountDueCents === 'number' && Number.isFinite(doc.amountDueCents)) {
    return doc.amountDueCents / 100;
  }
  if (typeof doc.amountDue === 'number' && Number.isFinite(doc.amountDue)) {
    return doc.amountDue;
  }
  return 0;
}

/** `details.code` of the refusal below. */
export const INVOICE_ARCHIVED_CODE = 'invoice_archived';

/**
 * #2168: AN ARCHIVED INVOICE IS READ-ONLY UNTIL IT IS RESTORED.
 *
 * Archiving a draft lets go of its visits (`archiveInvoice`), and only
 * `unarchiveInvoice` takes them back, checking each one is still free. A send,
 * an Edit or a Link visits on an archived invoice would go round that check: a
 * draft sent while archived bills visits that are back on the un-invoiced list,
 * and an Edit or a link made while archived claims or drops visits the restore
 * then cannot account for. Every callable that writes an invoice's lines or
 * its visits calls this on the snapshot its transaction read, in every state,
 * not only on drafts.
 */
export function refuseIfArchived(doc: ArchivableInvoice): void {
  if (!isArchived(doc)) return;
  throw new HttpsError('failed-precondition', 'This invoice is archived. Restore it before sending or changing it.', {
    code: INVOICE_ARCHIVED_CODE,
  });
}

/** "$40.00" from a dollar amount, for the refusal message. */
export function formatOwed(dollars: number): string {
  return formatUsd(Math.abs(dollars));
}

// ── #2090: the write-off ─────────────────────────────────────────────────────

/**
 * #2090: WRITING OFF WHAT IS LEFT ON AN INVOICE, and the rules every money
 * writer shares about an invoice that has been written off.
 *
 * Operator ruling 2026-11-12: "Archive is only tidying." An invoice with money
 * owed cannot be archived (`admin/archiveInvoice.ts`). Writing the balance off
 * is its own owner-only action with its own confirm (`writeOffInvoice` in `admin/archiveInvoice.ts`),
 * after which the household is no longer asked to pay and archiving is allowed.
 *
 * WHAT A WRITE-OFF IS, AND WHAT IT IS NOT. It is an entry in the invoice's own
 * `writeOffs` subcollection naming the cents that were given up. It is NOT a
 * payment (it never enters `invoices/{id}/payments`, whose sum is what was
 * collected), NOT account credit (nothing moves into
 * `families/{id}.accountBalanceCents`), and NOT a refund (there are none, ever).
 * The invoice is stamped `status: 'written_off'` with a zero balance, so every
 * reader that asks "is anything owed" (reminders, overdue notices, the
 * Outstanding totals, the portal's amount due and Pay now, auto-apply) already
 * answers no, and every reader that asks "was this paid" can tell it was not.
 *
 * IT LIVES HERE, beside `isArchived`, rather than in a file of its own: the
 * payment writers, the checkout sweep and the PDF all need it, and a new module
 * would be one more for every function to load at cold start
 * (`test/coldStartImportGraph.test.ts`). Nothing below reaches Firestore.
 */
/** The stored `status` of a written-off invoice, and the classifier state it reads as. */
export const WRITTEN_OFF_STATUS = 'written_off';

/** The subcollection holding the write-off entry. Like `payments`, no client rule reaches it. */
export const WRITE_OFFS_SUBCOLLECTION = 'writeOffs';

/** `details.code` when a payment, a credit draw or an edit meets a written-off invoice. */
export const INVOICE_WRITTEN_OFF_CODE = 'invoice_written_off';

/** What a payment writer says when the invoice it was about to settle has been written off. */
export const WRITTEN_OFF_PAYMENT_REFUSAL =
  'The balance on this invoice was written off, so it cannot take a payment.';

export interface WriteOffDoc {
  status?: unknown;
  writtenOffAt?: unknown;
}

function label(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Written off iff the label says so, OR the write-off's own stamp is there.
 * Either alone is enough: a later writer that re-stamped the label would
 * otherwise turn a written-off invoice back into one that takes payments.
 */
export function isWrittenOff(doc: WriteOffDoc | undefined | null): boolean {
  if (!doc) return false;
  if (label(doc.status) === WRITTEN_OFF_STATUS) return true;
  return doc.writtenOffAt !== undefined && doc.writtenOffAt !== null;
}

/** Why a write-off was refused. Clients branch on `code`; `message` is shown as it is. */
export interface WriteOffRefusal {
  code:
    | 'invoice_archived'
    | 'write_off_draft'
    | 'write_off_quote'
    | 'write_off_cancelled'
    | 'write_off_credit'
    | 'write_off_already'
    | 'write_off_paid'
    | 'write_off_amount_changed';
  message: string;
}

/**
 * The refusals, decided on the invoice as the write-off's transaction read it.
 *
 * `state` is the classifier's reading (`invoiceStateOf(doc, paidCents)`) and
 * `owedCents` the balance from the shared rule (`amountDueCentsOf`), both
 * passed in so this stays free of the classifier's import chain. Order matters
 * only for which sentence is shown: an archived invoice is named as archived
 * whatever else is true of it, because Restore is the thing to do first.
 */
export function writeOffRefusalOf(input: {
  archived: boolean;
  writtenOff: boolean;
  state: string;
  owedCents: number;
  /** The amount the confirm showed, in cents. */
  expectedCents: number;
}): WriteOffRefusal | null {
  if (input.archived) {
    return { code: 'invoice_archived', message: 'This invoice is archived. Restore it before writing off its balance.' };
  }
  if (input.writtenOff || input.state === WRITTEN_OFF_STATUS) {
    return { code: 'write_off_already', message: 'The balance on this invoice was already written off.' };
  }
  switch (input.state) {
    case 'draft':
      return { code: 'write_off_draft', message: 'This invoice is a draft and was never sent, so nothing is owed on it.' };
    case 'quote':
      return { code: 'write_off_quote', message: 'This is a quote, so nothing is owed on it.' };
    case 'cancelled':
      return { code: 'write_off_cancelled', message: 'This invoice is cancelled, so nothing is owed on it.' };
    case 'credit':
    case 'redeemed':
      return { code: 'write_off_credit', message: 'This is a credit for the household, not a bill, so there is nothing to write off.' };
    default:
      break;
  }
  if (input.state !== 'open' || !(input.owedCents > 0)) {
    return { code: 'write_off_paid', message: 'Nothing is owed on this invoice, so there is nothing to write off.' };
  }
  if (input.owedCents !== input.expectedCents) {
    return {
      code: 'write_off_amount_changed',
      message: `The balance on this invoice is now ${formatUsdCents(input.owedCents)}, not ${formatUsdCents(
        Math.max(0, input.expectedCents),
      )}. Check it and try again.`,
    };
  }
  return null;
}

/** `details.code` of the archive refusal for an invoice that still has money owed. */
export const INVOICE_STILL_OWING_CODE = 'invoice_still_owing';

/** The archive refusal's sentence. Archiving is tidying, so it never touches money. */
export function stillOwingArchiveRefusal(owed: string): string {
  return `This invoice still has ${owed} owing, so it cannot be archived. Record the payment, or write off the balance first.`;
}
