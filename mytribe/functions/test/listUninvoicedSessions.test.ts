import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { listUninvoicedSessionsHandler } from '../src/admin/listUninvoicedSessions';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';

beforeEach(() => mocks.dbFn.mockReset());

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function session(id: string, data: Record<string, unknown>) {
  return { id, data: { kinfolkId: 'fam1', startTime: '2026-07-10T14:00:00Z', ...data } };
}

/**
 * `null` means "the settings doc has no rate card", NOT `undefined`. A default
 * parameter fires on an explicit `undefined` too, so `seed(x, undefined)` would
 * silently seed the default card and the missing-card test would assert against
 * a setup it never actually got.
 */
function seed(
  sessions: Array<{ id: string; data: Record<string, unknown> }>,
  serviceRates: Record<string, unknown> | null = { dogWalking30: '25.00' },
) {
  return buildDbMock({
    docs: { 'business_settings/business_settings': serviceRates ? { serviceRates } : {} },
    queryDocs: { kin_care_sessions: sessions },
  });
}

const RANGE = { from: '2026-07-01', to: '2026-07-31' };

describe('listUninvoicedSessions selection', () => {
  it('returns a completed session that has no invoice', async () => {
    const ctx = seed([session('s1', { status: 'COMPLETED', serviceType: 'dogWalking30' })]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listUninvoicedSessionsHandler(req(RANGE));
    expect(res.sessions).toHaveLength(1);
    expect(res.sessions[0]!.sessionId).toBe('s1');
  });

  it('EXCLUDES a session whose invoiceId is set', async () => {
    const ctx = seed([session('s1', { status: 'COMPLETED', invoiceId: 'inv1' })]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listUninvoicedSessionsHandler(req(RANGE))).sessions).toHaveLength(0);
  });

  it('INCLUDES a session whose invoiceId field is ABSENT, not merely empty', async () => {
    // THE TRAP. `where('invoiceId','==','')` would miss every session written by
    // createKinCareSession or approveBookingSeriesCore, because neither writes
    // the field at all and Firestore equality skips documents that lack it. The
    // filter is therefore applied in memory, over the loaded page.
    const ctx = seed([
      session('absent', { status: 'COMPLETED' }),
      session('blank', { status: 'COMPLETED', invoiceId: '' }),
      session('whitespace', { status: 'COMPLETED', invoiceId: '   ' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = (await listUninvoicedSessionsHandler(req(RANGE))).sessions.map((s) => s.sessionId);
    expect(ids).toEqual(['absent', 'blank', 'whitespace']);
  });

  it('EXCLUDES a session that is not completed', async () => {
    const ctx = seed([
      session('s1', { status: 'SCHEDULED' }),
      session('s2', { status: 'CANCELLED' }),
      session('s3', { status: 'IN_PROGRESS' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listUninvoicedSessionsHandler(req(RANGE))).sessions).toHaveLength(0);
  });

  it('normalizes status casing and whitespace', async () => {
    // createKinCareSession writes 'SCHEDULED' uppercase, but nothing validates
    // the field, so a completed visit can arrive as 'completed' or ' Completed '.
    const ctx = seed([
      session('a', { status: 'completed' }),
      session('b', { status: ' Completed ' }),
      session('c', { status: 'COMPLETED' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listUninvoicedSessionsHandler(req(RANGE))).sessions).toHaveLength(3);
  });

  it('excludes a session with no readable status rather than assuming it is done', async () => {
    const ctx = seed([session('s1', {}), session('s2', { status: 42 })]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listUninvoicedSessionsHandler(req(RANGE))).sessions).toHaveLength(0);
  });
});

describe('listUninvoicedSessions rate-card prefill', () => {
  it('prices a session from business_settings.serviceRates, in CENTS', async () => {
    const ctx = seed([session('s1', { status: 'COMPLETED', serviceType: 'dogWalking30' })], {
      dogWalking30: '25.00',
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listUninvoicedSessionsHandler(req(RANGE));
    // serviceRates is dollars-as-STRING; the prefill is integer cents, because
    // that is what a line item stores.
    expect(res.sessions[0]!.unitCents).toBe(2500);
    expect(res.unpriceable).toHaveLength(0);
  });

  it('does NOT default an unmatched serviceType to zero: it reports it unpriceable', async () => {
    // Never fabricate a number for a failed read. A silent 0 here would bill a
    // household nothing for real work and look deliberate.
    const ctx = seed([session('s1', { status: 'COMPLETED', serviceType: 'catSitting' })], {
      dogWalking30: '25.00',
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listUninvoicedSessionsHandler(req(RANGE));
    expect(res.sessions[0]!.unitCents).toBeNull();
    expect(res.unpriceable).toEqual([{ sessionId: 's1', serviceType: 'catSitting' }]);
  });

  it('treats an unparseable or non-positive rate as unpriceable, not as zero', async () => {
    const ctx = seed(
      [
        session('a', { status: 'COMPLETED', serviceType: 'weird' }),
        session('b', { status: 'COMPLETED', serviceType: 'free' }),
      ],
      { weird: 'ask me', free: '0' },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listUninvoicedSessionsHandler(req(RANGE));
    expect(res.sessions.every((s) => s.unitCents === null)).toBe(true);
    expect(res.unpriceable).toHaveLength(2);
  });

  it('reports every session unpriceable when the rate card is missing entirely', async () => {
    const ctx = seed([session('s1', { status: 'COMPLETED', serviceType: 'dogWalking30' })], null);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listUninvoicedSessionsHandler(req(RANGE));
    expect(res.sessions[0]!.unitCents).toBeNull();
    expect(res.rateCardLoaded).toBe(false);
  });

  it('says the rate card DID load when it is present, so a miss is a real miss', async () => {
    const ctx = seed([session('s1', { status: 'COMPLETED', serviceType: 'dogWalking30' })]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listUninvoicedSessionsHandler(req(RANGE))).rateCardLoaded).toBe(true);
  });
});

describe('listUninvoicedSessions honesty about its own page', () => {
  it('reports how many rows it scanned, so an empty result is distinguishable from a truncated one', async () => {
    const ctx = seed([
      session('s1', { status: 'COMPLETED' }),
      session('s2', { status: 'SCHEDULED' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listUninvoicedSessionsHandler(req(RANGE));
    expect(res.scanned).toBe(2);
    expect(res.sessions).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  it('carries the fields a line item needs', async () => {
    const ctx = seed([
      session('s1', {
        status: 'COMPLETED',
        serviceType: 'dogWalking30',
        serviceDurationMinutes: 30,
        startTime: '2026-07-10T14:00:00Z',
      }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const s = (await listUninvoicedSessionsHandler(req(RANGE))).sessions[0]!;
    expect(s).toMatchObject({
      sessionId: 's1',
      kinfolkId: 'fam1',
      serviceType: 'dogWalking30',
      durationMinutes: 30,
      startTime: '2026-07-10T14:00:00Z',
    });
  });
});

describe('listUninvoicedSessions argument + auth failures', () => {
  it('rejects a missing or malformed date range', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(listUninvoicedSessionsHandler(req({ to: '2026-07-31' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(
      listUninvoicedSessionsHandler(req({ from: '07/01/2026', to: '2026-07-31' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a range whose end precedes its start', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      listUninvoicedSessionsHandler(req({ from: '2026-07-31', to: '2026-07-01' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('is unauthenticated with no caller and permission-denied for a non-admin', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(listUninvoicedSessionsHandler(req(RANGE, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });

    const guarded = wrapAdminCallable('listUninvoicedSessions', listUninvoicedSessionsHandler);
    await expect(
      guarded({ data: RANGE, auth: { uid: 'kinfolk-9', token: {} } } as unknown as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
