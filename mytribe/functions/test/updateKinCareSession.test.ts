import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), roster: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/lib/kinRoster', () => ({ materializeKinRoster: mocks.roster }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { updateKinCareSessionHandler } from '../src/admin/updateKinCareSession';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.roster.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * A visit carrying the fields no edit form has a control for. Every test below
 * that writes asserts they came back untouched, because wiping them is the
 * failure mode this callable is shaped to make impossible: `_backfilledFrom` and
 * friends are the ONLY record of why the migration stub sessions exist.
 */
const visit = (extra: Record<string, unknown> = {}) => ({
  kinfolkId: 'fam1',
  status: 'SCHEDULED',
  serviceType: 'Dog Walk',
  notes: 'Gate sticks.',
  serviceDurationMinutes: 30,
  startTime: '2026-08-24T14:00:00Z',
  endTime: '2026-08-24T14:30:00Z',
  gpsSummary: { distanceMeters: 1200 },
  invoiceId: 'inv7',
  _backfilledFrom: 'visit_logs/legacy_81',
  _reason: 'pre-cutover orphan',
  ...extra,
});

function seed(sessions: Record<string, Record<string, unknown> | null>) {
  const docs: Record<string, Record<string, unknown> | null> = {};
  for (const [id, data] of Object.entries(sessions)) docs[`kin_care_sessions/${id}`] = data;
  return buildDbMock({ docs });
}

function writeAt(ctx: ReturnType<typeof seed>, id: string) {
  return ctx.writes.find((w) => w.path === `kin_care_sessions/${id}`);
}

describe('editing a visit', () => {
  it('writes only the fields stated, and stamps who did it', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await updateKinCareSessionHandler(
      req({ sessionId: 's1', serviceType: 'Puppy Visit 30m' }),
    );

    expect(res).toEqual({ ok: true, sessionId: 's1', updated: ['serviceType'] });
    const write = writeAt(ctx, 's1');
    expect(write?.merge).toBe(true);
    expect(write?.data).toEqual({
      serviceType: 'Puppy Visit 30m',
      updatedAt: '__TS__',
      updatedBy: 'admin1',
    });
  });

  // The whole reason this is a patch and not a rebuild.
  it('leaves every field the form has no control for exactly where it was', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateKinCareSessionHandler(req({ sessionId: 's1', notes: 'Gate fixed.' }));
    const data = writeAt(ctx, 's1')?.data ?? {};
    for (const untouchable of [
      '_backfilledFrom',
      '_reason',
      'gpsSummary',
      'invoiceId',
      'status',
      'startTime',
      'endTime',
      'completedAt',
      'arrivedAt',
      'departedAt',
      'kinfolkId',
    ]) {
      expect(data).not.toHaveProperty(untouchable);
    }
  });

  it('takes several fields in one write', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await updateKinCareSessionHandler(
      req({ sessionId: 's1', serviceType: 'Drop-In', notes: '', serviceDurationMinutes: 45 }),
    );
    expect(res.updated).toEqual(['serviceType', 'notes', 'serviceDurationMinutes']);
    expect(writeAt(ctx, 's1')?.data).toMatchObject({
      serviceType: 'Drop-In',
      // Emptying the notes is a real edit, not an omission: `''` is stated, so
      // it is written. Only an ABSENT key is left alone.
      notes: '',
      serviceDurationMinutes: 45,
    });
  });

  it('re-resolves the Kin names in the same write, so the pair cannot drift', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.roster.mockResolvedValue({ kinIds: ['p1'], kinNames: ['Biscuit'] });

    const res = await updateKinCareSessionHandler(req({ sessionId: 's1', kinIds: ['p1'] }));

    expect(mocks.roster).toHaveBeenCalledWith('fam1', ['p1']);
    expect(res.updated).toEqual(['kinIds', 'kinNames']);
    expect(writeAt(ctx, 's1')?.data).toMatchObject({ kinIds: ['p1'], kinNames: ['Biscuit'] });
  });

  // R1: an empty roster is the whole household, and the server is where that is
  // materialized, so no client has to know the convention.
  it('expands an empty kinIds to the whole household rather than storing "no Kin"', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.roster.mockResolvedValue({ kinIds: ['p1', 'p2'], kinNames: ['Biscuit', 'Gravy'] });

    await updateKinCareSessionHandler(req({ sessionId: 's1', kinIds: [] }));

    expect(mocks.roster).toHaveBeenCalledWith('fam1', []);
    expect(writeAt(ctx, 's1')?.data).toMatchObject({ kinIds: ['p1', 'p2'] });
  });

  it('records the field NAMES in the audit, never the free text', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateKinCareSessionHandler(
      req({ sessionId: 's1', notes: 'Mrs W is in hospital, do not mention it.' }),
    );
    const audit = (writeAuditEntry as any).mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a.event === AUDIT_EVENTS.UPDATE_KINCARE_SESSION);
    expect(audit).toMatchObject({ status: 'SUCCESS', payload: { updated: ['notes'] } });
    expect(JSON.stringify(audit.payload)).not.toContain('hospital');
  });
});

