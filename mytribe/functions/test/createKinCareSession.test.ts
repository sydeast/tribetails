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

// The #148 half of this file: sessions carry the pets' REAL names, never a
// hardcoded empty list. Times sit a day out so the busy-conflict guard (below)
// has nothing to say here.
//
// #1822 / #1862 (operator ruling 2026-11-12): every visit covers every Kin.
// The roster is the household's active Kin, and what the caller names is kept
// only while the choose-Kin flag is on.
describe('createKinCareSession kin names', () => {
  const CHOOSE_KIN_ON = { 'business_settings/feature_flags': { flags: { 'auntieos.visits.chooseKin': true } } };
  /** A dog and a cat in care, a memorial Kin, and a Kin the office made that has no household copy. */
  function home(docs: Record<string, Record<string, unknown>> = {}) {
    return buildDbMock({
      docs,
      queryDocs: {
        'families/3/kin': [
          { id: 'k1', data: { name: 'Fido', legacyKinId: 'flat1' } },
          { id: 'k2', data: { name: 'Whiskers', status: 'active' } },
          { id: 'k3', data: { name: 'Old Boy', status: 'noLongerWithUs' } },
        ],
        kin: [
          { id: 'flat1', data: { name: 'Fido', kinfolkId: '3' } },
          { id: 'flat9', data: { name: 'Office Cat', kinfolkId: '3' } },
          { id: 'flat8', data: { name: 'Gone', kinfolkId: '3', status: 'archived' } },
          { id: 'other', data: { name: 'Next Door', kinfolkId: '4' } },
        ],
      },
    });
  }
  function visitFor(kinIds?: string[]) {
    return req({
      kinfolkId: '3',
      ...(kinIds ? { kinIds } : {}),
      serviceType: 'walk',
      startTime: new Date(Date.now() + DAY).toISOString(),
      endTime: new Date(Date.now() + DAY + 3600_000).toISOString(),
    });
  }

  it('covers every active Kin in the home when none is named', async () => {
    const ctx = home();
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(visitFor());
    expect(sessionWrites(ctx)).toHaveLength(1);
    const written = sessionWrites(ctx)[0].data;
    expect(written.kinIds).toEqual(['flat1', 'k2', 'flat9']);
    expect(written.kinNames).toEqual(['Fido', 'Whiskers', 'Office Cat']);
  });

  it('with choosing Kin off, an older app that names one Kin still gets a visit for the whole home', async () => {
    const ctx = home();
    mocks.dbFn.mockReturnValue(ctx.db);
    const r = await createKinCareSessionHandler(visitFor(['k2']));
    expect(r.ok).toBe(true);
    expect(sessionWrites(ctx)[0].data.kinIds).toEqual(['flat1', 'k2', 'flat9']);
    expect(sessionWrites(ctx)[0].data.kinNames).toEqual(['Fido', 'Whiskers', 'Office Cat']);
  });

  it('with choosing Kin on, keeps the Kin that were named', async () => {
    const ctx = home(CHOOSE_KIN_ON);
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(visitFor(['k2']));
    expect(sessionWrites(ctx)[0].data.kinIds).toEqual(['k2']);
    expect(sessionWrites(ctx)[0].data.kinNames).toEqual(['Whiskers']);
  });

  it('with choosing Kin on, reads a household card id as the Kin it belongs to, stored under its admin record', async () => {
    const ctx = home(CHOOSE_KIN_ON);
    mocks.dbFn.mockReturnValue(ctx.db);

    await createKinCareSessionHandler(visitFor(['k1']));

    expect(sessionWrites(ctx)[0].data.kinIds).toEqual(['flat1']);
    expect(sessionWrites(ctx)[0].data.kinNames).toEqual(['Fido']);
  });

  it('with choosing Kin on, reads an admin record id as the Kin it belongs to', async () => {
    const ctx = home(CHOOSE_KIN_ON);
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(visitFor(['flat1', 'flat9']));
    expect(sessionWrites(ctx)[0].data.kinIds).toEqual(['flat1', 'flat9']);
    expect(sessionWrites(ctx)[0].data.kinNames).toEqual(['Fido', 'Office Cat']);
  });

  it('with choosing Kin on, drops a Kin that is not in care or not in this home', async () => {
    const ctx = home(CHOOSE_KIN_ON);
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(visitFor(['k1', 'k3', 'flat8', 'other', 'missing-kin']));
    expect(sessionWrites(ctx)[0].data.kinIds).toEqual(['flat1']);
    expect(sessionWrites(ctx)[0].data.kinNames).toEqual(['Fido']);
  });

  it('with choosing Kin on, naming nobody who is in care means the whole home, never a visit for nobody', async () => {
    const ctx = home(CHOOSE_KIN_ON);
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(visitFor(['k3', 'missing-kin']));
    expect(sessionWrites(ctx)[0].data.kinIds).toEqual(['flat1', 'k2', 'flat9']);
  });

  it('a tester with the flag on their own account chooses, while it is off for everyone else', async () => {
    const ctx = home({ 'clients/admin1': { featureFlags: { 'auntieos.visits.chooseKin': true } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(visitFor(['k2']));
    expect(sessionWrites(ctx)[0].data.kinIds).toEqual(['k2']);
  });

  it('writes no Kin for a household that has none on file', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(visitFor());
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
    const ctx = buildDbMock({ queryDocs: { 'families/kf1/kin': [{ id: 'k1', data: { name: 'QA-Pup' } }] } });
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

// ── #1630: an Android booking's approval writes the record too, once ─────────
describe('createKinCareSession for an Android booking (enhancedBookingId)', () => {
  const start = () => new Date(Date.now() + DAY).toISOString();
  const end = () => new Date(Date.now() + DAY + 30 * 60_000).toISOString();
  const args = (extra: Record<string, unknown> = {}) => ({
    kinfolkId: 'kf1',
    kinIds: ['k1'],
    serviceType: 'Dog Walk',
    startTime: start(),
    endTime: end(),
    enhancedBookingId: 'eb123',
    ...extra,
  });

  it('writes the booking record under ids derived from the booking, and links the session to it', async () => {
    const ctx = buildDbMock({ queryDocs: { 'families/kf1/kin': [{ id: 'k1', data: { name: 'QA-Pup' } }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createKinCareSessionHandler(req(args()));
    expect(res.sessionId).toBe('vis_enh_eb123');
    const paths = ctx.writes.map((w) => w.path);
    expect(paths).toContain('families/kf1/bookings/enh_eb123');
    expect(paths).toContain('families/kf1/bookings/enh_eb123/kinCares/enh_eb123');
    const session = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_enh_eb123');
    expect(session?.data).toMatchObject({
      enhancedBookingId: 'eb123',
      kinCareBatchId: 'enh_eb123',
      kinCareVisitId: 'enh_eb123',
      status: 'SCHEDULED',
    });
  });

  it('approving the same booking again returns the first visit and writes nothing', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_sessions/vis_enh_eb123': { status: 'SCHEDULED', enhancedBookingId: 'eb123' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createKinCareSessionHandler(req(args()));
    expect(res.sessionId).toBe('vis_enh_eb123');
    expect(ctx.writes).toHaveLength(0);
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('a New visit without the id still mints its own ids and carries no enhancedBookingId', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createKinCareSessionHandler(req(args({ enhancedBookingId: undefined })));
    expect(res.sessionId).not.toMatch(/enh_/);
    const session = sessionWrites(ctx)[0];
    expect(session?.data).not.toHaveProperty('enhancedBookingId');
  });

  it('refuses an id that is not a document id, rather than build a path from it', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(createKinCareSessionHandler(req(args({ enhancedBookingId: 'a/b' })))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});
describe('#2347 (ruling 2026-11-20, keep): approving an Android draft keeps the Kin it was saved with', () => {
  const start = () => new Date(Date.now() + DAY).toISOString();
  const end = () => new Date(Date.now() + DAY + 30 * 60_000).toISOString();
  /** Choosing Kin is OFF (no flag doc): the switch was turned off while the draft waited. */
  function home(draft: Record<string, unknown> | null) {
    return buildDbMock({
      docs: draft === null ? {} : { 'enhanced_bookings/eb1': draft },
      queryDocs: {
        'families/kf1/kin': [
          { id: 'card-a', data: { name: 'Biscuit', legacyKinId: 'flat-a' } },
          { id: 'card-b', data: { name: 'Gravy', legacyKinId: 'flat-b' } },
          { id: 'card-c', data: { name: 'Old Boy', legacyKinId: 'flat-c', status: 'noLongerWithUs' } },
        ],
        kin: [
          { id: 'flat-a', data: { name: 'Biscuit', kinfolkId: 'kf1' } },
          { id: 'flat-b', data: { name: 'Gravy', kinfolkId: 'kf1' } },
          { id: 'flat-c', data: { name: 'Old Boy', kinfolkId: 'kf1' } },
        ],
      },
    });
  }
  const approve = (kinIds: string[]) =>
    req({ kinfolkId: 'kf1', kinIds, serviceType: 'Dog Walk', startTime: start(), endTime: end(), enhancedBookingId: 'eb1' });
  const written = (ctx: ReturnType<typeof buildDbMock>) => ({
    session: ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_enh_eb1')?.data,
    visit: ctx.writes.find((w) => w.path === 'families/kf1/bookings/enh_eb1/kinCares/enh_eb1')?.data,
    envelope: ctx.writes.find((w) => w.path === 'families/kf1/bookings/enh_eb1')?.data,
  });
  it('keeps the one Kin the draft chose, on the visit, its record and its envelope', async () => {
    const ctx = home({ kinfolkId: 'kf1', kinIds: ['flat-b'], status: 'PENDING' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(approve(['flat-b']));
    const w = written(ctx);
    for (const doc of [w.session, w.visit, w.envelope]) {
      expect(doc).toMatchObject({ kinIds: ['flat-b'], kinNames: ['Gravy'] });
    }
  });
  it('reads the Kin from the stored draft, not from what the app sends', async () => {
    const ctx = home({ kinfolkId: 'kf1', kinIds: ['card-a'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(approve(['flat-a', 'flat-b']));
    expect(written(ctx).session).toMatchObject({ kinIds: ['flat-a'], kinNames: ['Biscuit'] });
  });
  it('a draft saved for every Kin covers every Kin in care', async () => {
    const ctx = home({ kinfolkId: 'kf1', kinIds: [] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(approve([]));
    expect(written(ctx).session).toMatchObject({ kinIds: ['flat-a', 'flat-b'], kinNames: ['Biscuit', 'Gravy'] });
  });
  it('a chosen Kin no longer in care is dropped, and a draft left with none covers the whole home', async () => {
    const ctx = home({ kinfolkId: 'kf1', kinIds: ['flat-c'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(approve(['flat-c']));
    expect(written(ctx).session).toMatchObject({ kinIds: ['flat-a', 'flat-b'] });
  });
  it('with no stored draft, the new-visit rule applies: choosing off means the whole home', async () => {
    const ctx = home(null);
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(approve(['flat-b']));
    expect(written(ctx).session).toMatchObject({ kinIds: ['flat-a', 'flat-b'] });
  });
  it('a draft filed under another household is not read', async () => {
    const ctx = home({ kinfolkId: 'kf2', kinIds: ['flat-b'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(approve(['flat-b']));
    expect(written(ctx).session).toMatchObject({ kinIds: ['flat-a', 'flat-b'] });
  });
});
