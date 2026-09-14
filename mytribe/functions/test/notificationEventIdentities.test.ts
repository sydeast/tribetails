import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832: every emitter that sends several REAL events for one target names each
 * event, so the dispatcher keeps them apart while still deduping a retry.
 *
 * Each case sends, through the REAL dispatcher on one write-through mock, event
 * A, then a distinct event B, then an exact retry of A, all inside the dedupe
 * window, and asserts two deliveries. The keys come from the emitters' own
 * exported helpers (or the exact string the emitter builds), so this tests what
 * ships rather than a restatement of it.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { Timestamp } from 'firebase-admin/firestore';
import {
  DEDUPE_COLLECTION,
  DEDUPE_LEDGER_RETENTION_MS,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  enqueueNotification,
} from '../src/notifications/dispatcher';
import { bookingEventDedupeKey, changeDedupeKey, rescheduleDedupeKey } from '../src/triggers/onBookingsWrite';
import { visitDedupeKey } from '../src/admin/dispatchVisitNotification';
import { kinTaleNoteDedupeKey } from '../src/triggers/onKinTaleUpdate';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);

beforeEach(() => {
  mocks.dbFn.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Send = { key: string; recipientUid?: string; data: Record<string, unknown>; dedupeKey?: string; fireAtMs?: number };

/** A, then distinct B, then a retry of A, 30s apart. Returns deliveries to `countFor`. */
async function aThenBThenRetryA(a: Send, b: Send, countFor: string): Promise<number> {
  const ctx = buildDbMock({ writeThrough: true, docs: { 'businessSettings/admins': { uids: ['admin1'] } } });
  mocks.dbFn.mockReturnValue(ctx.db);
  await enqueueNotification(a);
  vi.setSystemTime(NOW + 30_000);
  await enqueueNotification(b);
  vi.setSystemTime(NOW + 60_000);
  await enqueueNotification(a);
  expect(NOW + 60_000 - NOW).toBeLessThan(NOTIFICATION_DEDUPE_WINDOW_MS);
  return ctx.writes.filter(
    (w) =>
      (w.path.startsWith('notifications/') || w.path.startsWith('scheduledNotifications/')) &&
      w.data.key === a.key &&
      w.data.recipientUid === countFor,
  ).length;
}

const visit = { kinfolkId: 'fam1', batchId: 'b1', bookingId: 'v1', visitId: 'v1' };

describe('kincare.changed (onBookingsWrite): named by what changed and to what', () => {
  it('two different edits both send; a replay of the first does not', async () => {
    const a = changeDedupeKey('v1', { startTime: Timestamp.fromMillis(NOW + 86_400_000) }, ['startTime']);
    const b = changeDedupeKey('v1', { startTime: Timestamp.fromMillis(NOW + 2 * 86_400_000) }, ['startTime']);
    expect(a).not.toBe(b);
    expect(changeDedupeKey('v1', { startTime: Timestamp.fromMillis(NOW + 86_400_000) }, ['startTime'])).toBe(a);
    const data = { ...visit, changedFields: ['startTime'] };
    const sent = await aThenBThenRetryA(
      { key: 'kincare.changed', recipientUid: 'kinUid', data, dedupeKey: a },
      { key: 'kincare.changed', recipientUid: 'kinUid', data, dedupeKey: b },
      'kinUid',
    );
    expect(sent).toBe(2);
  });

  it('the same values reached through a different field set is a different change', () => {
    const one = changeDedupeKey('v1', { notes: 'x', title: 'y' }, ['notes']);
    const two = changeDedupeKey('v1', { notes: 'x', title: 'y' }, ['notes', 'title']);
    expect(one).not.toBe(two);
  });
});

describe('kincare.reschedule.requested (onBookingsWrite): named by the ask', () => {
  it('a re-request after a decline sends; a replay of the first ask does not', async () => {
    const first = { rescheduleRequestedAt: Timestamp.fromMillis(NOW - 3600_000), rescheduleRequestedStartTime: Timestamp.fromMillis(NOW + 86_400_000), rescheduleRequestReason: 'vet' };
    const again = { rescheduleRequestedAt: Timestamp.fromMillis(NOW), rescheduleRequestedStartTime: Timestamp.fromMillis(NOW + 86_400_000), rescheduleRequestReason: 'vet' };
    const a = rescheduleDedupeKey('v1', first);
    const b = rescheduleDedupeKey('v1', again);
    expect(a).not.toBe(b);
    const sent = await aThenBThenRetryA(
      { key: 'kincare.reschedule.requested', recipientUid: 'kinUid', data: visit, dedupeKey: a },
      { key: 'kincare.reschedule.requested', recipientUid: 'kinUid', data: visit, dedupeKey: b },
      'admin1',
    );
    expect(sent).toBe(2);
  });
});

describe('kincare.auntie.* (dispatchVisitNotification): named by the step, ETA and time', () => {
  it('a second "on my way" with a new ETA sends; a retry of the first does not', async () => {
    const a = visitDedupeKey('v1', { event: 'on_my_way', etaMinutes: 15 });
    const b = visitDedupeKey('v1', { event: 'on_my_way', etaMinutes: 5 });
    const sent = await aThenBThenRetryA(
      { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: visit, dedupeKey: a },
      { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: visit, dedupeKey: b },
      'kinUid',
    );
    expect(sent).toBe(2);
  });

  it('an arrival after an undone arrival sends when the step time differs', async () => {
    const a = visitDedupeKey('v1', { event: 'arrived', eventAtMs: NOW - 120_000 });
    const b = visitDedupeKey('v1', { event: 'arrived', eventAtMs: NOW });
    const sent = await aThenBThenRetryA(
      { key: 'kincare.auntie.arrived', recipientUid: 'kinUid', data: visit, dedupeKey: a },
      { key: 'kincare.auntie.arrived', recipientUid: 'kinUid', data: visit, dedupeKey: b },
      'kinUid',
    );
    expect(sent).toBe(2);
  });

  it('different steps of one visit never share a key', () => {
    expect(visitDedupeKey('v1', { event: 'arrived' })).not.toBe(visitDedupeKey('v1', { event: 'departed' }));
  });
});

describe('kintale.note.added (onKinTaleUpdate): named by the note content', () => {
  it('a second note sends; a replay does not; two notes of equal length are still two', async () => {
    const a = kinTaleNoteDedupeKey('r1', 'Fed at noon.', []);
    const b = kinTaleNoteDedupeKey('r1', 'Walk at one.', []);
    expect('Fed at noon.'.length).toBe('Walk at one.'.length);
    expect(a).not.toBe(b);
    expect(kinTaleNoteDedupeKey('r1', 'Fed at noon.', ['m2', 'm1'])).toBe(kinTaleNoteDedupeKey('r1', 'Fed at noon.', ['m1', 'm2']));
    const data = { kinfolkId: 'fam1', taleId: 'r1' };
    const sent = await aThenBThenRetryA(
      { key: 'kintale.note.added', recipientUid: 'kinUid', data, dedupeKey: a },
      { key: 'kintale.note.added', recipientUid: 'kinUid', data, dedupeKey: b },
      'kinUid',
    );
    expect(sent).toBe(2);
  });
});

describe('invoice.receipt (generateReceipt): named by the receipt version', () => {
  it('a re-issued receipt sends; a retry of the first version does not', async () => {
    const data = { kinfolkId: 'fam1', invoiceId: 'inv1' };
    const sent = await aThenBThenRetryA(
      { key: 'invoice.receipt', recipientUid: 'kinUid', data, dedupeKey: 'invoice:inv1:receipt:1' },
      { key: 'invoice.receipt', recipientUid: 'kinUid', data, dedupeKey: 'invoice:inv1:receipt:2' },
      'kinUid',
    );
    expect(sent).toBe(2);
  });
});

describe('status transitions (onBookingsWrite, onFamilyKinWrite): named by the Firestore event', () => {
  it('confirm, undo, re-confirm inside the window is two confirmations; a redelivery of the first is not', async () => {
    const a = bookingEventDedupeKey('v1', 'kincare.booking.confirm', 'evt-1');
    const b = bookingEventDedupeKey('v1', 'kincare.booking.confirm', 'evt-3');
    const sent = await aThenBThenRetryA(
      { key: 'kincare.booking.confirm', recipientUid: 'kinUid', data: visit, dedupeKey: a },
      { key: 'kincare.booking.confirm', recipientUid: 'kinUid', data: visit, dedupeKey: b },
      'kinUid',
    );
    expect(sent).toBe(2);
  });

  it('with no event id the helper yields nothing, and the dispatcher falls back to the target', () => {
    expect(bookingEventDedupeKey('v1', 'kincare.booking.cancel', undefined)).toBeUndefined();
  });
});

describe('marketing blasts and series approvals: named by the blast and the approval claim', () => {
  it('the blast key overrides an id in caller-shaped data that would otherwise collapse two blasts', async () => {
    // Marketing keys are opt-in, so their channels are off for a recipient with
    // no prefs doc and nothing would be written at all. The identity mechanism
    // under test is key-independent: `data` shared by both blasts carries a
    // `messageId`, which EVENT_ID_FIELDS ranks ahead of `blastId`, so without
    // the explicit key both would derive the same identity.
    const data = { audienceUid: 'kinUid', messageId: 'template-7' };
    const sent = await aThenBThenRetryA(
      { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { ...data, blastId: 'bl1' }, dedupeKey: 'blast:bl1' },
      { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { ...data, blastId: 'bl2' }, dedupeKey: 'blast:bl2' },
      'kinUid',
    );
    expect(sent).toBe(2);
  });

  it('a re-approval after a cancel sends; the same approval retried does not', async () => {
    const data = { kinfolkId: 'fam1', batchId: 'b1', bookingId: 'b1' };
    const sent = await aThenBThenRetryA(
      { key: 'kincare.booking.confirm', recipientUid: 'kinUid', data, dedupeKey: `booking:b1:approve:${NOW - 200_000}` },
      { key: 'kincare.booking.confirm', recipientUid: 'kinUid', data, dedupeKey: `booking:b1:approve:${NOW}` },
      'kinUid',
    );
    expect(sent).toBe(2);
  });
});

describe('ledger retention (#832 LOW)', () => {
  it('each ledger doc carries expiresAt, retention past its last delivery, for the TTL policy', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({ key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { bookingId: 'b1' } });
    const ledger = ctx.writes.find((w) => w.path.startsWith(`${DEDUPE_COLLECTION}/`));
    expect((ledger?.data.expiresAt as Timestamp).toMillis()).toBe(NOW + DEDUPE_LEDGER_RETENTION_MS);
    expect(DEDUPE_LEDGER_RETENTION_MS).toBeGreaterThan(NOTIFICATION_DEDUPE_WINDOW_MS);
  });
});
