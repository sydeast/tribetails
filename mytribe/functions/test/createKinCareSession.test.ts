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

import { createKinCareSessionHandler, visitLengthMinutes } from '../src/admin/createKinCareSession';

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

/** #1575: the session is a batch `set` at `kin_care_sessions/vis_{visitId}` now, not an `add()`. */
function sessionWrites(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'));
}

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
    const write = ctx.writes.find((w) => w.path.startsWith('kin_care_sessions/'));
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

    expect(sessionWrites(ctx)).toHaveLength(1);
    const written = sessionWrites(ctx)[0].data;
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
    expect(sessionWrites(ctx)[0].data.kinNames).toEqual(['Fido']);
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

    expect(sessionWrites(ctx)[0].data.kinIds).toEqual([]);
    expect(sessionWrites(ctx)[0].data.kinNames).toEqual([]);
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
    expect(sessionWrites(ctx)).toHaveLength(0);
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
    expect(sessionWrites(ctx)).toHaveLength(1);
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
    expect(sessionWrites(ctx)).toHaveLength(1);
  });
});

// #1575: a New visit is a one-visit booking record, already confirmed, so the
// Auntie assignment and both note threads have a visit document to live on.
describe('createKinCareSession writes the booking record the visit sheet needs', () => {
  async function create(extra: Record<string, unknown> = {}) {
    const ctx = buildDbMock({ docs: { 'families/kf1/kin/k1': { name: 'QA-Pup' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const start = new Date(Date.now() + DAY).toISOString();
    const end = new Date(Date.now() + DAY + 30 * 60_000).toISOString();
    const res = await createKinCareSessionHandler(
      req({
        kinfolkId: 'kf1',
        kinIds: ['k1'],
        serviceType: '30 Minute Quick Check',
        startTime: start,
        endTime: end,
        serviceDurationMinutes: 30,
        notes: 'Gate code is on the fridge',
        ...extra,
      }),
    );
    const envelope = ctx.writes.find((w) => /^families\/kf1\/bookings\/[^/]+$/.test(w.path));
    const visit = ctx.writes.find((w) => /^families\/kf1\/bookings\/[^/]+\/kinCares\/[^/]+$/.test(w.path));
    const session = sessionWrites(ctx)[0];
    return { ctx, res, start, end, envelope, visit, session };
  }

  it('writes envelope, visit and session together, linked both ways', async () => {
    const { res, envelope, visit, session } = await create();
    expect(envelope).toBeDefined();
    expect(visit).toBeDefined();
    const batchId = envelope!.path.split('/')[3];
    const visitId = visit!.path.split('/')[5];
    expect(visit!.path).toBe(`families/kf1/bookings/${batchId}/kinCares/${visitId}`);
    // The id every server path derives from a visit id.
    expect(res.sessionId).toBe(`vis_${visitId}`);
    expect(session.path).toBe(`kin_care_sessions/vis_${visitId}`);
    expect(session.data).toMatchObject({
      kinCareBatchId: batchId,
      kinCareVisitId: visitId,
      sourceBookingId: visitId,
      status: 'SCHEDULED',
    });
    expect(visit!.data).toMatchObject({ sessionId: `vis_${visitId}`, batchId, status: 'confirmed' });
    expect(envelope!.data).toMatchObject({ envelopeStatus: 'confirmed', visitIds: [visitId], visitCount: 1 });
  });

  it('stores the visit window as Timestamps on the visit, matching the request writer', async () => {
    const { start, end, visit } = await create();
    expect((visit!.data.startTime as { toMillis(): number }).toMillis()).toBe(Date.parse(start));
    expect((visit!.data.endTime as { toMillis(): number }).toMillis()).toBe(Date.parse(end));
    expect(visit!.data.startTimePending).toBe(false);
  });

  it('starts unassigned, so creating it sends no "a visit is yours"', async () => {
    const { visit } = await create();
    expect(visit!.data.assignedAuntieUid).toBeNull();
  });

  it('carries the approve stamp, so onBookingsWrite sends no per-visit confirmation', async () => {
    const { visit, envelope } = await create();
    expect(visit!.data.seriesApprovedAt).toBe('__TS__');
    expect(visit!.data.scheduledByOffice).toBe(true);
    // onBookingEnvelopeCreate only speaks for a `requested` envelope.
    expect(envelope!.data.envelopeStatus).not.toBe('requested');
  });

  it('keeps the office note on the session, never on the visit the household can read', async () => {
    const { visit, envelope, session } = await create();
    expect(session.data.notes).toBe('Gate code is on the fridge');
    expect(visit!.data.notes).toBeNull();
    expect(envelope!.data.notes).toBeNull();
  });

  it('names the kin on the visit and the envelope as on the session (R1)', async () => {
    const { visit, envelope, session } = await create();
    expect(session.data.kinNames).toEqual(['QA-Pup']);
    expect(visit!.data.kinNames).toEqual(['QA-Pup']);
    expect(envelope!.data.kinIds).toEqual(['k1']);
  });

  it('commits nothing at all when a guard refuses', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createKinCareSessionHandler(
        req({
          kinfolkId: 'kf1',
          serviceType: 'Dog Walk',
          startTime: '2026-12-25T15:00:00.000Z',
          endTime: '2026-12-25T16:00:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes.filter((w) => w.path.startsWith('families/'))).toHaveLength(0);
  });
});

// #1581: Auntie Time read "Visit length 0" for a 20:00 to 20:30 visit. A New
// visit that states no length (or 0) stores its window's own span.
describe('createKinCareSession visit length (#1581)', () => {
  const start = new Date(Date.now() + DAY).toISOString();
  const end = new Date(Date.now() + DAY + 30 * 60_000).toISOString();

  it('stores the window when no length is stated', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(req({ kinfolkId: 'kf1', serviceType: 'Walk', startTime: start, endTime: end }));
    expect(sessionWrites(ctx)[0]!.data.serviceDurationMinutes).toBe(30);
  });

  it('stores the window when the stated length is 0', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(
      req({ kinfolkId: 'kf1', serviceType: 'Walk', startTime: start, endTime: end, serviceDurationMinutes: 0 }),
    );
    expect(sessionWrites(ctx)[0]!.data.serviceDurationMinutes).toBe(30);
  });

  it('keeps a stated length as stated', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(
      req({ kinfolkId: 'kf1', serviceType: 'Walk', startTime: start, endTime: end, serviceDurationMinutes: 45 }),
    );
    expect(sessionWrites(ctx)[0]!.data.serviceDurationMinutes).toBe(45);
  });

  it('a window it cannot read stays 0 rather than a guess', () => {
    expect(visitLengthMinutes(undefined, 'soon', 'later')).toBe(0);
    expect(visitLengthMinutes(undefined, end, start)).toBe(0);
  });
});
