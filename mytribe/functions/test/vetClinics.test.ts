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

/** A caller carrying the `admin` custom claim, the primary staff signal (RULING O-6). */
function staffReq(data: unknown, uid = 'auntie1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any } as any,
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

  /**
   * OPERATOR RULING 2026-08-01. A near match now OFFERS a choice and writes
   * nothing. It used to return the matching clinic's id with `created: false`:
   * the caller asked to create and silently got somebody else's record. Two
   * practices genuinely can share a name in different cities, so that
   * substituted a different phone number onto the record read in an emergency.
   */
  it('offers the match as a CHOICE instead of substituting it, and writes nothing', async () => {
    const ctx = withClinics([{ id: 'exists', data: { name: 'Riverside  Animal Hospital', verified: true } }]);
    const res = await submitVetClinicHandler(req({ name: 'riverside animal hospital' }));
    expect(res.status).toBe('needs_choice');
    expect(res.clinicId).toBe('');
    expect(res.created).toBe(false);
    expect(res.candidates.map((c) => c.id)).toEqual(['exists']);
    expect(ctx.adds).toHaveLength(0);
  });

  it('flags a pending match as unverified so the chooser sees it is unapproved', async () => {
    withClinics([{ id: 'p', data: { name: 'Dup', verified: false } }]);
    const res = await submitVetClinicHandler(req({ name: 'dup' }));
    expect(res.status).toBe('needs_choice');
    expect(res.candidates[0]).toMatchObject({ id: 'p', verified: false });
  });

  it('creates once the caller echoes back the ids it was offered', async () => {
    // The echo is the evidence the user was shown the match. See
    // lib/vetClinicMatch.ts#acknowledgesAll for why this is not a boolean.
    const ctx = withClinics([{ id: 'exists', data: { name: 'Riverside', verified: true } }]);
    const res = await submitVetClinicHandler(
      req({ name: 'Riverside', acknowledgedMatchIds: ['exists'] }),
    );
    expect(res.status).toBe('created');
    expect(res.created).toBe(true);
    expect(ctx.adds).toHaveLength(1);
  });

  it('asks again when a NEW match appeared since the choice was shown', async () => {
    // Acknowledging the one it saw must not license creating over one it did not.
    const ctx = withClinics([
      { id: 'exists', data: { name: 'Riverside', verified: true } },
      { id: 'fresh', data: { name: 'Riverside', verified: true } },
    ]);
    const res = await submitVetClinicHandler(
      req({ name: 'Riverside', acknowledgedMatchIds: ['exists'] }),
    );
    expect(res.status).toBe('needs_choice');
    expect(ctx.adds).toHaveLength(0);
  });

  // ── AO Task 1.8: the AuntieOS vet-clinic picker submits through this same
  // callable. A clinic an operator types into the household form is curated
  // data, not a household's guess, so it must not land in the pending queue the
  // operator would then have to approve for themselves.
  it('lands VERIFIED (not pending) when the caller is staff', async () => {
    const ctx = withClinics([]);
    const res = await submitVetClinicHandler(staffReq({ name: 'Riverside Animal Hospital' }));
    expect(res).toMatchObject({ created: true, pending: false });
    expect(ctx.adds[0].data).toMatchObject({ verified: true, submittedBy: 'auntie1' });
  });

  it('keeps a kinfolk submission pending (the staff branch does not leak)', async () => {
    const ctx = withClinics([]);
    const res = await submitVetClinicHandler(req({ name: 'Corner Vet' }));
    expect(res).toMatchObject({ created: true, pending: true });
    expect(ctx.adds[0].data).toMatchObject({ verified: false, submittedBy: 'kin1' });
  });

  it('persists isEmergency when given', async () => {
    const ctx = withClinics([]);
    await submitVetClinicHandler(staffReq({ name: '24hr Pet ER', isEmergency: true }));
    expect(ctx.adds[0].data).toMatchObject({ isEmergency: true });
  });

  it('accepts a LEGACY payload with no isEmergency and stores false', async () => {
    const ctx = withClinics([]);
    const res = await submitVetClinicHandler(req({ name: 'Old Shape', phone: '(512) 5', address: '5 St', website: 'https://o.com' }));
    expect(res).toMatchObject({ created: true });
    expect(ctx.adds[0].data).toMatchObject({ isEmergency: false });
  });

  it('rejects a non-boolean isEmergency rather than coercing it', async () => {
    withClinics([]);
    await expect(submitVetClinicHandler(staffReq({ name: 'X', isEmergency: 'yes' }))).rejects.toThrow();
  });
});
