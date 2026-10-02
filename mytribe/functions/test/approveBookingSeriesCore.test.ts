import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

describe('approveBookingSeriesCore', () => {
  it('returns found=false when the parent envelope does not exist', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });
    expect(r.found).toBe(false);
    expect(r.sessionsCreated).toBe(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('confirms every visit, creates one session each, rolls the envelope, audits', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T11:00:00Z', kinIds: ['k1'], serviceType: 'walk', notes: 'AM' } },
          { id: 'v2', data: { startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T10:30:00Z', kinIds: ['k1'], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(r.found).toBe(true);
    expect(r.affectedVisits).toBe(2);
    expect(r.sessionsCreated).toBe(2);
    expect(r.failedVisits).toBe(0);
    expect(r.envelopeStatus).toBe('confirmed');

    // One kin_care_sessions doc per visit, deterministic vis_{id}.
    const s1 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    const s2 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v2');
    expect(s1?.data.status).toBe('SCHEDULED');
    expect(s1?.data.kinfolkName).toBe('Doe Household');
    expect(s1?.data.serviceDurationMinutes).toBe(60);
    expect(s1?.data.createdBy).toBe('sys');
    expect(s2?.data.serviceDurationMinutes).toBe(30);

    // Each child flipped to confirmed + linked to its session.
    const c1 = ctx.writes.find((w) => w.path === 'families/3/bookings/b1/kinCares/v1');
    expect(c1?.data.status).toBe('confirmed');
    expect(c1?.data.sessionId).toBe('vis_v1');

    // Envelope rolled.
    const env = ctx.writes.find((w) => w.path === 'families/3/bookings/b1');
    expect(env?.data.envelopeStatus).toBe('confirmed');
    expect(env?.data.confirmedCount).toBe(2);

    // Audited as an APPROVE, status SUCCESS since every visit succeeded.
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE_BOOKING_SERIES', actorRole: 'SYSTEM', status: 'SUCCESS' }),
    );
  });

  it('resolves real kin names onto the session it creates (not kinNames: [])', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household' },
        'families/3/kin/k1': { name: 'Fido' },
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T11:00:00Z', kinIds: ['k1'], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    const s1 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    expect(s1?.data.kinIds).toEqual(['k1']);
    expect(s1?.data.kinNames).toEqual(['Fido']);
  });

  it('is idempotent: a re-approve with an existing session creates 0 sessions', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household' },
        'kin_care_sessions/vis_v1': { status: 'SCHEDULED' }, // already exists
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T11:00:00Z', kinIds: [], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });
    expect(r.sessionsCreated).toBe(0);
    expect(r.affectedVisits).toBe(1);
  });

  // `toIso` degrades anything it cannot read to ''. Every window over
  // kin_care_sessions is a LEXICAL range on the ISO string, so a session
  // stored with startTime '' sorts before every real date and is invisible to
  // listUninvoicedSessions, optimizeRoute and the calendar push. It is a real
  // visit that can never be billed, and nothing raises. These pin the refusal.
  for (const [label, startTime] of [
    ['missing', undefined],
    ['null', null],
    ['a number the SDK never returns', 1_767_000_000_000],
    ['an object that is not a Timestamp', { seconds: 1 }],
  ] as Array<[string, unknown]>) {
    it(`refuses to create an unbillable session when startTime is ${label}`, async () => {
      const ctx = buildDbMock({
        docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
        queryDocs: {
          'families/3/bookings/b1/kinCares': [
            { id: 'v1', data: { startTime, endTime: '2026-07-01T11:00:00Z', kinIds: ['k1'], serviceType: 'walk' } },
          ],
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

      const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

      // No session doc at all. A missing visit the operator can see beats an
      // invisible one they cannot.
      expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')).toBeUndefined();
      expect(r.sessionsCreated).toBe(0);
      expect(r.failedVisits).toBe(1);
      // The child is NOT flipped to confirmed, so a retry can still fix it.
      expect(ctx.writes.find((w) => w.path === 'families/3/bookings/b1/kinCares/v1')).toBeUndefined();
      // And the envelope refuses to claim it is done.
      expect(r.envelopeStatus).toBe('requested');
    });
  }

  it('one unreadable visit does not stop the readable ones in the same batch', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'bad', data: { startTime: null, endTime: '2026-07-01T11:00:00Z', kinIds: [], serviceType: 'walk' } },
          { id: 'good', data: { startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T11:00:00Z', kinIds: [], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_good')).toBeDefined();
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_bad')).toBeUndefined();
    expect(r.sessionsCreated).toBe(1);
    expect(r.failedVisits).toBe(1);
    expect(r.envelopeStatus).toBe('requested');
  });

  // A4 audit follow-up: writeAuditEntry used to hardcode status: 'SUCCESS'
  // for this shared APPROVE core regardless of failedVisits, so a series
  // where every visit failed (0 confirmed) was still recorded as SUCCESS.
  // Same defect shape as batchUpdateBookings, one level up (this core is
  // also reused by requestBooking's auto-confirm path).
  it('audits with status FAILURE, not SUCCESS, when every visit fails', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: null, endTime: '2026-07-01T11:00:00Z', kinIds: [], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(r.sessionsCreated).toBe(0);
    expect(r.failedVisits).toBe(1);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE_BOOKING_SERIES', status: 'FAILURE' }),
    );
  });

  it('audits with status FAILURE, not SUCCESS, on a partial failure', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'bad', data: { startTime: null, endTime: '2026-07-01T11:00:00Z', kinIds: [], serviceType: 'walk' } },
          { id: 'good', data: { startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T11:00:00Z', kinIds: [], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE_BOOKING_SERIES', status: 'FAILURE' }),
    );
  });

  // A busy import can land AFTER the request was submitted but BEFORE it is
  // approved, which is exactly why this is re-checked here and not trusted
  // from request time alone. Isolated per-visit, same as an unreadable
  // startTime above: no override surface at this stage.
  it('a visit that now conflicts with a GOOGLE_BUSY_IMPORT slot fails that visit only, like any other unusable one', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'busy', data: { startTime: '2026-07-01T10:15:00.000Z', endTime: '2026-07-01T10:45:00.000Z', kinIds: [], serviceType: 'walk' } },
          { id: 'clear', data: { startTime: '2026-07-02T10:00:00.000Z', endTime: '2026-07-02T11:00:00.000Z', kinIds: [], serviceType: 'walk' } },
        ],
        booking_time_slots: [
          { id: 'gbi-1', data: { date: '2026-07-01', startTime: '10:00', endTime: '11:00', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_clear')).toBeDefined();
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_busy')).toBeUndefined();
    // Not flipped to confirmed either, exactly like the unreadable-startTime case.
    expect(ctx.writes.find((w) => w.path === 'families/3/bookings/b1/kinCares/busy')).toBeUndefined();
    expect(r.sessionsCreated).toBe(1);
    expect(r.failedVisits).toBe(1);
    expect(r.envelopeStatus).toBe('requested');
  });
});

