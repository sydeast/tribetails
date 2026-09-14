import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

import {
  DEDUPE_COLLECTION,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  dedupeIdentityOf,
  enqueueNotification,
  enqueueNotificationDetailed,
} from '../src/notifications/dispatcher';

/**
 * #832: the dispatcher refuses to deliver the same notification twice to the
 * same person inside NOTIFICATION_DEDUPE_WINDOW_MS, whoever the caller is.
 *
 * Every test here runs the mock with `writeThrough: true`. The whole claim is
 * "the SECOND attempt sees what the first one wrote"; against a static fixture
 * the second attempt sees nothing and a dedupe test passes for the wrong reason.
 *
 * `kincare.auntie.on_my_way` is trigger mode with a single kinfolk audience, so
 * one enqueue writes exactly one `notifications/` doc. `invoice.reminder` is
 * scheduled mode, the path the invoice reminder actually takes.
 */
const BASE_MS = Date.UTC(2026, 8, 14, 15, 0, 0);

function inbox(writes: Array<{ path: string }>) {
  return writes.filter((w) => w.path.startsWith('notifications/'));
}
function queued(writes: Array<{ path: string }>) {
  return writes.filter((w) => w.path.startsWith('scheduledNotifications/'));
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('dispatcher dedupe on (key, target, recipient)', () => {
  it('the window is one named constant, longer than a callable retry and shorter than the debounce horizon', () => {
    // Lower bound: a callable times out at 60s and the client may retry.
    expect(NOTIFICATION_DEDUPE_WINDOW_MS).toBeGreaterThan(60_000 * 2);
    // Upper bound: the catalog's own default debounce (30 min) is where it
    // already treats repeats as ONE event while keeping the newest content.
    // Dropping later content for that long would be worse than a debounce.
    expect(NOTIFICATION_DEDUPE_WINDOW_MS).toBeLessThan(30 * 60 * 1000);
  });

  it('a second identical trigger-mode enqueue inside the window writes nothing', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { bookingId: 'b1' } };

    const first = await enqueueNotification(args);
    vi.setSystemTime(BASE_MS + 30_000);
    const second = await enqueueNotification(args);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(inbox(ctx.writes)).toHaveLength(1);
    expect(ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'))).toHaveLength(1);
  });

  it('reports the duplicate with the notification it collided with, distinct from a prefs suppression', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { bookingId: 'b1' } };

    const first = await enqueueNotificationDetailed(args);
    vi.setSystemTime(BASE_MS + 1_000);
    const second = await enqueueNotificationDetailed(args);

    expect(first.suppressed).toEqual([]);
    expect(second.written).toEqual([]);
    expect(second.suppressed).toEqual([
      {
        recipientUid: 'kinUid',
        reason: 'duplicate',
        existingId: first.written[0],
        lastAtMs: BASE_MS,
      },
    ]);
  });

  it('sends again once the window has elapsed', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { bookingId: 'b1' } };

    await enqueueNotification(args);
    vi.setSystemTime(BASE_MS + NOTIFICATION_DEDUPE_WINDOW_MS);
    const later = await enqueueNotification(args);

    expect(later).toHaveLength(1);
    expect(inbox(ctx.writes)).toHaveLength(2);
  });

  it('a suppressed attempt does not extend the window', async () => {
    // Otherwise a client retrying every minute would push the next legitimate
    // send out forever.
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { bookingId: 'b1' } };

    await enqueueNotification(args);
    vi.setSystemTime(BASE_MS + NOTIFICATION_DEDUPE_WINDOW_MS - 1);
    expect(await enqueueNotification(args)).toEqual([]);
    vi.setSystemTime(BASE_MS + NOTIFICATION_DEDUPE_WINDOW_MS);
    expect(await enqueueNotification(args)).toHaveLength(1);
  });

  it('a different recipient, target or key is a different notification', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);

    await enqueueNotification({ key: 'kincare.auntie.on_my_way', recipientUid: 'kinA', data: { bookingId: 'b1' } });
    await enqueueNotification({ key: 'kincare.auntie.on_my_way', recipientUid: 'kinB', data: { bookingId: 'b1' } });
    await enqueueNotification({ key: 'kincare.auntie.on_my_way', recipientUid: 'kinA', data: { bookingId: 'b2' } });
    await enqueueNotification({ key: 'kincare.auntie.arrived', recipientUid: 'kinA', data: { bookingId: 'b1' } });

    expect(inbox(ctx.writes)).toHaveLength(4);
  });

  it('distinct events on one target (two comments on one tale) both go; a retry of one comment does not', async () => {
    // The tuple alone would collapse these: `kintale.comment.added` targets the
    // tale, so two different comments inside the window share (key, target,
    // recipient). The per-event id in `data` keeps them apart.
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const comment = (commentId: string) => ({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      data: { taleId: 't1', commentId },
    });

    await enqueueNotification(comment('c1'));
    await enqueueNotification(comment('c2'));
    await enqueueNotification(comment('c1'));

    expect(inbox(ctx.writes)).toHaveLength(2);
  });

  it('an explicit dedupeKey replaces the derived identity', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const base = { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { bookingId: 'b1' } };

    await enqueueNotification({ ...base, dedupeKey: 'evt-1' });
    await enqueueNotification({ ...base, dedupeKey: 'evt-2' });
    await enqueueNotification({ ...base, dedupeKey: 'evt-1' });

    expect(inbox(ctx.writes)).toHaveLength(2);
  });

  it('a notification with no resolvable identity is never deduped', async () => {
    // Nothing names the event (a password-reset style payload), so two sends
    // cannot be told apart from two genuine events. Refusing would be a guess.
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { note: 'x' } };

    await enqueueNotification(args);
    await enqueueNotification(args);

    expect(inbox(ctx.writes)).toHaveLength(2);
    expect(ctx.writes.some((w) => w.path.startsWith(`${DEDUPE_COLLECTION}/`))).toBe(false);
  });

  it('covers scheduled mode, the path invoice.reminder takes', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = {
      key: 'invoice.reminder',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'fam1', invoiceId: 'inv1' },
      fireAtMs: BASE_MS,
    };

    await enqueueNotification(args);
    vi.setSystemTime(BASE_MS + 5_000);
    const second = await enqueueNotification(args);

    expect(second).toEqual([]);
    expect(queued(ctx.writes)).toHaveLength(1);
  });

  it('decides and writes inside ONE transaction, so the check and the send cannot be split', async () => {
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({ key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { bookingId: 'b1' } });

    expect(ctx.db.runTransaction).toHaveBeenCalledTimes(1);
    const ledger = ctx.writes.filter((w) => w.path.startsWith(`${DEDUPE_COLLECTION}/`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].data).toMatchObject({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      lastAtMs: BASE_MS,
    });
  });

  it('two concurrent attempts under serialized transactions deliver once', async () => {
    // Real Firestore gives a transaction serializable isolation and retries the
    // loser. The mock does not referee concurrency, so this serializes its
    // transactions the way the server would, and proves the decision is made
    // on the read INSIDE the transaction rather than on one taken before it.
    const ctx = buildDbMock({ writeThrough: true });
    const original = ctx.db.runTransaction;
    let tail: Promise<unknown> = Promise.resolve();
    ctx.db.runTransaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const run = tail.then(() => original(fn));
      tail = run.catch(() => undefined);
      return run;
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = { key: 'kincare.auntie.on_my_way', recipientUid: 'kinUid', data: { bookingId: 'b1' } };

    const results = await Promise.all([enqueueNotification(args), enqueueNotification(args), enqueueNotification(args)]);

    expect(results.flat()).toHaveLength(1);
    expect(inbox(ctx.writes)).toHaveLength(1);
  });

  it('leaves debounced mode alone: it already collapses repeats onto one doc and keeps the newest content', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'businessSettings/admins': { uids: ['admin1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = { key: 'pets.updated', recipientUid: 'kinUid', data: { kinfolkId: 'kf1' } };

    await enqueueNotification(args);
    await enqueueNotification(args);

    const pending = ctx.writes.filter((w) => w.path.startsWith('pendingNotifications/'));
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(ctx.writes.some((w) => w.path.startsWith(`${DEDUPE_COLLECTION}/`))).toBe(false);
  });
});

describe('dedupeIdentityOf', () => {
  it('is the target when nothing more specific exists', () => {
    expect(dedupeIdentityOf({ key: 'k', data: {} }, { targetType: 'invoice', targetId: 'inv1' })).toBe('invoice:inv1');
  });
  it('appends a per-event id from data', () => {
    expect(
      dedupeIdentityOf({ key: 'k', data: { paymentId: 'p9' } }, { targetType: 'invoice', targetId: 'inv1' }),
    ).toBe('invoice:inv1#paymentId:p9');
  });
  it('an explicit dedupeKey wins', () => {
    expect(
      dedupeIdentityOf({ key: 'k', data: { paymentId: 'p9' }, dedupeKey: 'x' }, { targetType: 'invoice', targetId: 'inv1' }),
    ).toBe('key:x');
  });
  it('is empty when nothing names the event', () => {
    expect(dedupeIdentityOf({ key: 'k', data: { email: 'a@b.c' } }, { targetType: '', targetId: '' })).toBe('');
  });
});
