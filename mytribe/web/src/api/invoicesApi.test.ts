import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../lib/fns';
import { getMyInvoices, withoutUnsentDrafts } from './invoicesApi';

vi.mock('../lib/fns', () => ({ call: vi.fn() }));

const row = (id: string, status: string) => ({ id, status }) as never;

describe('#1906 getMyInvoices never hands a screen an unsent draft', () => {
  beforeEach(() => vi.mocked(call).mockReset());

  it('drops a draft from every bucket and keeps everything sent', async () => {
    vi.mocked(call).mockResolvedValue({
      open: [row('o1', 'open'), row('d1', 'draft'), row('q1', 'quote'), row('z1', 'zero')],
      paid: [row('p1', 'paid'), row('d2', 'draft')],
      credits: [row('c1', 'credit'), row('r1', 'redeemed')],
      accountBalanceCents: 700,
    } as never);
    const res = await getMyInvoices('fam1');
    expect(call).toHaveBeenCalledWith('getMyInvoices', { kinfolkId: 'fam1' }, undefined);
    expect(res.open.map((i) => i.id)).toEqual(['o1', 'q1', 'z1']);
    expect(res.paid.map((i) => i.id)).toEqual(['p1']);
    expect(res.credits.map((i) => i.id)).toEqual(['c1', 'r1']);
    expect(res.accountBalanceCents).toBe(700);
  });

  it('leaves an answer with no draft exactly as it came', () => {
    const answer = { open: [row('o1', 'open')], paid: [], credits: [], accountBalanceCents: 0 } as never;
    expect(withoutUnsentDrafts(answer)).toEqual(answer);
  });

  it('does not swallow a refusal', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('permission-denied'));
    await expect(getMyInvoices('fam1')).rejects.toThrow('permission-denied');
  });
});
