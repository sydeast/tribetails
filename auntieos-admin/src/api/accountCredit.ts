import { call } from '../lib/fns';
import type {
  GetAccountCreditHistoryArgs,
  GetAccountCreditHistoryResult,
  GiveAccountCreditArgs,
  GiveAccountCreditResult,
} from '../contracts/invoiceContracts.generated';

/**
 * Q6 (operator ruling 2026-09-27): giving a household account credit, and
 * reading the household's credit history. Server side:
 * `mytribe/functions/src/admin/giveAccountCredit.ts` and
 * `mytribe/functions/src/portal/getAccountCreditHistory.ts`.
 *
 * `giveAccountCredit` always carries its key (the server requires one and
 * uses it as the credit's id), so it is always safe to retry: a second attempt
 * with the same key answers the first credit and adds nothing.
 */
export async function giveAccountCredit(input: GiveAccountCreditArgs): Promise<GiveAccountCreditResult> {
  return call<GiveAccountCreditArgs, GiveAccountCreditResult>('giveAccountCredit', input, {
    idempotent: true,
  });
}

/** Read only, so a retry changes nothing. */
export async function getAccountCreditHistory(kinfolkId: string): Promise<GetAccountCreditHistoryResult> {
  return call<GetAccountCreditHistoryArgs, GetAccountCreditHistoryResult>(
    'getAccountCreditHistory',
    { kinfolkId },
    { idempotent: true },
  );
}
