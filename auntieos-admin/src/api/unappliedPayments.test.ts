import { describe, it, expect, vi } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listUnappliedPayments, resolveUnappliedPayment } from './unappliedPayments';

describe('unappliedPayments api (#1003)', () => {
  it('listUnappliedPayments names the household and is safe to retry', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true, kinfolkId: 'fam1', payments: [], openInvoices: [] });
    const res = await listUnappliedPayments('fam1');
    expect(call).toHaveBeenCalledWith('listUnappliedPayments', { kinfolkId: 'fam1' }, { idempotent: true });
    expect(res.payments).toEqual([]);
  });

  it('resolveUnappliedPayment sends the whole decision with its key, and opts in to the retry', async () => {
    call.mockReset();
    call.mockResolvedValue({ ok: true, paymentId: 'evt_1', keptCents: 0, replayed: false });
    const input = {
      paymentId: 'evt_1',
      creditCents: 1000,
      creditReason: 'Paid twice',
      applyInvoiceId: 'inv2',
      applyCents: 1500,
      idempotencyKey: 'upd_1790000000000_abc123',
    };
    await resolveUnappliedPayment(input);
    expect(call).toHaveBeenCalledWith('resolveUnappliedPayment', input, { idempotent: true });
  });
});
