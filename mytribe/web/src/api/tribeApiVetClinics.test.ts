import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../lib/fns';
import { readVetClinicsDirect } from '../lib/vetClinicsDirectRead';
import { getVetClinics } from './tribeApi';
/**
 * #1503: `getVetClinics` reads Firestore first and keeps the callable as the
 * fallback. The first test is the point of the issue: no cold callable.
 */
vi.mock('../lib/fns', () => ({ call: vi.fn() }));
vi.mock('../lib/vetClinicsDirectRead', () => ({ readVetClinicsDirect: vi.fn() }));
const CLINICS = { clinics: [{ id: 'c1', name: 'Paws Clinic' }] };
describe('getVetClinics (#1503)', () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(readVetClinicsDirect).mockReset();
  });
  it('answers from the direct read and never calls the cold callable', async () => {
    vi.mocked(readVetClinicsDirect).mockResolvedValue(CLINICS as never);
    await expect(getVetClinics()).resolves.toEqual(CLINICS);
    expect(call).not.toHaveBeenCalled();
  });
  it('falls back to the callable when the direct read fails', async () => {
    vi.mocked(readVetClinicsDirect).mockRejectedValue(new Error('unavailable'));
    vi.mocked(call).mockResolvedValue(CLINICS as never);
    await expect(getVetClinics({ background: true })).resolves.toEqual(CLINICS);
    expect(call).toHaveBeenCalledWith('getVetClinics', {}, { background: true });
  });
  it('surfaces the callable error when both paths fail, as before', async () => {
    vi.mocked(readVetClinicsDirect).mockRejectedValue(new Error('unavailable'));
    vi.mocked(call).mockRejectedValue(new Error('functions/internal'));
    await expect(getVetClinics()).rejects.toThrow('functions/internal');
  });
});
