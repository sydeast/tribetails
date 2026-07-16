import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { getVetClinicsHandler } from '../src/portal/getVetClinics';
import { submitVetClinicHandler } from '../src/portal/submitVetClinic';

beforeEach(() => {
  mocks.dbFn.mockReset();
});

function req(data: unknown, uid: string | null = 'kin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: {} as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** vet_clinics collection seeded with the given rows. */
function withClinics(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  const ctx = buildDbMock({ queryDocs: { vet_clinics: rows } });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

describe('getVetClinics', () => {
  it('rejects an unauthenticated caller', async () => {
    withClinics([]);
    await expect(getVetClinicsHandler(req({}, null))).rejects.toThrow(/Sign-in/);
  });

  it('returns approved clinics with the new fields', async () => {
    withClinics([
      { id: 'c1', data: { name: 'Riverside', phone: '(512) 1', address: '1 Mill', website: 'https://r.com', googleMapsUrl: 'https://maps/r', isEmergency: true, verified: true } },
    ]);
    const res = await getVetClinicsHandler(req({}));
    expect(res.clinics).toHaveLength(1);
    expect(res.clinics[0]).toMatchObject({
      id: 'c1', name: 'Riverside', phone: '(512) 1', address: '1 Mill',
      website: 'https://r.com', googleMapsUrl: 'https://maps/r', isEmergency: true,
    });
  });

  it('treats a MISSING verified flag as approved (legacy fail-open)', async () => {
    withClinics([{ id: 'legacy', data: { name: 'Old Clinic' } }]);
    const res = await getVetClinicsHandler(req({}));
    expect(res.clinics.map((c) => c.id)).toEqual(['legacy']);
    expect(res.clinics[0].isEmergency).toBe(false);
  });

  it('HIDES an explicit pending submission (verified === false)', async () => {
    withClinics([
      { id: 'ok', data: { name: 'Approved', verified: true } },
      { id: 'pend', data: { name: 'Pending', verified: false } },
    ]);
    const res = await getVetClinicsHandler(req({}));
    expect(res.clinics.map((c) => c.id)).toEqual(['ok']);
  });

  it('drops nameless rows', async () => {
    withClinics([{ id: 'blank', data: { name: '', verified: true } }]);
    const res = await getVetClinicsHandler(req({}));
    expect(res.clinics).toHaveLength(0);
  });
});

describe('submitVetClinic', () => {
  it('rejects an unauthenticated caller', async () => {
    withClinics([]);
    await expect(submitVetClinicHandler(req({ name: 'X' }, null))).rejects.toThrow(/Sign-in/);
  });

  it('rejects a blank name (invalid-argument)', async () => {
    withClinics([]);
    await expect(submitVetClinicHandler(req({ name: '   ' }))).rejects.toThrow(/name is required/);
  });

  it('creates a PENDING entry tagged with submittedBy', async () => {
    const ctx = withClinics([]);
    const res = await submitVetClinicHandler(req({ name: 'New Vet', phone: '(512) 9', address: '9 St' }));
    expect(res).toMatchObject({ created: true, pending: true });
    expect(ctx.adds).toHaveLength(1);
    const added = ctx.adds[0];
    expect(added.collection).toBe('vet_clinics');
    expect(added.data).toMatchObject({
      name: 'New Vet', phone: '(512) 9', address: '9 St',
      verified: false, submittedBy: 'kin1', isEmergency: false,
      createdAt: '__TS__', updatedAt: '__TS__',
    });
  });

  it('dedupes against an existing clinic (case/space-insensitive) without creating', async () => {
    const ctx = withClinics([{ id: 'exists', data: { name: 'Riverside  Animal Hospital', verified: true } }]);
    const res = await submitVetClinicHandler(req({ name: 'riverside animal hospital' }));
    expect(res).toMatchObject({ clinicId: 'exists', created: false, pending: false });
    expect(ctx.adds).toHaveLength(0);
  });

  it('dedup reports pending=true when the existing match is itself pending', async () => {
    withClinics([{ id: 'p', data: { name: 'Dup', verified: false } }]);
    const res = await submitVetClinicHandler(req({ name: 'dup' }));
    expect(res).toMatchObject({ clinicId: 'p', created: false, pending: true });
  });
});
