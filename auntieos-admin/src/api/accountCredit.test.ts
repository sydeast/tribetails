import { describe, it, expect, vi } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { getAccountCreditHistory, giveAccountCredit } from './accountCredit';

describe('accountCredit api (Q6)', () => {
  it('giveAccountCredit sends the whole request with its key, and opts in to the retry', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true, creditId: 'crd_1', amountCents: 2500, newAccountBalanceCents: 3700, replayed: false });
    const input = { kinfolkId: 'fam1', amountCents: 2500, reason: 'Missed visit', idempotencyKey: 'crd_1790000000000_abc123' };
    const res = await giveAccountCredit(input);
    expect(call).toHaveBeenCalledWith('giveAccountCredit', input, { idempotent: true });
    expect(res.newAccountBalanceCents).toBe(3700);
  });

  it('getAccountCreditHistory names the household', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true, kinfolkId: 'fam1', accountBalanceCents: 0, credits: [], uses: [] });
    await getAccountCreditHistory('fam1');
    expect(call).toHaveBeenCalledWith('getAccountCreditHistory', { kinfolkId: 'fam1' }, { idempotent: true });
  });
});
