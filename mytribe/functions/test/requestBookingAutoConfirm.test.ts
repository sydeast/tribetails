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
