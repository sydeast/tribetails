import { onDocumentWritten, FirestoreEvent, Change, DocumentSnapshot } from 'firebase-functions/v2/firestore';

import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { drawAccountCredit } from '../lib/accountCredit';

/**
 * The half of "Will automatically apply any Unapplied amount to FUTURE
 * invoices" that runs by itself.
 *
 * The operator's own label is the specification, and FUTURE is the load-bearing
 * word: an unapplied remainder is not split across today's bills, it is held as
 * account credit and consumed later against invoices that do not exist yet. So
 * the moment an invoice BECOMES COLLECTABLE (created open, or a draft reviewed
 * and sent), the household's credit goes onto it, and the bill they receive is
 * the one they actually owe.
 *
 * ── A SECOND TRIGGER ON THE SAME COLLECTION, ON PURPOSE ───────────────────
 *
 * `onInvoicesWrite` is the notification trigger: it decides who to tell about a
 * state change and writes nothing. This one moves money. Folding them together
 * would put a Firestore write inside a function whose failure mode today is "a
 * notification did not go out", and make every future change to either one a
 * change to both. They watch the same documents and answer different questions.
 *
 * The ORDER between them needs no arranging. This trigger's write flips the
 * invoice to paid where the credit covers it, which `onInvoicesWrite` then sees
 * as its own transition and notifies on. The household is told the invoice is
 * paid because it is paid.
 *
 * ── THE TRANSITION CHECK IS THE LOOP GUARD ────────────────────────────────
 *
 * This function writes to the collection it watches, so it must not react to
 * its own write. It fires only when the invoice was NOT collectable before and
 * IS collectable after. Its own write leaves an invoice that was already
 * collectable, so the next invocation returns here. That is the whole guard,
 * and it is the same transition idiom `onInvoicesWrite` uses.
 *
 * ── AND IT IS STILL ALLOWED TO DO NOTHING ─────────────────────────────────
 *
 * `drawAccountCredit` re-checks everything from the stored documents: whether
 * the invoice can take a payment at all, whether anything is owed, whether any
 * credit is held. A trigger firing is not permission to move money; it is a
 * prompt to go and look.
 */

type InvoiceDoc = {
  kinfolkId?: string;
  status?: string;
  amountDue?: number;
};

/**
 * Is this invoice one a payment could be put against?
 *
 * DELIBERATELY COARSE, and deliberately not `invoiceAcceptsCredit`. This
 * decides only whether the transition is interesting enough to look at; the
 * real refusals are `markInvoicePaid`'s and run inside the pass, against the
 * stored doc and its payments. Duplicating them here would give the trigger a
 * second opinion about what is payable.
 */
export function collectableForAutoApply(doc: InvoiceDoc | undefined): boolean {
  if (!doc) return false;
  const status = typeof doc.status === 'string' ? doc.status.trim().toLowerCase() : '';
  if (status === 'draft' || status === 'quote' || status === 'cancelled' || status === 'credit') {
    return false;
  }
  if (status === 'paid' || status === 'redeemed') return false;
  const amountDue = typeof doc.amountDue === 'number' ? doc.amountDue : null;
  // No stated balance is not "nothing owed": an un-itemized invoice can carry a
  // `total` and no `amountDue` yet. The pass resolves the real figure.
  return amountDue === null || amountDue > 0;
}

type InvoicesWriteEvent = FirestoreEvent<
  Change<DocumentSnapshot> | undefined,
  { invoiceId: string }
>;

/**
 * The actor recorded on a credit-funded payment row.
 *
 * NOT a person. The row was written by the system acting on a decision the
 * operator recorded earlier, and attributing it to whichever admin last touched
 * the invoice would put a name on a write they did not make.
 */
export const AUTO_APPLY_ACTOR_UID = 'system:auto-apply';

export async function onInvoiceAutoApplyHandler(event: InvoicesWriteEvent): Promise<void> {
  const before = event.data?.before.data() as InvoiceDoc | undefined;
  const after = event.data?.after.data() as InvoiceDoc | undefined;
  if (!after) return;

  if (collectableForAutoApply(before)) return;
  if (!collectableForAutoApply(after)) return;

  const invoiceId = event.params.invoiceId;
  try {
    const result = await drawAccountCredit(db(), {
      invoiceId,
      actorUid: AUTO_APPLY_ACTOR_UID,
    });
    if (result.skipped !== null) {
      logEvent({
        severity: 'info',
        function: 'onInvoiceAutoApply',
        event: 'payment.autoapply.skipped',
        extra: { invoiceId, reason: result.skipped },
      });
    }
  } catch (err) {
    // FAIL LOUD, DO NOT THROW. A rethrow makes Firestore retry the trigger, and
    // retrying a money write whose first attempt may have committed is worse
    // than the credit sitting unspent until the operator runs the callable.
    logEvent({
      severity: 'error',
      function: 'onInvoiceAutoApply',
      event: 'payment.autoapply.failed',
      extra: { invoiceId, err: (err as Error)?.message },
    });
  }
}

export const onInvoiceAutoApply = onDocumentWritten(
  {
    document: 'invoices/{invoiceId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onInvoiceAutoApply', onInvoiceAutoApplyHandler),
);
