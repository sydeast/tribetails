import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #832, the layer underneath. This suite does NOT mock the dispatcher: the
 * callable runs against the real `enqueueNotificationDetailed` over one
 * write-through mock, so what the second call sees is what the first one wrote.
 *
 * The claim it proves is the issue's: "a guarded caller is still protected if it
 * calls the dispatcher twice". The caller guard is taken OUT of the picture by
 * clearing the invoice stamp between the two presses (exactly what an operator
 * editing the doc by hand, or a future writer that forgets the stamp, would do),
 * and the household still receives one reminder.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));

import { INVOICE_REMINDER_RESEND_WINDOW_MS, sendInvoiceReminderHandler } from '../src/admin/sendInvoiceReminder';
import { enqueueNotification, enqueueNotificationDetailed } from '../src/notifications/dispatcher';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);

function req(): CallableRequest<unknown> {
  return {
    data: { invoiceId: 'inv1' },
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function scheduledReminders(writes: Array<{ path: string; data: Record<string, unknown> }>) {
  return writes.filter((w) => w.path.startsWith('scheduledNotifications/') && w.data.key === 'invoice.reminder');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sendInvoiceReminder over the real dispatcher', () => {
  it('two presses: the caller guard refuses the second, one reminder is queued', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-9' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await sendInvoiceReminderHandler(req());
    vi.setSystemTime(NOW + 3_000);
    const second = await sendInvoiceReminderHandler(req());

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(scheduledReminders(ctx.writes)).toHaveLength(1);
  });

  it('with the caller guard defeated, the dispatcher alone still delivers once', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-9' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await sendInvoiceReminderHandler(req());
    // Defeat the caller's guard: the stamp it reads is gone.
    await ctx.db.collection('invoices').doc('inv1').set({ reminderNotifiedAtMs: null }, { merge: true });
    vi.setSystemTime(NOW + 3_000);
    const second = await sendInvoiceReminderHandler(req());

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.lastReminderAtMs).toBe(NOW);
    expect(scheduledReminders(ctx.writes)).toHaveLength(1);
  });

  it('the cron and a manual press cannot both reach the household inside the dispatcher window', async () => {
    // The cron path calls the dispatcher directly with the same key, target
    // and recipient. Even if its stamp never lands, the press that follows
    // collides with the ledger entry the cron's delivery wrote.
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await enqueueNotification({
      key: 'invoice.reminder',
      recipientUid: 'kin-uid-1',
      data: { kinfolkId: 'fam1', invoiceId: 'inv1' },
      fireAtMs: NOW,
    });
    vi.setSystemTime(NOW + 10_000);
    const press = await sendInvoiceReminderHandler(req());

    expect(press.sent).toBe(false);
    expect(scheduledReminders(ctx.writes)).toHaveLength(1);
  });

  it('a crash after the dispatch and before the stamp: a press 10 minutes later answers recent and records the real reminder', async () => {
    // What the crashed press left: its lease, and a reminder the dispatcher
    // delivered and recorded in the ledger. The stamp never landed.
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-9', reminderClaimAtMs: NOW } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotificationDetailed({
      key: 'invoice.reminder',
      recipientUid: 'kin-uid-1',
      data: { kinfolkId: 'fam1', invoiceId: 'inv1' },
      fireAtMs: NOW,
      dedupeWindowMs: INVOICE_REMINDER_RESEND_WINDOW_MS,
    });

    // Past the 3-minute lease AND past the dispatcher's 5-minute default.
    vi.setSystemTime(NOW + 10 * 60_000);
    const press = await sendInvoiceReminderHandler(req());

    expect(press).toMatchObject({
      sent: false,
      reason: 'recent',
      lastReminderAtMs: NOW,
      nextReminderAllowedAtMs: NOW + INVOICE_REMINDER_RESEND_WINDOW_MS,
    });
    expect(scheduledReminders(ctx.writes)).toHaveLength(1);
    expect((await ctx.db.collection('invoices').doc('inv1').get()).data()?.reminderNotifiedAtMs).toBe(NOW);
  });
});
