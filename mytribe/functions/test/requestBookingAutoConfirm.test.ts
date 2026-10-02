import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntryFn: vi.fn(),
  approveCore: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/admin/approveBookingSeriesCore', () => ({ approveBookingSeriesCore: mocks.approveCore }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset().mockResolvedValue('audit-id');
  mocks.approveCore.mockReset().mockResolvedValue({ found: true, affectedVisits: 1, sessionsCreated: 1, failedVisits: 0, envelopeStatus: 'confirmed' });
});

const futureTs = () => Date.now() + 60_000;

describe('requestBooking auto-confirm (#9)', () => {
  it('does NOT auto-confirm when the setting is off', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await requestBookingHandler({ data: { serviceType: 'walk', startTimeMs: futureTs(), kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(mocks.approveCore).not.toHaveBeenCalled();
  });

  it('does NOT auto-confirm a first-time kinfolk even when the setting is on', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { autoConfirmRepeatKinfolk: true },
      },
      // No prior bookings -> first-timer -> stays in the manual queue.
      queryDocs: { 'families/3/bookings': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await requestBookingHandler({ data: { serviceType: 'walk', startTimeMs: futureTs(), kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(mocks.approveCore).not.toHaveBeenCalled();
  });

  it('auto-confirms a repeat kinfolk when the setting is on', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { autoConfirmRepeatKinfolk: true },
      },
      // A prior booking envelope exists -> repeat kinfolk.
      queryDocs: { 'families/3/bookings': [{ id: 'old_batch', data: {} }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler({ data: { serviceType: 'walk', startTimeMs: futureTs(), kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(mocks.approveCore).toHaveBeenCalledTimes(1);
    expect(mocks.approveCore).toHaveBeenCalledWith(
      expect.objectContaining({ kinfolkId: '3', batchId: res.batchId, actorUid: 'u1', actorRole: 'SYSTEM' }),
    );
  });

  it('never throws when auto-confirm fails (falls back to the manual queue)', async () => {
    mocks.approveCore.mockRejectedValue(new Error('boom'));
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { autoConfirmRepeatKinfolk: true },
      },
      queryDocs: { 'families/3/bookings': [{ id: 'old_batch', data: {} }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler({ data: { serviceType: 'walk', startTimeMs: futureTs(), kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.batchId).toBeTypeOf('string'); // resolved despite auto-confirm error
  });
});

/**
 * #1098: a night awaiting its start time cannot be confirmed by anybody but the
 * operator, because confirming it IS setting that time. Auto-confirm leaves the
 * whole request in the manual queue, says so in a named log line, and still
 * confirms a repeat household's request that has no such night.
 */
describe('requestBooking auto-confirm with a night awaiting a start time (#1098)', () => {
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  function repeatHouseholdDb() {
    return buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': {
          autoConfirmRepeatKinfolk: true,
          timeZone: 'UTC',
          serviceRates: { '30Minute': '25', Overnight: '120' },
          serviceDurations: { Overnight: '720' },
          serviceStartTimeBooking: { Overnight: true },
        },
      },
      queryDocs: { 'families/3/bookings': [{ id: 'old_batch', data: {} }] },
    });
  }

  const multi = (visits: unknown[]) =>
    ({ data: { kinfolkId: '3', kinIds: ['k1'], visits }, auth: { uid: 'u1' } }) as any;
  it('skips auto-confirm and logs why when any visit awaits a start time', async () => {
    const ctx = repeatHouseholdDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { logEvent } = await import('../src/lib/logger');
    (logEvent as any).mockClear();
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(
      multi([
        { startTimeMs: futureTs(), serviceId: '30Minute', serviceName: '30 Minute' },
        { date: tomorrow(), serviceId: 'Overnight', serviceName: 'Overnight' },
      ]),
    );
    expect(mocks.approveCore).not.toHaveBeenCalled();
    const events = (logEvent as any).mock.calls.map((c: any[]) => c[0].event);
    expect(events).toContain('booking.autoConfirm.skipped.startTimePending');
    const envelope = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`);
    expect(envelope?.data.envelopeStatus).toBe('requested');
  });

  it('still auto-confirms the same household when no visit awaits a time', async () => {
    const ctx = repeatHouseholdDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await requestBookingHandler(multi([{ startTimeMs: futureTs(), serviceId: '30Minute', serviceName: '30 Minute' }]));
    expect(mocks.approveCore).toHaveBeenCalledTimes(1);
  });
});
