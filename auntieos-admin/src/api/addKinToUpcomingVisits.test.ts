import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { addKinToUpcomingVisits } from './addKinToUpcomingVisits';

beforeEach(() => {
  call.mockReset();
});

describe('addKinToUpcomingVisits', () => {
  it('sends the household, the Kin and whether to apply', async () => {
    call.mockResolvedValue({ ok: true, kinId: 'k1', kinName: 'Pepper', upcoming: 2, added: 0 });
    expect(await addKinToUpcomingVisits('kf1', 'k1', false)).toEqual({
      kinId: 'k1',
      kinName: 'Pepper',
      upcoming: 2,
      added: 0,
    });
    expect(call).toHaveBeenCalledWith('addKinToUpcomingVisits', { kinfolkId: 'kf1', kinId: 'k1', apply: false });
  });

  it('reads a nameless Kin as null and a bad count as 0', async () => {
    call.mockResolvedValue({ ok: true, kinId: 'k1', kinName: '  ', upcoming: -1, added: 'x' });
    expect(await addKinToUpcomingVisits('kf1', 'k1', true)).toEqual({ kinId: 'k1', kinName: null, upcoming: 0, added: 0 });
  });

  it('throws on an answer that is not a success', async () => {
    call.mockResolvedValue({});
    await expect(addKinToUpcomingVisits('kf1', 'k1', true)).rejects.toThrow();
  });

  it('passes a refusal through', async () => {
    call.mockRejectedValue(new Error('Only the owner can add a Kin to visits already booked.'));
    await expect(addKinToUpcomingVisits('kf1', 'k1', true)).rejects.toThrow('Only the owner');
  });
});
