import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { enqueueNotification } from '../src/notifications/dispatcher';

/**
 * Dispatch contract tests for the orphan wire-up sprint.
 * Confirms every newly-wired catalog key resolves recipients and writes
 * notification docs without crashing.
 */
describe('orphan wire-up — dispatch contract', () => {
  it('HAPPY: kincare.requested dispatches to businessAdmins', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a1', 'a2'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'kincare.requested',
      data: { kinfolkId: 'f1', bookingId: 'b1' },
    });
    expect(ids.length).toBe(2);
  });

  it('HAPPY: kincare.changed dispatches to businessAdmins', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'kincare.changed',
      data: { kinfolkId: 'f1', bookingId: 'b1', changedFields: ['startTime'] },
    });
    expect(ids.length).toBe(1);
  });

  it('HAPPY: quote.denied dispatches to businessAdmins', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a1', 'a2', 'a3'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'quote.denied',
      data: { kinfolkId: 'f1', invoiceId: 'inv1' },
    });
    expect(ids.length).toBe(3);
  });

  it('HAPPY: invoice.payment.applied dispatches to kinfolk', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'invoice.payment.applied',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'f1', invoiceId: 'inv1' },
    });
    expect(ids.length).toBe(1);
  });

  it('HAPPY: pet.marked.inactive dispatches to businessAdmins', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'pet.marked.inactive',
      data: { kinfolkId: 'f1', kinId: 'k1', kinName: 'Rex', status: 'noLongerWithUs' },
    });
    expect(ids.length).toBe(1);
  });

  it('HAPPY: account.welcome.kinfolk dispatches to specific kinfolk uid', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'account.welcome.kinfolk',
      recipientUid: 'newUid',
      data: { kinfolkId: 'f1', invitedEmail: 'a@b.com', role: 'PRIMARY' },
    });
    expect(ids.length).toBe(1);
  });

  it('RETIRED: account.welcome.business cannot be dispatched at all', async () => {
    // This used to be a HAPPY case: the key dispatched to businessAdmins when an
    // invited kinfolk finished setup. The operator retired the notification on
    // 2026-08-18 ("I did not need that type of notification"), so the catalog row
    // is gone and there is no send path left to reach. Both emitters
    // (membership/acceptInvite.ts, admin/setKinfolkClaim.ts) were removed with
    // it; this is the backstop that says so even if one crept back.
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a1', 'a2'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      enqueueNotification({
        key: 'account.welcome.business',
        recipientUid: 'newKinUid',
        data: { kinfolkId: 'f1', kinfolkUid: 'newKinUid' },
      }),
    ).rejects.toThrow(/unknown key 'account\.welcome\.business'/);
  });

  it('HAPPY: kintale.published dispatches to kinfolk (catalog routed, no raw FCM)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'kintale.published',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'f1', taleId: 't1', title: 'A tale' },
    });
    expect(ids.length).toBe(1);
  });

  it('SAD: invoice.payment.applied with no recipientUid resolves to zero', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      enqueueNotification({
        key: 'invoice.payment.applied',
        recipientUid: '',
        data: { kinfolkId: 'f1', invoiceId: 'inv1' },
      }),
    ).rejects.toThrow();
  });

  it('SAD: quote.denied with empty admin list throws', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      enqueueNotification({
        key: 'quote.denied',
        data: { kinfolkId: 'f1', invoiceId: 'inv1' },
      }),
    ).rejects.toThrow();
  });

  it('SCHEDULED: invoice.reminder enqueues to scheduledNotifications, not notifications', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'invoice.reminder',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'f1', invoiceId: 'inv1' },
      fireAtMs: Date.now(),
    });
    const writtenPaths = ctx.writes.map((w) => w.path);
    expect(writtenPaths.some((p) => p.startsWith('scheduledNotifications/'))).toBe(true);
  });

  it('SCHEDULED: kincare.upcoming.reminder enqueues to scheduledNotifications', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kincare.upcoming.reminder',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'f1', bookingId: 'b1' },
      fireAtMs: Date.now(),
    });
    const writtenPaths = ctx.writes.map((w) => w.path);
    expect(writtenPaths.some((p) => p.startsWith('scheduledNotifications/'))).toBe(true);
  });

  it('SCHEDULED: schedule.upcoming.digest enqueues to scheduledNotifications (businessAdmins)', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: ['a1', 'a2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'schedule.upcoming.digest',
      data: { count: 5, items: [] },
      fireAtMs: Date.now(),
    });
    const writtenPaths = ctx.writes.map((w) => w.path);
    expect(writtenPaths.filter((p) => p.startsWith('scheduledNotifications/')).length).toBe(2);
  });

  it('MARKETING: newsletter.announcement runs without throwing (suppression by opt-in is expected default)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    // Default user prefs have marketingOptIn=false → dispatcher suppresses; that is correct behavior.
    await expect(
      enqueueNotification({
        key: 'newsletter.announcement',
        recipientUid: 'kinUid',
        data: { subject: 'Hello' },
        fireAtMs: Date.now(),
      }),
    ).resolves.toBeDefined();
  });

  it('HAPPY: kintale.comment.added (batched) writes notificationBatch entry', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kintale.comment.added',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'f1', taleId: 't1', commentId: 'c1', preview: 'hi' },
    });
    const writtenPaths = ctx.writes.map((w) => w.path);
    expect(writtenPaths.some((p) => p.startsWith('notificationBatch/'))).toBe(true);
  });

  it('HAPPY: kincare.note.kinfolk dispatches to businessAdmins', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'kincare.note.kinfolk',
      data: { kinfolkId: 'f1', bookingId: 'b1', noteId: 'n1', preview: 'kf note' },
    });
    expect(ids.length).toBe(1);
  });

  it('HAPPY: rating.submitted.bad dispatches to businessAdmins (urgent)', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a1', 'a2'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'rating.submitted.bad',
      data: { kinfolkId: 'f1', ratingId: 'r1', score: 2 },
    });
    expect(ids.length).toBe(2);
  });

  it('HAPPY: rating.submitted.good dispatches to businessAdmins', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'rating.submitted.good',
      data: { kinfolkId: 'f1', ratingId: 'r1', score: 5 },
    });
    expect(ids.length).toBe(1);
  });

  it('HAPPY: kincare.unavailable dispatches to kinfolk', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: 'kincare.unavailable',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'f1', bookingId: 'b1' },
    });
    expect(ids.length).toBe(1);
  });

  it('MARKETING: newsletter.announcement with marketingOptIn=true writes to scheduledNotifications', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/kinUid': {
          notificationPrefs: { marketingOptIn: { newsletter: true } },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'newsletter.announcement',
      recipientUid: 'kinUid',
      data: { subject: 'Hello' },
      fireAtMs: Date.now(),
    });
    const writtenPaths = ctx.writes.map((w) => w.path);
    expect(writtenPaths.some((p) => p.startsWith('scheduledNotifications/'))).toBe(true);
  });
});
