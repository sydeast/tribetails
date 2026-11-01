import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../lib/fns';
import { readKinDirect } from '../lib/kinDirectRead';
import { getMyKin } from './portal';

/**
 * #1282: `getMyKin` reads Firestore first and keeps the callable as the
 * fallback. The callable is the cold start this issue is about, so the test
 * that matters most is the first one: a household with a known id never
 * reaches it.
 */

vi.mock('../lib/fns', () => ({ call: vi.fn() }));
vi.mock('../lib/kinDirectRead', () => ({ readKinDirect: vi.fn() }));

const ROSTER = { kin: [{ id: 'k1', name: 'Biscuit' }] };

describe('getMyKin (#1282)', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(readKinDirect).mockReset();
  });

  it('answers from the direct read and never calls the cold callable', async () => {
    vi.mocked(readKinDirect).mockResolvedValue(ROSTER as never);
    await expect(getMyKin('fam1')).resolves.toEqual(ROSTER);
    expect(readKinDirect).toHaveBeenCalledWith('fam1');
    expect(call).not.toHaveBeenCalled();
  });

  it('falls back to the callable when the rule refuses (legacy primary with no member doc)', async () => {
    vi.mocked(readKinDirect).mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    vi.mocked(call).mockResolvedValue(ROSTER as never);
    await expect(getMyKin('fam1')).resolves.toEqual(ROSTER);
    expect(call).toHaveBeenCalledWith('getMyKin', { kinfolkId: 'fam1' });
  });

  it('surfaces the callable error when both paths fail, as before', async () => {
    vi.mocked(readKinDirect).mockRejectedValue(new Error('unavailable'));
    vi.mocked(call).mockRejectedValue(new Error('functions/internal'));
    await expect(getMyKin('fam1')).rejects.toThrow('functions/internal');
  });

  it('lets the callable resolve the default household when none is active yet', async () => {
    vi.mocked(call).mockResolvedValue(ROSTER as never);
    await expect(getMyKin()).resolves.toEqual(ROSTER);
    expect(readKinDirect).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith('getMyKin', {});
  });
});
