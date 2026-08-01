import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));
vi.mock('../lib/fns', () => ({ call: callMock }));

import { submitVetClinic } from './vetClinicsWrite';

beforeEach(() => {
  callMock.mockReset();
});

describe('submitVetClinic', () => {
  it('sends the trimmed clinic to the deployed callable', async () => {
    callMock.mockResolvedValue({ clinicId: 'c1', created: true, pending: false });
    await submitVetClinic({
      name: '  Riverside Animal Hospital  ',
      phone: ' (512) 555-0100 ',
      address: ' 1 Mill St ',
      website: ' https://riverside.example ',
      isEmergency: true,
    });
    expect(callMock).toHaveBeenCalledWith('submitVetClinic', {
      name: 'Riverside Animal Hospital',
      phone: '(512) 555-0100',
      address: '1 Mill St',
      website: 'https://riverside.example',
      isEmergency: true,
      // Empty on a first attempt, so the SAFE path is the default: a caller
      // that sends nothing can only ever be handed candidates, never create
      // silently over an existing clinic.
      acknowledgedMatchIds: [],
    });
  });

  it('defaults the optional fields rather than sending undefined', async () => {
    callMock.mockResolvedValue({ clinicId: 'c1', created: true, pending: false });
    await submitVetClinic({ name: 'Corner Vet' });
    expect(callMock).toHaveBeenCalledWith('submitVetClinic', {
      name: 'Corner Vet',
      phone: '',
      address: '',
      website: '',
      isEmergency: false,
      acknowledgedMatchIds: [],
    });
  });

  it('returns the created clinic id', async () => {
    callMock.mockResolvedValue({ clinicId: 'c9', created: true, pending: false });
    await expect(submitVetClinic({ name: 'New Vet' })).resolves.toEqual({
      clinicId: 'c9',
      created: true,
      pending: false,
    });
  });

  /**
   * The dedupe path. The backend matches on normalized name and hands back the
   * EXISTING id with `created: false`, which is what lets the picker select the
   * clinic that is already there instead of writing a second copy of it.
   */
  it('surfaces the EXISTING id when the backend deduped', async () => {
    callMock.mockResolvedValue({ clinicId: 'already-there', created: false, pending: false });
    await expect(submitVetClinic({ name: 'riverside animal hospital' })).resolves.toEqual({
      clinicId: 'already-there',
      created: false,
      pending: false,
    });
  });

  it('rejects a blank name locally, without spending a callable round trip', async () => {
    await expect(submitVetClinic({ name: '   ' })).rejects.toThrow(/name/i);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('lets a callable failure propagate so the caller can fail loud', async () => {
    callMock.mockRejectedValue(new Error('permission-denied'));
    await expect(submitVetClinic({ name: 'New Vet' })).rejects.toThrow('permission-denied');
  });

  /**
   * Operator ruling 2026-08-01: creating over a near match requires echoing the
   * ids the caller was shown. Not a boolean, which a client that rendered
   * nothing could set.
   */
  it('forwards the acknowledged ids when the caller confirms', async () => {
    callMock.mockResolvedValue({ status: 'created', clinicId: 'c2', created: true, pending: false, candidates: [] });
    await submitVetClinic({ name: 'Corner Vet' }, ['riverside']);
    expect(callMock).toHaveBeenCalledWith(
      'submitVetClinic',
      expect.objectContaining({ acknowledgedMatchIds: ['riverside'] }),
    );
  });
});
