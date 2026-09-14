import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832: WIRING. `onBookingsWrite` must hand the dispatcher the identity of each
 * event it announces. The identity helpers are tested on their own elsewhere;
 * this drives the real trigger and asserts what reaches `enqueueNotification`,
 * so a call site that stops passing the identity fails here (the review found
 * that dropping `kincare.changed`'s identity passed every other test).
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), enqueue: vi.fn(), resolveKinfolkUid: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/notifications/dispatcher', async () => {
  const actual = await vi.importActual<typeof import('../src/notifications/dispatcher')>('../src/notifications/dispatcher');
  return { contentDedupeKey: actual.contentDedupeKey, enqueueNotification: mocks.enqueue };
});
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { onBookingsWrite, rescheduleDedupeKey } from '../src/triggers/onBookingsWrite';

const SEP4 = Date.parse('2026-09-04T16:00:00Z');
const start = { toMillis: () => SEP4 };

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.resolveKinfolkUid.mockReset().mockResolvedValue('uid-kinfolk');
  mocks.dbFn.mockReset().mockReturnValue(
    buildDbMock({ docs: { 'business_settings/business_settings': { timeZone: 'America/New_York' } } }).db,
  );
});

async function write(eventId: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  await onBookingsWrite.run({
    id: eventId,
    params: { kinfolkId: 'fam1', batchId: 'req_1', visitId: 'v1' },
    data: {
      before: { data: () => before, exists: true },
      after: { data: () => after, exists: true },
    },
  } as never);
}

function sent(key: string): Array<{ dedupeKey?: string }> {
  return mocks.enqueue.mock.calls.map((c) => c[0]).filter((a: { key: string }) => a.key === key);
}

describe('onBookingsWrite passes each event its identity (#832)', () => {
  it('kincare.changed is named by the write event, so A, B, back to A are three identities', async () => {
    await write('evt-1', { status: 'confirmed', startTime: start, notes: 'a' }, { status: 'confirmed', startTime: start, notes: 'b' });
    await write('evt-2', { status: 'confirmed', startTime: start, notes: 'b' }, { status: 'confirmed', startTime: start, notes: 'a' });
    await write('evt-3', { status: 'confirmed', startTime: start, notes: 'a' }, { status: 'confirmed', startTime: start, notes: 'b' });

    expect(sent('kincare.changed').map((a) => a.dedupeKey)).toEqual([
      'booking:v1:kincare.changed:event:evt-1',
      'booking:v1:kincare.changed:event:evt-2',
      'booking:v1:kincare.changed:event:evt-3',
    ]);
  });

  it('kincare.reschedule.requested is named by the ask', async () => {
    const after = {
      status: 'confirmed',
      startTime: start,
      rescheduleRequestedAt: { toMillis: () => SEP4 - 3600_000 },
      rescheduleRequestedStartTime: { toMillis: () => SEP4 + 86_400_000 },
      rescheduleRequestReason: 'vet visit',
      rescheduleRequestStatus: 'pending',
    };
    await write('evt-9', { status: 'confirmed', startTime: start }, after);

    const asks = sent('kincare.reschedule.requested');
    expect(asks).toHaveLength(1);
    expect(asks[0].dedupeKey).toBe(rescheduleDedupeKey('v1', after));
  });

  it('a status transition (confirm) is named by the write event', async () => {
    await write('evt-7', { status: 'requested', startTime: start }, { status: 'confirmed', startTime: start });

    expect(sent('kincare.booking.confirm').map((a) => a.dedupeKey)).toEqual([
      'booking:v1:kincare.booking.confirm:event:evt-7',
    ]);
  });

  it('a cancellation is named by the write event', async () => {
    await write('evt-8', { status: 'confirmed', startTime: start }, { status: 'cancelled', startTime: start });

    expect(sent('kincare.booking.cancel').map((a) => a.dedupeKey)).toEqual([
      'booking:v1:kincare.booking.cancel:event:evt-8',
    ]);
  });
});
