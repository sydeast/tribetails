import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * Proves the CENTRAL enrichment wiring: onNotificationChannelCreate hydrates the
 * notification's id-only `data` (kinfolkId/invoiceId/...) into the full template
 * context BEFORE handing it to the channel sender. This is the single fan-out
 * choke point every delivery mode passes through, so one hook fixes all keys.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  logEventFn: vi.fn(),
  emailSender: vi.fn().mockResolvedValue({ providerMessageId: 'm-1' }),
  smsSender: vi.fn().mockResolvedValue({ providerMessageId: 's-1' }),
  pushSender: vi.fn().mockResolvedValue({ providerMessageId: 'p-1' }),
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...a: unknown[]) => unknown) => fn,
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAudit }));
vi.mock('../src/notifications/senders', () => ({
  channelSenders: { email: mocks.emailSender, sms: mocks.smsSender, push: mocks.pushSender },
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', increment: (n: number) => n } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.emailSender.mockClear().mockResolvedValue({ providerMessageId: 'm-1' });
  mocks.smsSender.mockClear().mockResolvedValue({ providerMessageId: 's-1' });
  mocks.pushSender.mockClear().mockResolvedValue({ providerMessageId: 'p-1' });
  mocks.writeAudit.mockClear().mockResolvedValue(undefined);
});

/** The channel-subdoc patch the trigger stamps; the assertions below read `status`/`skipReason`. */
type ChannelPatch = Record<string, unknown>;

function makeEvent(channel: string, parentData: Record<string, unknown>) {
  // Typed on purpose: an untyped `vi.fn(async () => {})` records a zero-arg
  // call signature, which makes `setSpy.mock.calls[n][0]` an out-of-range index
  // on an empty tuple and silently un-typechecks every status assertion.
  const setSpy = vi.fn(async (_patch: ChannelPatch) => {});
  const parentRef = {
    id: 'notif1',
    path: 'notifications/notif1',
    get: async () => ({ data: () => parentData }),
  };
  const channelRef = {
    parent: { parent: parentRef },
    set: setSpy,
  };
  const snap = { data: () => ({ status: 'pending' }), ref: channelRef };
  return { event: { data: snap, params: { channel, id: 'notif1' } }, setSpy };
}

describe('onNotificationChannelCreate central enrichment', () => {
  it('enriches id-only invoice.new data before the email sender is called', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { invoiceNumber: 'TT-1001', amountDue: 120, dueDate: 'Jul 5, 2026' },
        'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' },
      },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    const { event, setSpy } = makeEvent('email', {
      key: 'invoice.new',
      recipientUid: 'cli1',
      data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
    });

    await onNotificationChannelCreateHandler(event);

    expect(mocks.emailSender).toHaveBeenCalledTimes(1);
    const passed = mocks.emailSender.mock.calls[0]![0];
    expect(passed.recipientUid).toBe('cli1');
    expect(passed.data.invoiceNumber).toBe('TT-1001');
    expect(passed.data.amount).toBe('$120.00');
    expect(passed.data.dueDate).toBe('Jul 5, 2026');
    expect(passed.data.kinfolkName).toBe('The Rivera Home');
    expect(passed.data.kinName).toBe('Rex');
    // the original id-only keys are preserved alongside the hydrated ones
    expect(passed.data.invoiceId).toBe('inv1');
    // channel subdoc stamped sent
    const sentWrite = setSpy.mock.calls.find((c) => (c[0] as { status?: string }).status === 'sent');
    expect(sentWrite).toBeTruthy();
  });

  it('SOFT-SKIP: a sender that returns { skipped } stamps status "skipped", warns, does NOT throw, and writes no delivery audit', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { invoiceNumber: 'TT-1001', amountDue: 40, dueDate: 'Jul 5, 2026' },
        'families/fam1': { displayName: 'The Rivera Home' },
      },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    // Recipient has no email on file -> emailChannel returns a soft skip.
    mocks.emailSender.mockResolvedValueOnce({ skipped: true, skipReason: 'recipient_no_email' });

    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    const { event, setSpy } = makeEvent('email', {
      key: 'invoice.reminder',
      recipientUid: 'cli-no-email',
      data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
    });

    // must resolve (no throw) so Cloud Functions does not retry / Sentry-capture.
    await expect(onNotificationChannelCreateHandler(event)).resolves.toBeUndefined();

    const skippedWrite = setSpy.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === 'skipped',
    );
    expect(skippedWrite).toBeTruthy();
    expect((skippedWrite![0] as { skipReason?: string }).skipReason).toBe('recipient_no_email');
    // no 'sent' stamp, and no 'failed' stamp.
    expect(setSpy.mock.calls.find((c) => (c[0] as { status?: string }).status === 'sent')).toBeFalsy();
    expect(setSpy.mock.calls.find((c) => (c[0] as { status?: string }).status === 'failed')).toBeFalsy();
    // visible: a warning is logged.
    const warn = mocks.logEventFn.mock.calls
      .map((c) => c[0])
      .find((a: any) => a?.event === 'notification.channel.skipped');
    expect(warn).toBeTruthy();
    expect(warn.extra.reason).toBe('recipient_no_email');
    // undelivered -> no NOTIFICATION_RECEIVED audit entry.
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('passes enriched data to the sms sender too (same hook, all channels)', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { invoiceNumber: 'TT-1001', amountDue: 75 },
        'families/fam1': { displayName: 'The Rivera Home' },
      },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    const { event } = makeEvent('sms', {
      key: 'invoice.reminder',
      recipientUid: 'cli1',
      data: { invoiceId: 'inv1', kinfolkId: 'fam1', amountMinor: 7500 },
    });

    await onNotificationChannelCreateHandler(event);

    expect(mocks.smsSender).toHaveBeenCalledTimes(1);
    const passed = mocks.smsSender.mock.calls[0]![0];
    expect(passed.data.invoiceNumber).toBe('TT-1001');
    expect(passed.data.amount).toBe('$75.00');
    expect(passed.data.kinName).toBe('Rex');
  });
});
