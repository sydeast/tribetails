import { call } from '../lib/fns';
import type {
  ListUnappliedPaymentsArgs,
  ListUnappliedPaymentsResult,
  ResolveUnappliedPaymentArgs,
  ResolveUnappliedPaymentResult,
} from '../contracts/invoiceContracts.generated';

/**
 * #1003: card payments Stripe took that the webhook could not apply to their
 * invoice (the invoice was already paid, void, or the amount was not readable),
 * and the owner's decision about each one. Server side:
 * `mytribe/functions/src/admin/listUnappliedPayments.ts` and
 * `mytribe/functions/src/admin/resolveUnappliedPayment.ts`. Owner only.
 */

/** Read only, so a retry changes nothing. */
export async function listUnappliedPayments(kinfolkId: string): Promise<ListUnappliedPaymentsResult> {
  return call<ListUnappliedPaymentsArgs, ListUnappliedPaymentsResult>(
    'listUnappliedPayments',
    { kinfolkId },
    { idempotent: true },
  );
}

/**
 * Always carries its key (the server requires one), so a second attempt with
 * the same key answers the first decision and moves no money twice.
 */
export async function resolveUnappliedPayment(
  input: ResolveUnappliedPaymentArgs,
): Promise<ResolveUnappliedPaymentResult> {
  return call<ResolveUnappliedPaymentArgs, ResolveUnappliedPaymentResult>('resolveUnappliedPayment', input, {
    idempotent: true,
  });
}
