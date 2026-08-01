import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), auditFn: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.auditFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { archiveVetClinicHandler } from '../src/admin/archiveVetClinic';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.auditFn.mockClear();
  mocks.auditFn.mockResolvedValue('audit-1');
});

function req(data: unknown, uid: string | null = 'auntie1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const ACTIVE = { name: 'Riverside Animal Hospital', phone: '(512) 555-0100', verified: true };

function seed(
  clinic: Record<string, unknown> | null,
  /** `household_data` rows: the household link lives there, not on kinfolk. */
  households: Array<{ id: string; data: Record<string, unknown> }> = [],
) {
  const ctx = buildDbMock({
    docs: { 'vet_clinics/c1': clinic },
    queryDocs: { household_data: households },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

function clinicWrite(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.find((w) => w.path === 'vet_clinics/c1');
}

function auditOf(event: string) {
  return mocks.auditFn.mock.calls.map((c) => c[0]).find((a: any) => a.event === event);
}

describe('archiveVetClinic', () => {
  it('rejects an unauthenticated caller', async () => {
    seed(ACTIVE);
    await expect(
      archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }, null)),
    ).rejects.toThrow(/Sign-in/);
  });

  it('rejects a missing archived flag rather than assuming one', async () => {
    seed(ACTIVE);
    await expect(archiveVetClinicHandler(req({ clinicId: 'c1' }))).rejects.toThrow(
      /validation failed/,
    );
  });

  it('refuses a clinic that does not exist', async () => {
    seed(null);
    await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true })).catch((err: any) => {
      expect(err.code).toBe('not-found');
      expect(err.details.code).toBe('vet_clinic_not_found');
    });
    expect.assertions(2);
  });

  it('archives an active clinic and stamps who did it', async () => {
    const ctx = seed(ACTIVE);
    const res = await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }));
    expect(res).toEqual({ ok: true, clinicId: 'c1', archived: true, householdCount: 0 });
    expect(clinicWrite(ctx)!.data).toMatchObject({
      archived: true,
      archivedAt: '__TS__',
      archivedBy: 'auntie1',
    });
  });

  it('NEVER deletes the document', async () => {
    // The whole delete-versus-archive decision, asserted: a household's
    // vetClinicId must keep resolving after the operator tidies the catalog.
    const ctx = seed(ACTIVE, [{ id: 'h1', data: { primaryVetClinicId: 'c1' } }]);
    await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }));
    expect(ctx.deletes).toEqual([]);
  });

  it('leaves the linked household record untouched', async () => {
    // Archiving must not blank the number at the doorstep.
    const ctx = seed(ACTIVE, [{ id: 'h1', data: { primaryVetClinicId: 'c1' } }]);
    await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }));
    expect(ctx.writes.find((w) => w.path === 'household_data/h1')).toBeUndefined();
  });

  it('reports how many households still use the clinic', async () => {
    seed(ACTIVE, [
      { id: 'h1', data: { primaryVetClinicId: 'c1' } },
      { id: 'h2', data: { emergencyVetClinicId: 'c1' } },
      { id: 'h3', data: { primaryVetClinicId: 'elsewhere' } },
    ]);
    const res = await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }));
    expect(res.householdCount).toBe(2);
  });

  it('raises severity to warn when the archived clinic is still in use', async () => {
    seed(ACTIVE, [{ id: 'h1', data: { primaryVetClinicId: 'c1' } }]);
    await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }));
    const audit = auditOf(AUDIT_EVENTS.VET_CLINIC_ARCHIVED);
    expect(audit).toMatchObject({ status: 'SUCCESS', severity: 'warn' });
    expect(audit.payload).toMatchObject({ archived: true, householdCount: 1 });
  });

  it('stays at info when nothing references the clinic', async () => {
    seed(ACTIVE);
    await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }));
    expect(auditOf(AUDIT_EVENTS.VET_CLINIC_ARCHIVED).severity).toBe('info');
  });

  it('records that a rejected pending submission was pending', async () => {
    seed({ ...ACTIVE, verified: false });
    await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }));
    expect(auditOf(AUDIT_EVENTS.VET_CLINIC_ARCHIVED).payload.wasPending).toBe(true);
  });

  describe('unarchive', () => {
    it('restores a clinic and clears the archive stamps', async () => {
      const ctx = seed({ ...ACTIVE, archived: true, archivedBy: 'auntie1' });
      const res = await archiveVetClinicHandler(req({ clinicId: 'c1', archived: false }));
      expect(res.archived).toBe(false);
      expect(clinicWrite(ctx)!.data).toMatchObject({
        archived: false,
        archivedAt: null,
        archivedBy: '',
      });
    });
  });

  describe('redundant flips', () => {
    it('refuses archiving an already-archived clinic', async () => {
      seed({ ...ACTIVE, archived: true });
      await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true })).catch((err: any) => {
        expect(err.details.code).toBe('vet_clinic_already_archived');
      });
      expect.assertions(1);
    });

    it('refuses unarchiving a clinic that is not archived', async () => {
      seed(ACTIVE);
      await archiveVetClinicHandler(req({ clinicId: 'c1', archived: false })).catch((err: any) => {
        expect(err.details.code).toBe('vet_clinic_not_archived');
      });
      expect.assertions(1);
    });

    it('treats a clinic with no archived field as active', async () => {
      // The field is newer than the catalog; absent must read as available.
      const ctx = seed({ name: 'Legacy Clinic' });
      await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true }));
      expect(clinicWrite(ctx)!.data.archived).toBe(true);
    });

    it('audits the redundant flip as a FAILURE and writes nothing', async () => {
      const ctx = seed({ ...ACTIVE, archived: true });
      await archiveVetClinicHandler(req({ clinicId: 'c1', archived: true })).catch(() => undefined);
      const audit = auditOf(AUDIT_EVENTS.VET_CLINIC_WRITE_REFUSED);
      expect(audit).toMatchObject({ status: 'FAILURE', severity: 'warn' });
      expect(clinicWrite(ctx)).toBeUndefined();
    });
  });

  it('still returns when the audit write itself fails', async () => {
    seed(ACTIVE);
    mocks.auditFn.mockRejectedValueOnce(new Error('chain head locked'));
    await expect(
      archiveVetClinicHandler(req({ clinicId: 'c1', archived: true })),
    ).resolves.toMatchObject({ ok: true });
  });
});
