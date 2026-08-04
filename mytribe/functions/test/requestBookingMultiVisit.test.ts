import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
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

describe('requestBookingHandler — multi-visit envelope', () => {
  it('default-assigns every new visit to the admin (2026-07-02 assignment feature)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'base_services/s1': { name: "Auntie's In", priceCents: 1500 },
        'businessSettings/admins': { uids: ['admin1'] },
        'staff/admin1': { displayName: 'Auntie Dee' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        visits: [{ startTimeMs: future, endTimeMs: future + 30 * 60_000, serviceId: 's1', serviceName: "Auntie's In" }],
      },
      auth: { uid: 'u1' },
    } as any);
    const visit = ctx.writes.find((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    );
    expect(visit?.data?.assignedAuntieUid).toBe('admin1');
    expect(visit?.data?.auntieDisplayName).toBe('Auntie Dee');
  });

  it('creates unassigned visits when no admins doc exists (never blocks a booking)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'base_services/s1': { name: "Auntie's In", priceCents: 1500 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        visits: [{ startTimeMs: future, endTimeMs: future + 30 * 60_000, serviceId: 's1', serviceName: "Auntie's In" }],
      },
      auth: { uid: 'u1' },
    } as any);
    const visit = ctx.writes.find((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    );
    expect(visit?.data?.assignedAuntieUid).toBeNull();
    expect(visit?.data?.auntieDisplayName).toBeNull();
  });

  it('accepts visits[] payload + creates ONE parent envelope + one kinCare per visit in a transaction', async () => {
    // NOTE-56: seed the canonical catalog so serviceName + priceCents resolve
    // server-side (client-supplied price is ignored).
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'base_services/s1': { name: "Auntie's In", priceCents: 1500 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1', 'k2'],
        notes: 'park preferred',
        pattern: 'individual',
        visits: [
          {
            startTimeMs: future,
            endTimeMs: future + 30 * 60_000,
            serviceId: 's1',
            serviceName: "Auntie's In",
            priceCents: 1500,
          },
          {
            startTimeMs: future + 86400_000,
            endTimeMs: future + 86400_000 + 30 * 60_000,
            serviceId: 's1',
            serviceName: "Auntie's In",
            priceCents: 1500,
          },
        ],
      },
      auth: { uid: 'u1' },
    } as any);

    // Envelope id is returned; bookingIds is the single-element [batchId].
    expect(res.batchId).toBeTypeOf('string');
    expect(res.bookingIds).toEqual([res.batchId]);

    // One transaction wrote 1 parent + 2 kinCares (no `.add()` loop anymore).
    expect(ctx.adds).toHaveLength(0);
    const parentWrites = ctx.writes.filter((w) => w.path === `families/3/bookings/${res.batchId}`);
    const visitWrites = ctx.writes.filter((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    );
    expect(parentWrites).toHaveLength(1);
    expect(visitWrites).toHaveLength(2);

    const parent = parentWrites[0].data;
    expect(parent.envelopeStatus).toBe('requested');
    expect(parent.pattern).toBe('individual');
    expect(parent.visitCount).toBe(2);
    expect(parent.kinIds).toEqual(['k1', 'k2']);
    expect(parent.notes).toBe('park preferred');
    // Homogeneous service → rolled onto the envelope.
    expect(parent.serviceId).toBe('s1');
    expect(parent.serviceName).toBe("Auntie's In");
    // first/last derived from min/max visit start.
    expect((parent.firstStartTime as Timestamp).toMillis()).toBe(future);
    expect((parent.lastStartTime as Timestamp).toMillis()).toBe(future + 86400_000);

    // serviceName + priceCents persisted on every visit doc.
    expect(visitWrites[0].data.serviceName).toBe("Auntie's In");
    expect(visitWrites[0].data.priceCents).toBe(1500);
    expect(visitWrites[0].data.kinIds).toEqual(['k1', 'k2']);
    expect(visitWrites[0].data.status).toBe('requested');
    expect(visitWrites[0].data.batchId).toBe(res.batchId);
  });

  it('NOTE-56: ignores a client-supplied bogus priceCents, using the canonical catalog price', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        // Canonical price is 1500; client will lie and send 1.
        'base_services/s1': { name: 'Drop-in Visit', priceCents: 1500 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        visits: [
          { startTimeMs: future, serviceId: 's1', serviceName: 'Anything I Want', priceCents: 1 },
        ],
      },
      auth: { uid: 'u1' },
    } as any);

    const visit = ctx.writes.find((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    )!.data;
    // Server-resolved values win over the client's claims.
    expect(visit.priceCents).toBe(1500);
    expect(visit.priceCents).not.toBe(1);
    expect(visit.serviceName).toBe('Drop-in Visit');
  });

  it('NOTE-56: drops the client priceCents (null) when the serviceId is not in the catalog', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        visits: [
          { startTimeMs: future, serviceId: 'unknown-svc', serviceName: 'Mystery', priceCents: 99999 },
        ],
      },
      auth: { uid: 'u1' },
    } as any);

    const visit = ctx.writes.find((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    )!.data;
    // Unknown service -> never persist the client price; resolve at invoice time.
    expect(visit.priceCents).toBeNull();
    // Display label falls back to the client name when the catalog has no entry.
    expect(visit.serviceName).toBe('Mystery');
  });

  it('rolls envelope serviceId/serviceName to null when visits are heterogeneous', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        visits: [
          { startTimeMs: future, serviceId: 's1', serviceName: 'Walk', priceCents: 100 },
          { startTimeMs: future + 60_000, serviceId: 's2', serviceName: 'Feed', priceCents: 200 },
        ],
      },
      auth: { uid: 'u1' },
    } as any);
    const parent = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`)!.data;
    expect(parent.serviceId).toBeNull();
    expect(parent.serviceName).toBeNull();
    expect(parent.visitCount).toBe(2);
  });

  it('rejects visits[] with past startTime', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const past = Date.now() - 86400_000;
    await expect(
      requestBookingHandler({
        data: {
          kinfolkId: '3',
          visits: [
            { startTimeMs: past, serviceId: 's1', serviceName: 'X', priceCents: 100 },
          ],
        },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects empty visits[] when using new shape', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', visits: [] },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toThrow();
  });

  it('resolves real kin names onto the envelope AND every visit (not kinNames: [])', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/kin/k1': { name: 'Fido' },
        'families/3/kin/k2': { name: 'Whiskers' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1', 'k2'],
        pattern: 'individual',
        visits: [{ startTimeMs: future, serviceId: 's1', serviceName: 'Walk', priceCents: 100 }],
      },
      auth: { uid: 'u1' },
    } as any);

    const parent = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`)!.data;
    const visit = ctx.writes.find((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    )!.data;
    expect(parent.kinNames).toEqual(['Fido', 'Whiskers']);
    expect(visit.kinNames).toEqual(['Fido', 'Whiskers']);
  });

  it('tolerates a missing kin doc: resolves the ones that exist, drops the rest, never fails the booking', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/kin/k1': { name: 'Fido' },
        // k2 has no doc: deleted kin, or a stale id from the client.
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1', 'k2'],
        pattern: 'individual',
        visits: [{ startTimeMs: future, serviceId: 's1', serviceName: 'Walk', priceCents: 100 }],
      },
      auth: { uid: 'u1' },
    } as any);

    const parent = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`)!.data;
    // kinIds still carries both (nothing here about a missing pet), only
    // kinNames narrows to what actually resolved.
    expect(parent.kinIds).toEqual(['k1', 'k2']);
    expect(parent.kinNames).toEqual(['Fido']);
  });

  it('legacy single-visit shape still works (backward compat)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: { kinfolkId: '3', serviceType: 'walk', startTimeMs: future },
      auth: { uid: 'u1' },
    } as any);
    expect(res.bookingId ?? res.bookingIds?.[0]).toBeDefined();
    expect(res.batchId).toBeDefined();
  });
});
/**
 * The portal half of the wizard fields. `createMultiDateBookingRequest.test.ts`
 * covers the admin callable; these pin that the SAME schema additions reached
 * the kinfolk-facing one, because both write through the same `writeEnvelope`
 * and a field one accepts and the other rejects would mean a booking a
 * household can file and an operator cannot.
 */
describe('requestBookingHandler wizard fields', () => {
  function portalDb() {
    return buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'base_services/s1': { name: "Auntie's In", priceCents: 1500 },
      },
    });
  }
  /**
   * NO ADDRESS ON A BOOKING (operator ruling, 2026-08-04). The visit doc used
   * to carry a free-text `location`; addresses come from the household doc and
   * nowhere else. `MultiArgs` is not `.strict()`, so a cached portal bundle
   * that still sends the key has it stripped and its request still writes --
   * asserted here, because refusing it would break every unreloaded browser.
   */
  it('persists booking-level billing and communication, and drops a location an old client sends', async () => {
    const ctx = portalDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        billing: { mode: 'new-invoice' },
        communication: { emailConfirmation: true, timeVisibility: false },
        visits: [
          { startTimeMs: future, serviceId: 's1', serviceName: "Auntie's In", location: 'Side door' },
        ],
      },
      auth: { uid: 'u1' },
    } as any);
    const envelope = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`);
    expect(envelope?.data?.billing).toEqual({ mode: 'new-invoice' });
    expect(envelope?.data?.communication).toEqual({
      emailConfirmation: true,
      timeVisibility: false,
    });
    const visit = ctx.writes.find((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    );
    expect(visit?.data).not.toHaveProperty('location');
    expect(envelope?.data).not.toHaveProperty('location');
  });
  it('a payload with none of the new fields still writes, with both toggles off', async () => {
    const ctx = portalDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        visits: [{ startTimeMs: future, serviceId: 's1', serviceName: "Auntie's In" }],
      },
      auth: { uid: 'u1' },
    } as any);
    const envelope = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`);
    expect(envelope?.data?.billing).toBeNull();
    expect(envelope?.data?.communication).toEqual({
      emailConfirmation: false,
      timeVisibility: false,
    });
  });
  it('the LEGACY single-visit payload still writes its 1-visit envelope unchanged', async () => {
    const ctx = portalDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const future = Date.now() + 86400_000;
    const res: any = await requestBookingHandler({
      data: { kinfolkId: '3', serviceType: 'Dog Walk', startTimeMs: future },
      auth: { uid: 'u1' },
    } as any);
    const envelope = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`);
    expect(envelope?.data?.visitCount).toBe(1);
    expect(envelope?.data?.billing).toBeNull();
    expect(envelope?.data?.communication).toEqual({
      emailConfirmation: false,
      timeVisibility: false,
    });
    const visit = ctx.writes.find((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    );
    expect(visit?.data).not.toHaveProperty('location');
  });
});