/**
 * #1098: an Overnight is requested as a NIGHT, and the operator sets its start
 * when approving. The approve core is where that time lands, so every refusal a
 * timed visit gets at request time has to run here instead, before anything is
 * written, and it has to THROW: an operator who is told "one visit failed" cannot
 * offer the busy override, and a half-approved request is worse than none.
 */
describe('approveBookingSeriesCore: visits awaiting a start time (#1098)', () => {
  const HOUR = 3_600_000;
  const NIGHT = '2026-10-09';
  const AT_21 = Date.parse(`${NIGHT}T21:00:00.000Z`);
  const pendingVisit = (over: Record<string, unknown> = {}) => ({
    id: 'v1',
    data: {
      status: 'requested',
      startTime: null,
      endTime: null,
      startTimePending: true,
      requestedDate: NIGHT,
      serviceId: 'Overnight',
      serviceName: 'Overnight',
      serviceType: 'Overnight',
      kinIds: [],
      ...over,
    },
  });

  function seed(opts: {
    visits?: Array<{ id: string; data: Record<string, unknown> }>;
    settings?: Record<string, unknown>;
    busy?: Array<{ id: string; data: Record<string, unknown> }>;
    sessions?: Array<{ id: string; data: Record<string, unknown> }>;
  } = {}) {
    return buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household', envelopeStatus: 'requested' },
        'business_settings/business_settings': {
          timeZone: 'UTC',
          serviceDurations: { Overnight: '720' },
          ...opts.settings,
        },
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': opts.visits ?? [pendingVisit()],
        booking_time_slots: opts.busy ?? [],
        kin_care_sessions: opts.sessions ?? [],
      },
    });
  }

  const sessionWrites = (ctx: ReturnType<typeof buildDbMock>) =>
    ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'));
  it('REFUSES the whole approval with failed-precondition naming the night when no time was set, and writes nothing', async () => {
    const ctx = seed({
      visits: [
        { id: 'v0', data: { status: 'requested', startTime: '2026-10-09T11:00:00Z', endTime: '2026-10-09T11:30:00Z', kinIds: [] } },
        pendingVisit(),
      ],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const err: any = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE',
    }).catch((e) => e);
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe('Set a start time for the Overnight on Fri, Oct 9 before approving.');
    // Not half-approved: the timed visit next to it did not get a session either.
    expect(sessionWrites(ctx)).toHaveLength(0);
    expect(ctx.writes.filter((w) => w.path.includes('/kinCares/'))).toHaveLength(0);
  });

  it('a time for a DIFFERENT visit id does not count as this night having one', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    await expect(
      approveBookingSeriesCore({
        kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE', startTimes: { other: AT_21 },
      }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('with a time on the right night: writes the visit time first, then a twelve-hour session', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE', startTimes: { v1: AT_21 },
    });
    expect(r).toMatchObject({ sessionsCreated: 1, failedVisits: 0, envelopeStatus: 'confirmed' });
    const visitWrites = ctx.writes.filter((w) => w.path === 'families/3/bookings/b1/kinCares/v1');
    const timed = visitWrites.find((w) => 'startTimePending' in w.data);
    expect(timed?.data.startTimePending).toBe(false);
    expect((timed?.data.startTime as any).toMillis()).toBe(AT_21);
    expect((timed?.data.endTime as any).toMillis()).toBe(AT_21 + 12 * HOUR);
    const session = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    expect(session?.data.startTime).toBe(new Date(AT_21).toISOString());
    expect(session?.data.endTime).toBe(new Date(AT_21 + 12 * HOUR).toISOString());
    expect(session?.data.serviceDurationMinutes).toBe(720);
    // The visit time is written BEFORE the session, like rescheduleBooking's household-first order.
    expect(ctx.writes.indexOf(timed!)).toBeLessThan(ctx.writes.indexOf(session!));
    // The envelope's instant rollups, null while the night had no time, now name it.
    const env = ctx.writes.find((w) => w.path === 'families/3/bookings/b1' && 'envelopeStatus' in w.data);
    expect((env?.data.firstStartTime as any).toMillis()).toBe(AT_21);
    expect((env?.data.lastStartTime as any).toMillis()).toBe(AT_21);
  });

  it('REFUSES a time that is not on the requested night, in the business zone', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    await expect(
      approveBookingSeriesCore({
        kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE', startTimes: { v1: AT_21 + 24 * HOUR },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('judges the night in the BUSINESS zone: 01:00 UTC on the 10th is 9 PM on the 9th in New York', async () => {
    const ctx = seed({ settings: { timeZone: 'America/New_York' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const nineInNewYork = Date.parse('2026-10-10T01:00:00.000Z');
    const r = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE', startTimes: { v1: nineInNewYork },
    });
    expect(r.sessionsCreated).toBe(1);
  });

  it('with NO zone in settings, reads the night in the default America/Chicago, not UTC (#1109)', async () => {
    const ctx = seed({ settings: { timeZone: undefined } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    // 7:30 PM CDT on the 9th is 00:30 UTC on the 10th: UTC would call it the wrong night.
    const sevenThirtyCentral = Date.parse('2026-10-10T00:30:00.000Z');
    const r = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE', startTimes: { v1: sevenThirtyCentral },
    });
    expect(r.sessionsCreated).toBe(1);
  });
  it('REFUSES when the KinCare has no known length, naming it', async () => {
    const ctx = seed({
      visits: [pendingVisit({ serviceId: 'Sleepover', serviceName: 'Sleepover', serviceType: 'Sleepover' })],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const err: any = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE', startTimes: { v1: AT_21 },
    }).catch((e) => e);
    expect(err.code).toBe('invalid-argument');
    expect(err.message).toContain('Sleepover');
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('REFUSES when a Google busy block lands in the later hours, and approves with overrideBusyConflict', async () => {
    const busy = [
      { id: 'gbi-late', data: { date: NIGHT, startTime: '23:00', endTime: '23:30', source: 'GOOGLE_BUSY_IMPORT' } },
    ];
    const ctx = seed({ busy });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const err: any = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE', startTimes: { v1: AT_21 },
    }).catch((e) => e);
    expect(err.code).toBe('failed-precondition');
    expect(err.details?.code).toBe('booking_busy_conflict');
    expect(sessionWrites(ctx)).toHaveLength(0);
    const ctx2 = seed({ busy });
    mocks.dbFn.mockReturnValue(ctx2.db);
    const r = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE',
      startTimes: { v1: AT_21 }, overrideBusyConflict: true,
    });
    expect(r).toMatchObject({ sessionsCreated: 1, failedVisits: 0 });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BOOKING_BUSY_CONFLICT_OVERRIDDEN' }),
    );
  });

  it('REFUSES when the night overlaps a visit already on the books, and approves with overrideVisitConflict', async () => {
    const sessions = [
      { id: 'vis_other', data: { status: 'SCHEDULED', startTime: '2026-10-09T22:00:00.000Z', endTime: '2026-10-09T23:00:00.000Z' } },
    ];
    const ctx = seed({ sessions });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const err: any = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE', startTimes: { v1: AT_21 },
    }).catch((e) => e);
    expect(err.code).toBe('failed-precondition');
    expect(err.details?.code).toBe('visit_overlap_conflict');
    expect(sessionWrites(ctx)).toHaveLength(0);
    const ctx2 = seed({ sessions });
    mocks.dbFn.mockReturnValue(ctx2.db);
    const r = await approveBookingSeriesCore({
      kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE',
      startTimes: { v1: AT_21 }, overrideVisitConflict: true,
    });
    expect(r.sessionsCreated).toBe(1);
  });

  it('REFUSES a night the operator has since closed, with no override', async () => {
    const ctx = seed({ settings: { companyHolidays: [`${NIGHT}|Staff retreat`] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    await expect(
      approveBookingSeriesCore({
        kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE',
        startTimes: { v1: AT_21 }, overrideBusyConflict: true, overrideVisitConflict: true,
      }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('leaves a visit that already has its time exactly as before (no settings read needed)', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T11:00:00Z', kinIds: [], startTimePending: false, requestedDate: null } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });
    expect(r.sessionsCreated).toBe(1);
    const visitWrites = ctx.writes.filter((w) => w.path === 'families/3/bookings/b1/kinCares/v1');
    expect(visitWrites.some((w) => 'startTimePending' in w.data)).toBe(false);
  });
});

describe('approveBookingSeriesCore: a cancelled night awaiting a start time (#1098)', () => {
  it('approves the rest of the request with no start times, and leaves the cancelled night alone', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household', envelopeStatus: 'requested' },
        'business_settings/business_settings': { timeZone: 'UTC', serviceDurations: { Overnight: '720' } },
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          {
            id: 'night',
            data: {
              status: 'cancelled', startTime: null, endTime: null, startTimePending: true,
              requestedDate: '2026-10-09', serviceId: 'Overnight', serviceName: 'Overnight', kinIds: [],
            },
          },
          {
            id: 'midday',
            data: {
              status: 'requested', startTime: '2026-10-09T11:00:00Z', endTime: '2026-10-09T11:30:00Z',
              startTimePending: false, requestedDate: null, serviceType: '30 Minute', kinIds: [],
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE' });

    expect(r).toMatchObject({ sessionsCreated: 1, failedVisits: 0, affectedVisits: 1, envelopeStatus: 'confirmed' });
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_midday')?.data.serviceDurationMinutes).toBe(30);
    // The cancelled night is not confirmed, not timed, and gets no session.
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_night')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'families/3/bookings/b1/kinCares/night')).toBeUndefined();
    const env = ctx.writes.find((w) => w.path === 'families/3/bookings/b1' && 'envelopeStatus' in w.data);
    expect(env?.data.confirmedCount).toBe(1);
  });
});
describe('approveBookingSeriesCore: visits the household cancelled (#1101)', () => {
  const live = { status: 'requested', startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T11:00:00Z', kinIds: [], serviceType: 'walk' };
  it('skips a cancelled timed visit next to a live one: no session, no flip, not counted', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household', envelopeStatus: 'requested' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'live', data: live },
          { id: 'gone', data: { ...live, status: 'cancelled', startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T11:00:00Z' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE' });
    expect(r).toMatchObject({ sessionsCreated: 1, failedVisits: 0, affectedVisits: 1, newlyConfirmed: 1, envelopeStatus: 'confirmed' });
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_live')).toBeDefined();
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_gone')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'families/3/bookings/b1/kinCares/gone')).toBeUndefined();
    const env = ctx.writes.find((w) => w.path === 'families/3/bookings/b1' && 'envelopeStatus' in w.data);
    expect(env?.data).toMatchObject({ envelopeStatus: 'confirmed', confirmedCount: 1, cancelledCount: 1 });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SUCCESS', payload: expect.objectContaining({ affectedVisits: 1, sessionsCreated: 1 }) }),
    );
  });
  it('treats an unavailable visit the same way', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'live', data: live },
          { id: 'off', data: { ...live, status: 'unavailable' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE' });
    expect(r.sessionsCreated).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_off')).toBeUndefined();
  });
  it('an envelope where every visit was cancelled ends cancelled, like CANCEL, with nothing booked or sent', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household', envelopeStatus: 'requested' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'a', data: { ...live, status: 'cancelled' } },
          { id: 'b', data: { ...live, status: 'cancelled', startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T11:00:00Z' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'admin', actorRole: 'AUNTIE' });
    expect(r).toMatchObject({ sessionsCreated: 0, failedVisits: 0, affectedVisits: 0, newlyConfirmed: 0, envelopeStatus: 'cancelled', householdNotified: false });
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'))).toHaveLength(0);
    const env = ctx.writes.find((w) => w.path === 'families/3/bookings/b1' && 'envelopeStatus' in w.data);
    expect(env?.data).toMatchObject({ envelopeStatus: 'cancelled', confirmedCount: 0, cancelledCount: 2 });
  });
});
