import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832: the visit-lifecycle callable over the REAL dispatcher.
 *
 * Every visit notification targets the visit, so the dispatcher can only tell a
 * re-arrival from a retry by the identity `dispatchVisitNotificationCore` hands
 * it. These cases drive the callable exactly as the clients do and count what
 * reaches the household: two arrivals with different stamped times both send,
 * a retry of one does not, and two reports for one visit both send.
 *
 * This is also the wiring test for the core's `dedupeKey`: drop it and every
 * notification for a visit collapses onto `booking:<visitId>`, and the
 * two-arrivals case delivers once.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveKinCareRefFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinCareRef', () => ({ resolveKinCareRef: mocks.resolveKinCareRefFn }));

import { dispatchVisitNotificationHandler } from '../src/admin/dispatchVisitNotification';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const VISIT_PATH = 'families/fam1/bookings/batch1/kinCares/visit1';

function tap(data: Record<string, unknown>) {
  return dispatchVisitNotificationHandler({
    data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', ...data },
    auth: { uid: 'uid_auntie', token: { name: 'TiTi' } },
  } as never);
}

function household(writes: Array<{ path: string; data: Record<string, unknown> }>, key: string) {
  return writes.filter(
    (w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk' && w.data.key === key,
  );
}

let ctx: ReturnType<typeof buildDbMock>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      [VISIT_PATH]: { serviceType: 'Dog Walk', scheduledAtMs: NOW, kinfolkId: 'fam1' },
      'families/fam1': { primaryUid: 'uid_kinfolk', displayName: 'The Rileys' },
      'clients/uid_kinfolk': { displayName: 'Dana' },
      'staff/uid_auntie': { displayName: 'TiTi' },
    },
  });
  mocks.dbFn.mockReset().mockReturnValue(ctx.db);
  mocks.resolveKinCareRefFn.mockReset().mockResolvedValue({
    ref: ctx.db.doc(VISIT_PATH),
    batchId: 'batch1',
    visitId: 'visit1',
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('dispatchVisitNotification names each lifecycle event (#832)', () => {
  it('two arrivals with different stamped times both reach the household; a retry of the first does not', async () => {
    const firstArrival = NOW - 60_000;
    await tap({ event: 'arrived', eventAtMs: firstArrival });
    // The arrival is undone and marked again two minutes later.
    vi.setSystemTime(NOW + 60_000);
    await tap({ event: 'arrived', eventAtMs: NOW + 60_000 });
    // A client retry of the first tap: same stamped time.
    vi.setSystemTime(NOW + 90_000);
    await tap({ event: 'arrived', eventAtMs: firstArrival });

    expect(household(ctx.writes, 'kincare.auntie.arrived')).toHaveLength(2);
  });

  it('a second departure after an undone one sends too', async () => {
    await tap({ event: 'departed', eventAtMs: NOW });
    vi.setSystemTime(NOW + 120_000);
    await tap({ event: 'departed', eventAtMs: NOW + 120_000 });

    expect(household(ctx.writes, 'kincare.auntie.departed')).toHaveLength(2);
  });

  it('two reports for one visit both send; a retry of one report does not', async () => {
    await tap({ event: 'report_sent', reportId: 'report-1' });
    vi.setSystemTime(NOW + 30_000);
    await tap({ event: 'report_sent', reportId: 'report-2' });
    vi.setSystemTime(NOW + 60_000);
    await tap({ event: 'report_sent', reportId: 'report-1' });

    // kincare.report.sent is a retired alias; the catalog writes the canonical key.
    const reports = ctx.writes.filter(
      (w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk',
    );
    expect(reports).toHaveLength(2);
  });

  it('different steps of one visit never collide with each other', async () => {
    await tap({ event: 'on_my_way', etaMinutes: 10, eventAtMs: NOW });
    await tap({ event: 'arrived', eventAtMs: NOW });
    await tap({ event: 'departed', eventAtMs: NOW });

    expect(household(ctx.writes, 'kincare.auntie.on_my_way')).toHaveLength(1);
    expect(household(ctx.writes, 'kincare.auntie.arrived')).toHaveLength(1);
    expect(household(ctx.writes, 'kincare.auntie.departed')).toHaveLength(1);
  });
});
