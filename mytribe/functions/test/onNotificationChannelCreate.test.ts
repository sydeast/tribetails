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
  writeAudit: vi.fn<(args: Record<string, any>) => Promise<unknown>>().mockResolvedValue(undefined),
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
  // R5: the parent is the WORK ORDER, not the notification. It is id-matched to
  // the notification it delivers and carries key/recipientUid/data itself, so
  // this handler still does exactly one parent read and never has to reach
  // across into `notifications/`.
  const parentRef = {
    id: 'notif1',
    path: 'notificationDispatch/notif1',
    get: async () => ({ data: () => parentData }),
  };
  const channelRef = {
    parent: { parent: parentRef },
    set: setSpy,
  };
  const snap = { data: () => ({ status: 'pending' }), ref: channelRef };
  return { event: { data: snap, params: { channel, id: 'notif1' } }, setSpy };
}

describe('onNotificationChannelCreate hands the push what a tap opens (#2259, #2100)', () => {
  const docs = {
    docs: { 'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' } },
    queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
  };
  async function run(channel: string, parent: Record<string, unknown>) {
    mocks.dbFn.mockReturnValue(buildDbMock(docs).db);
    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    await onNotificationChannelCreateHandler(makeEvent(channel, parent).event);
  }

  it("a household's push opens the visit the work order names", async () => {
    await run('push', {
      key: 'kincare.auntie.arrived',
      recipientUid: 'cli1',
      stream: 'kinfolk',
      data: { kinfolkId: 'fam1', visitId: 'v1', batchId: 'b1' },
      targetType: 'booking',
      targetId: 'v1',
      notificationId: 'n77',
    });
    expect(mocks.pushSender.mock.calls[0]![0].open).toEqual({
      route: '/schedule/v1',
      data: { targetType: 'booking', targetId: 'v1', visitId: 'v1', batchId: 'b1' },
      // Where its full message is, should the sender find the line was cut.
      readInList: { route: '/notifications?entry=n77' },
      officeNote: false,
    });
  });
  it("a household's push about an answer the office wrote a note on says so", async () => {
    await run('push', {
      key: 'kincare.request.declined',
      recipientUid: 'cli1',
      stream: 'kinfolk',
      data: { kinfolkId: 'fam1', batchId: 'b1', note: 'We are away that week.' },
      targetType: 'booking',
      targetId: 'b1',
      notificationId: 'n78',
    });
    const open = mocks.pushSender.mock.calls[0]![0].open;
    expect(open.officeNote).toBe(true);
    expect(open.readInList).toEqual({ route: '/notifications?entry=n78' });
  });

  it("the office's push carries the target and no route", async () => {
    await run('push', {
      key: 'kincare.changed',
      recipientUid: 'admin1',
      stream: 'business',
      data: { kinfolkId: 'fam1', visitId: 'v1' },
      targetType: 'booking',
      targetId: 'v1',
    });
    expect(mocks.pushSender.mock.calls[0]![0].open).toEqual({
      data: { targetType: 'booking', targetId: 'v1', visitId: 'v1', kinfolkId: 'fam1' },
    });
  });

  it('a work order written before the target was stamped still sends, with nothing to open', async () => {
    await run('push', { key: 'broadcast.message', recipientUid: 'cli1', stream: 'kinfolk', data: {} });
    expect(mocks.pushSender.mock.calls[0]![0].open).toEqual({
      data: {},
      readInList: { route: '/notifications' },
      officeNote: false,
    });
  });

  it('email and text messages are handed no target: their link is unchanged', async () => {
    const parent = {
      key: 'kincare.auntie.arrived',
      recipientUid: 'cli1',
      stream: 'kinfolk',
      data: { kinfolkId: 'fam1', visitId: 'v1' },
      targetType: 'booking',
      targetId: 'v1',
    };
    await run('email', parent);
    await run('sms', parent);
    expect(mocks.emailSender.mock.calls[0]![0].open).toBeUndefined();
    expect(mocks.smsSender.mock.calls[0]![0].open).toBeUndefined();
  });
});

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
    // #1752: the delivery entry names the notification, not its catalog key.
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Delivered "New invoice or quote issued" by email' }),
    );
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
    expect(mocks.writeAudit.mock.calls.map((c) => c[0].event)).not.toContain('NOTIFICATION_RECEIVED');
    // #1905: and one line that says this channel did not go, and why, in words.
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit.mock.calls[0]![0]).toMatchObject({
      event: 'NOTIFICATION_NOT_SENT',
      status: 'NOT_SENT',
      severity: 'warn',
      targetUid: 'notif1',
      description: 'Could not send "Invoice payment reminder" by email: no email address on file',
      payload: { outcome: 'no_address', channels: ['email'], skipReason: 'recipient_no_email' },
    });
    expect(typeof mocks.writeAudit.mock.calls[0]![0].docId).toBe('string');
  });

  it('#1905 a skipped text message to a household names the person and the missing number', async () => {
    const ctx = buildDbMock({ docs: { 'clients/cli1': { displayName: 'Dre East' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.smsSender.mockResolvedValueOnce({ skipped: true, skipReason: 'recipient_no_phone' });
    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    const { event } = makeEvent('sms', {
      key: 'invoice.reminder',
      recipientUid: 'cli1',
      stream: 'kinfolk',
      data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
    });
    await onNotificationChannelCreateHandler(event);
    expect(mocks.writeAudit.mock.calls.map((c) => c[0].description)).toEqual([
      'Could not send "Invoice payment reminder" to Dre East by text message: no mobile number on file',
    ]);
  });

  it('#1905 a delivered copy names who it went to: the person, or the office', async () => {
    const ctx = buildDbMock({ docs: { 'clients/cli1': { displayName: 'Dre East' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    await onNotificationChannelCreateHandler(
      makeEvent('email', {
        key: 'invoice.payment.applied',
        recipientUid: 'cli1',
        stream: 'kinfolk',
        data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
      }).event,
    );
    await onNotificationChannelCreateHandler(
      makeEvent('email', {
        key: 'invoice.payment.applied',
        recipientUid: 'adminUid',
        stream: 'business',
        data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
      }).event,
    );
    expect(mocks.writeAudit.mock.calls.map((c) => c[0].description)).toEqual([
      'Delivered "Payment or credit applied to an invoice" to Dre East by email',
      'Delivered "Payment or credit applied to an invoice" to the office by email',
    ]);
  });

  it('#1905 a send that throws writes a FAILURE line once, stamps the channel failed, and still rethrows', async () => {
    const ctx = buildDbMock({ docs: { 'clients/cli1': { displayName: 'Dre East' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.emailSender.mockRejectedValue(new Error('smtp 503'));
    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    const parent = {
      key: 'invoice.reminder',
      recipientUid: 'cli1',
      stream: 'kinfolk',
      data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
    };
    const first = makeEvent('email', parent);
    await expect(onNotificationChannelCreateHandler(first.event)).rejects.toThrow('smtp 503');
    expect(first.setSpy.mock.calls.find((c) => (c[0] as { status?: string }).status === 'failed')).toBeTruthy();
    await expect(onNotificationChannelCreateHandler(makeEvent('email', parent).event)).rejects.toThrow('smtp 503');

    const lines = mocks.writeAudit.mock.calls.map((c) => c[0]);
    expect(lines.map((l) => l.event)).toEqual(['NOTIFICATION_NOT_SENT', 'NOTIFICATION_NOT_SENT']);
    expect(lines[0]).toMatchObject({
      status: 'FAILURE',
      severity: 'warn',
      description: 'Could not send "Invoice payment reminder" to Dre East by email: the send failed',
      payload: { outcome: 'failed', channels: ['email'] },
    });
    // The retry asks for the same line: a fixed id, so the log holds it once.
    expect(lines[1].docId).toBe(lines[0].docId);
    // The provider's own error text is not put on screen.
    expect(lines[0].description).not.toContain('smtp');
  });

  it('#1905 a line that cannot be written never turns a skipped channel into a retry', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.emailSender.mockResolvedValueOnce({ skipped: true, skipReason: 'recipient_no_email' });
    mocks.writeAudit.mockRejectedValueOnce(new Error('chain busy'));
    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    const { event } = makeEvent('email', { key: 'invoice.reminder', recipientUid: 'cli1', data: {} });
    await expect(onNotificationChannelCreateHandler(event)).resolves.toBeUndefined();
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
  it("#2280: hands the work order's stream to the sender, so a household's text and push stay short", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    const { onNotificationChannelCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationChannelCreate'
    );
    const run = async (channel: 'sms' | 'push', stream: unknown) => {
      const { event } = makeEvent(channel, {
        key: 'kincare.booking.confirm',
        recipientUid: 'cli1',
        data: {},
        ...(stream === undefined ? {} : { stream }),
      });
      await onNotificationChannelCreateHandler(event);
    };
    await run('sms', 'kinfolk');
    expect(mocks.smsSender.mock.calls[0]![0].stream).toBe('kinfolk');
    await run('push', 'business');
    expect(mocks.pushSender.mock.calls[0]![0].stream).toBe('business');
    // A work order written before the stamp existed, or one carrying junk: no stream at all.
    await run('push', undefined);
    await run('push', 'everyone');
    expect('stream' in mocks.pushSender.mock.calls[1]![0]).toBe(false);
    expect('stream' in mocks.pushSender.mock.calls[2]![0]).toBe(false);
  });
});
