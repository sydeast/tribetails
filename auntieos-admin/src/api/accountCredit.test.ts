import { describe, it, expect, vi } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { applyAccountCredit, getAccountCreditHistory, giveAccountCredit } from './accountCredit';

describe('accountCredit api (Q6)', () => {
  it('giveAccountCredit sends the whole request with its key, and opts in to the retry', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true, creditId: 'crd_1', amountCents: 2500, newAccountBalanceCents: 3700, replayed: false });
    const input = { kinfolkId: 'fam1', amountCents: 2500, reason: 'Missed visit', idempotencyKey: 'crd_1790000000000_abc123' };
    const res = await giveAccountCredit(input);
    expect(call).toHaveBeenCalledWith('giveAccountCredit', input, { idempotent: true });
    expect(res.newAccountBalanceCents).toBe(3700);
  });

  it('applyAccountCredit (#1872) sends the invoice, the entered amount and its key, and opts in to the retry', async () => {
    call.mockReset();
    call.mockResolvedValue({
      ok: true,
      invoiceId: 'inv1',
      paymentId: 'acr_1790000000000_abc123',
      appliedCents: 2500,
      amountDueCents: 7500,
      accountBalanceCents: 9500,
      replayed: false,
    });
    const input = { invoiceId: 'inv1', amountCents: 2500, idempotencyKey: 'acr_1790000000000_abc123' };
    const res = await applyAccountCredit(input);
    expect(call).toHaveBeenCalledWith('applyAccountCredit', input, { idempotent: true });
    expect(res.accountBalanceCents).toBe(9500);
  });
  it('getAccountCreditHistory names the household', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true, kinfolkId: 'fam1', accountBalanceCents: 0, credits: [], uses: [] });
    await getAccountCreditHistory('fam1');
    expect(call).toHaveBeenCalledWith('getAccountCreditHistory', { kinfolkId: 'fam1' }, { idempotent: true });
  });
});
