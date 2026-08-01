import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../lib/fns';
import { addKin, updateKin } from './portal';

// Replace the single callables choke point so the test asserts the exact
// payload the wrapper builds, without touching the network.
vi.mock('../lib/fns', () => ({ call: vi.fn() }));

describe('addKin wrapper', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockResolvedValue({ kinId: 'new-1' } as never);
  });

  it('omits kinfolkId when not provided, and forwards the full kin payload', async () => {
    await addKin({ name: 'Rex', species: 'Dog' });
    expect(call).toHaveBeenCalledWith('addKin', { kin: { name: 'Rex', species: 'Dog' } });
  });

  it('includes kinfolkId only when provided', async () => {
    await addKin({ name: 'Rex' }, 'fam1');
    expect(call).toHaveBeenCalledWith('addKin', { kin: { name: 'Rex' }, kinfolkId: 'fam1' });
  });

  it('returns the callable result (the new kinId)', async () => {
    await expect(addKin({ name: 'Rex' })).resolves.toEqual({ kinId: 'new-1' });
  });

  it('does not swallow a rejection (fail loud)', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('permission-denied'));
    await expect(addKin({ name: 'Rex' }, 'fam1')).rejects.toThrow('permission-denied');
  });
});

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
