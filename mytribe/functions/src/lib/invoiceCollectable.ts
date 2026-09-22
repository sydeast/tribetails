/**
 * IS THIS INVOICE ONE A PAYMENT COULD BE PUT AGAINST? The auto-apply trigger's
 * coarse gate, kept here rather than in the trigger.
 *
 * WHY IT LIVES IN lib/ (#902). It used to sit in
 * `triggers/onInvoiceAutoApply.ts`, beside the handler that uses it. That file
 * reaches Firestore and the account-credit pass, so anything that wanted to ask
 * this question had to pull in the whole money path — which is how
 * `backfillInvoiceAmountDue.ts` broke the operator scripts' own tsconfig (no DOM
 * lib, and the chain ends at `wrapCallable`'s `Request.headers`). Copying the
 * predicate into the backfill instead would have been the very thing #902
 * exists to stop: a second reader with its own opinion about what a document
 * owes. So the predicate moved, the trigger re-exports it, and its two callers
 * — the trigger and the backfill's credit guard — ask one function.
 *
 * DELIBERATELY COARSE, and deliberately not `invoiceAcceptsCredit`. It decides
 * only whether a transition is interesting enough to look at; the real refusals
 * are `markInvoicePaid`'s and run inside the pass, against the stored document
 * and its payment rows. Duplicating them here would give the trigger a second
 * opinion about what is payable.
 */
import { amountDueCentsOf } from './amountDueRule';

/**
 * The raw fields this module reads. All optional and all unknown: real documents
 * are missing keys. The index signature is the same allowance `ChaseDoc` makes,
 * so a caller can hand over a whole stored invoice without narrowing it first.
 */
export interface CollectableDoc {
  status?: unknown;
  amountDue?: unknown;
  amountDueCents?: unknown;
  total?: unknown;
  totalCents?: unknown;
  [k: string]: unknown;
}

/**
 * True when a payment could go against this invoice.
 *
 * #902: THE BALANCE IS THE SHARED RULE'S, and that is what this issue was about.
 * This predicate used to read "no `amountDue` field" as "go and look", while
 * `invoiceStateOf` read the same missing field as a zero balance and called the
 * document paid. So a migrated `{ status: 'sent', total: 40 }` had account
 * credit drawn against it while the portal showed it settled. Both readers now
 * ask `lib/amountDueRule.ts`, and there is nothing left for them to disagree
 * about.
 *
 * WHAT MOVED AND WHAT DID NOT. The legacy total-only shape is still collectable,
 * because its total IS what it owes. A document with neither a balance nor a
 * total is not, where before it was: an invoice that states no money at all is
 * not a bill to spend a household's credit against, and the pass would refuse it
 * on arrival anyway. The status refusals are untouched.
 *
 * `null` for the payment rows: every caller holds a document, not its
 * subcollection. The pass re-reads the rows and settles for real.
 */
export function collectableForAutoApply(doc: CollectableDoc | undefined): boolean {
  if (!doc) return false;
  const status = typeof doc.status === 'string' ? doc.status.trim().toLowerCase() : '';
  if (status === 'draft' || status === 'quote' || status === 'cancelled' || status === 'credit') {
    return false;
  }
  if (status === 'paid' || status === 'redeemed') return false;
  return amountDueCentsOf(doc, null) > 0;
}
