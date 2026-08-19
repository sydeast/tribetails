/**
 * The Invoice State Stamp (ADR-0002): the classifier's output, persisted.
 *
 * `invoiceEditPolicy.ts` is the authority on what state an invoice is in and
 * how much of it may change. Until now that authority ran on demand, five
 * times, in five places: this server, the React admin's mirror, the Android
 * classifier, and the portal's 5-state `resolveStatus`, at three different
 * state cardinalities. This module is the write-side half of retiring that:
 * every money-touching callable computes the classifier's reading of the doc
 * it is ABOUT to write and persists it as two fields, IN THE SAME WRITE,
 *
 *   status     one of the eight `INVOICE_STATES`, always lowercase
 *   editScope  'all' | 'metadataOnly' | 'none'
 *
 * so a client can eventually render the stored state instead of re-deriving
 * it. Deleting the client classifiers is a later PR; nothing here changes what
 * any client computes today, because every value this stamp writes classifies
 * identically through all of them (they lowercase and fall back to the money,
 * which the stamp never contradicts).
 *
 * WHY "IN THE SAME WRITE" IS THE WHOLE CONTRACT. A stamp written as a second
 * write would open a window in which the money has moved but the stored state
 * describes the old money; a crash inside that window persists the lie. Every
 * adopter therefore spreads the stamp into the very update/set/transaction
 * that changes the doc, and there is deliberately no "stampInvoice(ref)"
 * convenience here that would make the two-write shape easy to reach for.
 *
 * THE STAMP IS A FIXPOINT, and tests hold it to that: re-classifying a doc
 * that carries its own stamp yields the same stamp. This is what makes the
 * backfill idempotent and its "skip if current" check meaningful. The one
 * state that needed the classifier's help to close the loop is `redeemed`;
 * see the note inside `invoiceStateOf`.
 *
 * `status` WAS ALREADY A STORED FIELD, free-text, "whatever the caller sent".
 * The stamp canonicalizes it (`'QUOTE'` becomes `'quote'`, an unlabeled sent
 * invoice becomes `'open'`). That is the ADR's intent, not a side effect: the
 * stored value the clients will rely on has to be the classifier's vocabulary,
 * not the union of every spelling five composers ever used.
 */
import {
  invoiceStateOf,
  invoiceEditScope,
  paymentStandingOf,
  quoteAcceptanceOf,
  type InvoiceState,
  type InvoiceEditScope,
  type InvoiceStateDoc,
} from './invoiceEditPolicy';
import { invoiceTotalCentsOf } from './invoiceMath';

/**
 * What the stamp reads: the classifier's four fields plus the two the total is
 * resolved from. All unknown, because the input is a raw Firestore doc merged
 * with a pending update, and real docs are missing keys.
 */
export interface InvoiceStampDoc extends InvoiceStateDoc {
  totalCents?: unknown;
}

export interface InvoiceStateStamp {
  status: InvoiceState;
  editScope: InvoiceEditScope;
}

/**
 * The stamp for one invoice doc as it will exist AFTER the pending write.
 *
 * `doc` is the post-write data: the caller spreads its update over the stored
 * doc (`{ ...stored, ...update }`) and hands the result here, so the stamp
 * describes what the write commits, never what the doc used to say.
 *
 * `paidCents` is the sum of the `payments` SUBCOLLECTION
 * (`invoiceMath.ts#paidCentsFromPayments`), taken as a number rather than read
 * off the doc for the same reason `paymentStandingOf` does: the `amountDue`
 * scalar was zeroed by the pre-2026-07-25 partial-payment write and cannot
 * answer how much has come in. Callers that mint a NEW doc pass 0, which is
 * true by construction: a payment cannot precede the invoice it pays.
 */
export function invoiceStateStampOf(doc: InvoiceStampDoc, paidCents: number): InvoiceStateStamp {
  const status = invoiceStateOf(doc);
  const standing = paymentStandingOf(invoiceTotalCentsOf(doc), paidCents);
  // THE QUOTE ANSWER IS READ OFF THE DOC, not passed in, and that is what makes
  // the acceptance lock (issue #448) hold everywhere. Every adopter hands this
  // function the WHOLE post-write doc, so an invoice that began as an accepted
  // quote re-stamps to `editScope: 'none'` through markInvoicePaid, the Stripe
  // webhook, the session linker and the backfill alike, with no adopter needing
  // to know the rule exists. An adopter that passed only the fields it changed
  // would silently unlock the doc on its next write; none does.
  return {
    status,
    editScope: invoiceEditScope(status, standing, quoteAcceptanceOf(doc)),
  };
}

/**
 * True when the doc already carries exactly [stamp]. The backfill's skip
 * check: a doc whose stored fields match is not rewritten, which is what lets
 * the pass run twice and touch nothing the second time.
 */
export function invoiceStampIsCurrent(
  doc: { status?: unknown; editScope?: unknown },
  stamp: InvoiceStateStamp,
): boolean {
  return doc.status === stamp.status && doc.editScope === stamp.editScope;
}
