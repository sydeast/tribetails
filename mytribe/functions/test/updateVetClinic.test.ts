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

import { updateVetClinicHandler, Args } from '../src/admin/updateVetClinic';
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

const RIVERSIDE = {
  name: 'Riverside Animal Hospital',
  phone: '(512) 555-0100',
  address: '418 Mill St',
  website: '',
  hours: '',
  isEmergency: false,
  notes: '',
  verified: true,
};

/**
 * Seeds the clinic doc, the clinic collection (for the rename dedupe scan) and
 * the kinfolk collection (for the fan-out lookup).
 */
function seed(opts: {
  clinic?: Record<string, unknown> | null;
  others?: Array<{ id: string; data: Record<string, unknown> }>;
  /** `household_data` rows. The household link lives here, not on kinfolk. */
  households?: Array<{ id: string; data: Record<string, unknown> }>;
}) {
  const clinic = opts.clinic === undefined ? RIVERSIDE : opts.clinic;
  const ctx = buildDbMock({
    docs: { 'vet_clinics/c1': clinic },
    queryDocs: {
      vet_clinics: [
        ...(clinic ? [{ id: 'c1', data: clinic }] : []),
        ...(opts.others ?? []),
      ],
      household_data: opts.households ?? [],
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

const VALID = { clinicId: 'c1', name: 'Riverside Animal Hospital', phone: '(512) 555-0199' };

function clinicWrite(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.find((w) => w.path === 'vet_clinics/c1');
}

function auditOf(event: string) {
  return mocks.auditFn.mock.calls.map((c) => c[0]).find((a: any) => a.event === event);
}

describe('updateVetClinic', () => {
  describe('auth and validation', () => {
    it('rejects an unauthenticated caller', async () => {
      seed({});
      await expect(updateVetClinicHandler(req(VALID, null))).rejects.toThrow(/Sign-in/);
    });

    it('rejects a blank clinic name', async () => {
      seed({});
      await expect(
        updateVetClinicHandler(req({ clinicId: 'c1', name: '   ' })),
      ).rejects.toThrow(/validation failed/);
    });

    it('rejects a missing clinicId', async () => {
      seed({});
      await expect(updateVetClinicHandler(req({ name: 'X' }))).rejects.toThrow(/validation failed/);
    });

    it('rejects a non-boolean isEmergency rather than coercing it', async () => {
      seed({});
      await expect(
        updateVetClinicHandler(req({ ...VALID, isEmergency: 'yes' })),
      ).rejects.toThrow(/validation failed/);
    });

    it('carries the offending path in details.validationErrors', async () => {
      seed({});
      await updateVetClinicHandler(req({ clinicId: 'c1', name: '' })).catch((err: any) => {
        expect(err.details.validationErrors[0].path).toBe('name');
      });
      expect.assertions(1);
    });
  });

  describe('refusals', () => {
    it('refuses a clinic that does not exist, with a machine code', async () => {
      seed({ clinic: null });
      await updateVetClinicHandler(req(VALID)).catch((err: any) => {
        expect(err.code).toBe('not-found');
        expect(err.details.code).toBe('vet_clinic_not_found');
      });
      expect.assertions(2);
    });

    it('audits the not-found refusal as a FAILURE', async () => {
      seed({ clinic: null });
      await updateVetClinicHandler(req(VALID)).catch(() => undefined);
      const audit = auditOf(AUDIT_EVENTS.VET_CLINIC_WRITE_REFUSED);
      expect(audit).toMatchObject({ status: 'FAILURE', severity: 'warn' });
      expect(audit.payload.refusalCode).toBe('vet_clinic_not_found');
    });

    it('refuses a rename onto another clinic, case and space insensitively', async () => {
      seed({ others: [{ id: 'c2', data: { name: 'the  MILL vet' } }] });
      await updateVetClinicHandler(req({ ...VALID, name: 'The Mill Vet' })).catch((err: any) => {
        expect(err.details.code).toBe('vet_clinic_duplicate_name');
      });
      expect.assertions(1);
    });

    it('audits a duplicate-name refusal and writes nothing', async () => {
      const ctx = seed({ others: [{ id: 'c2', data: { name: 'The Mill Vet' } }] });
      await updateVetClinicHandler(req({ ...VALID, name: 'The Mill Vet' })).catch(() => undefined);
      expect(auditOf(AUDIT_EVENTS.VET_CLINIC_WRITE_REFUSED).payload.refusalCode).toBe(
        'vet_clinic_duplicate_name',
      );
      expect(clinicWrite(ctx)).toBeUndefined();
    });

    it('allows a clinic to keep its own name (no self-collision)', async () => {
      const ctx = seed({});
      await updateVetClinicHandler(req(VALID));
      expect(clinicWrite(ctx)!.data.phone).toBe('(512) 555-0199');
    });

    it('allows a case-only rename of the clinic itself', async () => {
      const ctx = seed({});
      await updateVetClinicHandler(req({ ...VALID, name: 'RIVERSIDE ANIMAL HOSPITAL' }));
      expect(clinicWrite(ctx)!.data.name).toBe('RIVERSIDE ANIMAL HOSPITAL');
    });
  });

  describe('the save', () => {
    it('writes the corrected phone and stamps updatedAt', async () => {
      const ctx = seed({});
      const res = await updateVetClinicHandler(req(VALID));
      expect(res).toEqual({ ok: true, clinicId: 'c1', householdCount: 0 });
      expect(clinicWrite(ctx)!.data).toMatchObject({
        phone: '(512) 555-0199',
        updatedAt: '__TS__',
      });
    });

    it('clears an omitted optional field rather than leaving it stale', async () => {
      // The clients edit a whole record, so "address deleted from the form"
      // must clear the address. A patch shape could never clear a bad one.
      const ctx = seed({});
      await updateVetClinicHandler(req({ clinicId: 'c1', name: RIVERSIDE.name }));
      expect(clinicWrite(ctx)!.data.address).toBe('');
    });

    it('stores hours on the clinic', async () => {
      const ctx = seed({});
      await updateVetClinicHandler(req({ ...VALID, hours: 'Mon to Fri 8a to 6p' }));
      expect(clinicWrite(ctx)!.data.hours).toBe('Mon to Fri 8a to 6p');
    });

    it('leaves verified alone when the caller omits it', async () => {
      const ctx = seed({});
      await updateVetClinicHandler(req(VALID));
      expect('verified' in clinicWrite(ctx)!.data).toBe(false);
    });

    it('approves a pending submission when verified is passed', async () => {
      const ctx = seed({ clinic: { ...RIVERSIDE, verified: false } });
      await updateVetClinicHandler(req({ ...VALID, verified: true }));
      expect(clinicWrite(ctx)!.data.verified).toBe(true);
    });

    it('audits the save as a SUCCESS naming what changed', async () => {
      seed({});
      await updateVetClinicHandler(req(VALID));
      const audit = auditOf(AUDIT_EVENTS.VET_CLINIC_UPDATED);
      expect(audit).toMatchObject({ status: 'SUCCESS', actorRole: 'AUNTIE', actorUid: 'auntie1' });
      expect(audit.payload).toMatchObject({ phoneChanged: true, nameChanged: false });
    });

    it('still returns when the audit write itself fails', async () => {
      // Best effort: a broken audit must not swallow a correction that landed.
      seed({});
      mocks.auditFn.mockRejectedValueOnce(new Error('chain head locked'));
      await expect(updateVetClinicHandler(req(VALID))).resolves.toMatchObject({ ok: true });
    });
  });

  /**
   * THERE IS NO FAN-OUT, and that is the point. `household_data` stores the
   * clinic ID and resolves name/phone/address/hours through this row at read
   * time, so there is exactly ONE copy of a clinic's details in the product. A
   * correction is not propagated to households: it simply IS what every linked
   * household reads from the next render on.
   */
  describe('reach reporting, not propagation', () => {
    const LINKED = [
      { id: 'h1', data: { primaryVetClinicId: 'c1' } },
      { id: 'h2', data: { primaryVetClinicId: 'other' } },
    ];
    it('reports how many households read the clinic', async () => {
      const res = await (async () => {
        seed({ households: LINKED });
        return updateVetClinicHandler(req(VALID));
      })();
      expect(res.householdCount).toBe(1);
    });
    it('writes NOTHING to any household', async () => {
      const ctx = seed({ households: LINKED });
      await updateVetClinicHandler(req(VALID));
      expect(ctx.writes.filter((w) => w.path.startsWith('household_data/'))).toEqual([]);
      expect(ctx.writes.filter((w) => w.path.startsWith('kinfolk/'))).toEqual([]);
    });
    it('counts a household linked through the emergency slot', async () => {
      seed({ households: [{ id: 'h3', data: { emergencyVetClinicId: 'c1' } }] });
      const res = await updateVetClinicHandler(req(VALID));
      expect(res.householdCount).toBe(1);
    });
    it('counts a household using BOTH slots exactly once', async () => {
      seed({
        households: [{ id: 'h4', data: { primaryVetClinicId: 'c1', emergencyVetClinicId: 'c1' } }],
      });
      const res = await updateVetClinicHandler(req(VALID));
      expect(res.householdCount).toBe(1);
    });
    it('raises audit severity to warn when linked households read the change', async () => {
      seed({ households: LINKED });
      await updateVetClinicHandler(req(VALID));
      const audit = auditOf(AUDIT_EVENTS.VET_CLINIC_UPDATED);
      expect(audit.severity).toBe('warn');
      expect(audit.payload.householdIds).toEqual(['h1']);
    });
    it('stays at info when nothing links to the clinic', async () => {
      seed({ households: [] });
      await updateVetClinicHandler(req(VALID));
      expect(auditOf(AUDIT_EVENTS.VET_CLINIC_UPDATED).severity).toBe('info');
    });
  });
  describe('request shape', () => {
    it('defaults every optional field so a minimal payload is complete', () => {
      const parsed = Args.parse({ clinicId: 'c1', name: 'X' });
      expect(parsed).toMatchObject({
        phone: '',
        address: '',
        website: '',
        hours: '',
        notes: '',
        isEmergency: false,
      });
      expect(parsed.verified).toBeUndefined();
    });

    it('trims the name it stores', () => {
      expect(Args.parse({ clinicId: 'c1', name: '  Riverside  ' }).name).toBe('Riverside');
    });
  });
});
