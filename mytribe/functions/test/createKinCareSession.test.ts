import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createKinCareSessionHandler } from '../src/admin/createKinCareSession';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

const DAY = 86_400_000;

describe('createKinCareSession happy path', () => {
  it('creates a SCHEDULED kin_care_sessions doc and audits it', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const start = new Date(Date.now() + DAY).toISOString();
    const end = new Date(Date.now() + DAY + 3600_000).toISOString();

    const res = await createKinCareSessionHandler(
      req({ kinfolkId: 'kf1', kinIds: ['k1'], serviceType: 'Dog Walk', startTime: start, endTime: end }),
    );

    expect(res.ok).toBe(true);
    const write = ctx.adds.find((a) => a.collection === 'kin_care_sessions');
    expect(write?.data.status).toBe('SCHEDULED');
    expect(write?.data.kinfolkId).toBe('kf1');
    expect(write?.data.startTime).toBe(start);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CREATE_KINCARE_SESSION', actorRole: 'AUNTIE', actorUid: 'admin1' }),
    );
  });

  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(
      createKinCareSessionHandler(
        req({ kinfolkId: 'kf1', serviceType: 'Walk', startTime: '2026-08-01T10:00:00Z', endTime: '2026-08-01T11:00:00Z' }, null),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a missing serviceType (zod)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(
      createKinCareSessionHandler(
        req({ kinfolkId: 'kf1', startTime: '2026-08-01T10:00:00Z', endTime: '2026-08-01T11:00:00Z' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

// The #148 half of this file: sessions carry the pets' REAL names, resolved
// from families/{kinfolkId}/kin/{kinId}, never a hardcoded empty list. Times
// sit a day out so the busy-conflict guard (below) has nothing to say here.
describe('createKinCareSession kin names', () => {
  it('resolves real kin names onto the session it creates (not kinNames: [])', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/kin/k1': { name: 'Fido' },
        'families/3/kin/k2': { name: 'Whiskers' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await createKinCareSessionHandler(
      req({
        kinfolkId: '3',
        kinIds: ['k1', 'k2'],
        serviceType: 'walk',
        startTime: new Date(Date.now() + DAY).toISOString(),
        endTime: new Date(Date.now() + DAY + 3600_000).toISOString(),
      }),
    );

    expect(ctx.adds).toHaveLength(1);
    const written = ctx.adds[0].data;
    expect(written.kinIds).toEqual(['k1', 'k2']);
    expect(written.kinNames).toEqual(['Fido', 'Whiskers']);
  });

  it('tolerates a missing kin doc rather than failing the session creation', async () => {
    const ctx = buildDbMock({ docs: { 'families/3/kin/k1': { name: 'Fido' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const r = await createKinCareSessionHandler(
      req({
        kinfolkId: '3',
        kinIds: ['k1', 'missing-kin'],
        serviceType: 'walk',
        startTime: new Date(Date.now() + DAY).toISOString(),
        endTime: new Date(Date.now() + DAY + 3600_000).toISOString(),
      }),
    );

    expect(r.ok).toBe(true);
    expect(ctx.adds[0].data.kinNames).toEqual(['Fido']);
  });

  it('writes kinNames: [] when no kinIds are given (no lookup attempted)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await createKinCareSessionHandler(
      req({
        kinfolkId: '3',
        serviceType: 'walk',
        startTime: new Date(Date.now() + DAY).toISOString(),
        endTime: new Date(Date.now() + DAY + 3600_000).toISOString(),
      }),
    );

    expect(ctx.adds[0].data.kinIds).toEqual([]);
    expect(ctx.adds[0].data.kinNames).toEqual([]);
  });
});

describe('createKinCareSession busy-conflict guard', () => {
  function seedWithBusySlot(startMs: number, endMs: number) {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    return buildDbMock({
      queryDocs: {
        booking_time_slots: [
          {
            id: 'gbi-1',
            data: {
              date: startIso.slice(0, 10),
              startTime: startIso.slice(11, 16),
              endTime: endIso.slice(11, 16),
              source: 'GOOGLE_BUSY_IMPORT',
            },
          },
        ],
      },
    });
  }

  it('rejects a session landing on a GOOGLE_BUSY_IMPORT slot, naming it, and creates nothing', async () => {
    const start = Date.now() + DAY;
    const ctx = seedWithBusySlot(start, start + 3600_000);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      createKinCareSessionHandler(
        req({
          kinfolkId: 'kf1',
          serviceType: 'Dog Walk',
          startTime: new Date(start + 60_000).toISOString(),
          endTime: new Date(start + 900_000).toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.adds).toHaveLength(0);
  });

  it('overrideBusyConflict:true creates the session anyway and audits the override', async () => {
    const start = Date.now() + DAY;
    const ctx = seedWithBusySlot(start, start + 3600_000);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createKinCareSessionHandler(
      req({
        kinfolkId: 'kf1',
        serviceType: 'Dog Walk',
        startTime: new Date(start + 60_000).toISOString(),
        endTime: new Date(start + 900_000).toISOString(),
        overrideBusyConflict: true,
      }),
    );
    expect(res.ok).toBe(true);
    expect(ctx.adds).toHaveLength(1);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BOOKING_BUSY_CONFLICT_OVERRIDDEN', actorRole: 'AUNTIE' }),
    );
  });

  it('a non-conflicting session passes unchanged', async () => {
    const start = Date.now() + DAY;
    const ctx = seedWithBusySlot(start + 30 * DAY, start + 30 * DAY + 3600_000);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createKinCareSessionHandler(
      req({
        kinfolkId: 'kf1',
        serviceType: 'Dog Walk',
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + 3600_000).toISOString(),
      }),
    );
    expect(res.ok).toBe(true);
    expect(ctx.adds).toHaveLength(1);
  });
});
