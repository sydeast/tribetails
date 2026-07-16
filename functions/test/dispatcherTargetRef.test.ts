import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

import { enqueueNotification } from '../src/notifications/dispatcher';

/**
 * Task 1 persistence tests: the dispatcher must stamp targetType + targetId on
 * the notification doc so the client can open-link + offer quick approve/deny.
 * Uses kincare.auntie.on_my_way (single-audience kinfolk, trigger mode) so each
 * dispatch writes exactly one notifications doc.
 */
function notifWrite(writes: Array<{ path: string; data: Record<string, unknown> }>) {
  return writes.find((w) => w.path.startsWith('notifications/'));
}

describe('dispatcher target-ref persistence', () => {
  it('uses explicit args.targetType/targetId when provided', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      data: { invoiceId: 'should-be-ignored' },
      targetType: 'booking',
      targetId: 'b-explicit',
    });
    const doc = notifWrite(ctx.writes);
    expect(doc?.data.targetType).toBe('booking');
    expect(doc?.data.targetId).toBe('b-explicit');
  });

  it('derives invoice target from data.invoiceId when args omitted', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      data: { invoiceId: 'inv-9', kinfolkId: 'kf-1' },
    });
    const doc = notifWrite(ctx.writes);
    expect(doc?.data.targetType).toBe('invoice');
    expect(doc?.data.targetId).toBe('inv-9');
  });

  it('derives kintale target from data.taleId/reportId', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      data: { reportId: 'tale-3', kinfolkId: 'kf-1' },
    });
    const doc = notifWrite(ctx.writes);
    expect(doc?.data.targetType).toBe('kintale');
    expect(doc?.data.targetId).toBe('tale-3');
  });

  it('derives booking target from data.visitId/bookingId', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      data: { visitId: 'v-2', kinfolkId: 'kf-1' },
    });
    const doc = notifWrite(ctx.writes);
    expect(doc?.data.targetType).toBe('booking');
    expect(doc?.data.targetId).toBe('v-2');
  });

  it('falls back to kinfolk target when only kinfolkId/familyId present', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf-7' },
    });
    const doc = notifWrite(ctx.writes);
    expect(doc?.data.targetType).toBe('kinfolk');
    expect(doc?.data.targetId).toBe('kf-7');
  });

  it('defaults to empty target when nothing resolvable (additive, never throws)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      data: {},
    });
    const doc = notifWrite(ctx.writes);
    expect(doc?.data.targetType).toBe('');
    expect(doc?.data.targetId).toBe('');
  });
});