describe('what it refuses', () => {
  it('a patch that states no field at all', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(updateKinCareSessionHandler(req({ sessionId: 's1' }))).rejects.toThrow(
      /validation failed/,
    );
    expect(writeAt(ctx, 's1')).toBeUndefined();
  });

  it('a session that is not there', async () => {
    const ctx = seed({ s1: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateKinCareSessionHandler(req({ sessionId: 's1', notes: 'x' })),
    ).rejects.toThrow(/not found/i);
  });

  it('a blank service type: pricing is by this exact name, so it cannot be emptied', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateKinCareSessionHandler(req({ sessionId: 's1', serviceType: '' })),
    ).rejects.toThrow(/validation failed/);
  });

  it('a visit length outside 0..1440 minutes, or one that is not whole', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    for (const bad of [-1, 1441, 30.5]) {
      await expect(
        updateKinCareSessionHandler(req({ sessionId: 's1', serviceDurationMinutes: bad })),
      ).rejects.toThrow(/validation failed/);
    }
  });

  it('a Kin edit on a session with no household, rather than leaving kinNames stale', async () => {
    const ctx = seed({ s1: { status: 'SCHEDULED', startTime: '2026-08-24T14:00:00Z' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await updateKinCareSessionHandler(req({ sessionId: 's1', kinIds: ['p1'] })).catch(
      (e: unknown) => e,
    );
    expect((err as HttpsError).details).toMatchObject({ code: 'session_has_no_kinfolk' });
    expect(mocks.roster).not.toHaveBeenCalled();
  });

  // THE FIELDS THAT HAVE ANOTHER OWNER. Each is rejected by the schema simply
  // not carrying it, which is the point: there is no branch to forget.
  it.each([
    ['status', 'COMPLETED'],
    ['completedAt', '2026-08-24T15:00:00Z'],
    ['startTime', '2026-08-25T09:00:00Z'],
    ['endTime', '2026-08-25T10:00:00Z'],
    ['arrivedAt', '2026-08-24T14:02:00Z'],
    ['departedAt', '2026-08-24T14:45:00Z'],
    ['kinfolkId', 'fam2'],
  ])('never writes %s, whatever the caller sends', async (field, value) => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    // Sent alongside a legal field so the call is not refused for being empty:
    // the question is whether the illegal key rides along, not whether the call
    // succeeds.
    await updateKinCareSessionHandler(req({ sessionId: 's1', notes: 'ok', [field]: value }));
    expect(writeAt(ctx, 's1')?.data).not.toHaveProperty(field);
  });

  it('an unsigned caller', async () => {
    await expect(
      updateKinCareSessionHandler(req({ sessionId: 's1', notes: 'x' }, null)),
    ).rejects.toThrow(/Sign-in required/);
  });
});
