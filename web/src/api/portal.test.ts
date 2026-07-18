import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../lib/fns';
import { updateKin } from './portal';

// Replace the single callables choke point so the test asserts the exact
// payload the wrapper builds, without touching the network.
vi.mock('../lib/fns', () => ({ call: vi.fn() }));

describe('updateKin wrapper', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockResolvedValue({ ok: true } as never);
  });

  it('omits kinfolkId when it is not provided (matches the archiveKin optional shape)', async () => {
    await updateKin('k1', { name: 'Rex' });
    expect(call).toHaveBeenCalledWith('updateKin', { kinId: 'k1', kin: { name: 'Rex' } });
  });

  it('includes kinfolkId only when provided, and forwards the partial verbatim', async () => {
    await updateKin('k1', { name: 'Rex', species: null }, 'fam1');
    expect(call).toHaveBeenCalledWith('updateKin', { kinId: 'k1', kin: { name: 'Rex', species: null }, kinfolkId: 'fam1' });
  });

  it('returns the callable result', async () => {
    await expect(updateKin('k1', {})).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith('updateKin', { kinId: 'k1', kin: {} });
  });
});
