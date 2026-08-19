import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/operatorAllowlist', () => ({
  isAuntieOperator: () => true,
  requireAuntieOperator: vi.fn(),
}));

beforeEach(() => mocks.dbFn.mockReset());

import { listNotificationDeliveriesHandler } from '../src/admin/listNotificationDeliveries';

const REQ = { auth: { uid: 'admin1', token: {} } };

/**
 * `notificationDispatch` and its channel subdocs had no reader anywhere before
 * #396, so this suite is the first thing that ever asserted their contents come
 * back honestly. The point of nearly every case below is the same: report what
 * the pipeline recorded, and never upgrade it into a delivery confirmation.
 */
function fixture() {
  return buildDbMock({
    queryDocs: {
      notificationDispatch: [
        {
          id: 'd_new',
          data: {
            notificationId: 'd_new',
            key: 'invoice.new',
            recipientUid: 'kin1',
            mode: 'trigger',
            channels: ['email', 'sms'],
            status: 'dispatched',
            createdAt: new Date(2000),
          },
        },
        {
          id: 'd_old',
          data: {
            notificationId: 'd_old',
            key: 'kintale.published',
            recipientUid: 'kin2',
            mode: 'trigger',
            channels: ['email'],
            status: 'dispatched',
            createdAt: new Date(1000),
          },
        },
      ],
      'notificationDispatch/d_new/channels': [
        {
          id: 'email',
          data: { status: 'sent', providerMessageId: 'smtp-1', sentAt: new Date(2100) },
        },
        {
          id: 'sms',
          data: {
            status: 'failed',
            errorMessage: 'Twilio 21610: unsubscribed recipient',
            attempts: 2,
            failedAt: new Date(2200),
          },
        },
      ],
      'notificationDispatch/d_old/channels': [
        { id: 'email', data: { status: 'skipped', skipReason: 'no-email-on-file' } },
      ],
    },
  });
}

describe('listNotificationDeliveriesHandler', () => {
  it('returns the newest dispatches with their per-channel attempts', async () => {
    mocks.dbFn.mockReturnValue(fixture().db);
    const res = await listNotificationDeliveriesHandler({ data: {}, ...REQ } as any);

    expect(res.deliveries.map((d) => d.dispatchId)).toEqual(['d_new', 'd_old']);
    const first = res.deliveries[0];
    expect(first.key).toBe('invoice.new');
    expect(first.recipientUid).toBe('kin1');
    expect(first.channels).toEqual(['email', 'sms']);
    expect(first.createdAtMs).toBe(2000);
    expect(first.attempts.map((a) => a.channel)).toEqual(['email', 'sms']);
  });

  it('carries the provider message id and the failure text verbatim', async () => {
    mocks.dbFn.mockReturnValue(fixture().db);
    const res = await listNotificationDeliveriesHandler({ data: {}, ...REQ } as any);
    const [email, sms] = res.deliveries[0].attempts;

    expect(email.status).toBe('sent');
    expect(email.providerMessageId).toBe('smtp-1');
    expect(email.sentAtMs).toBe(2100);

    expect(sms.status).toBe('failed');
    expect(sms.errorMessage).toBe('Twilio 21610: unsubscribed recipient');
    expect(sms.attempts).toBe(2);
    expect(sms.failedAtMs).toBe(2200);
  });

  it('keeps a fail-soft skip and its reason visible rather than dropping it', async () => {
    mocks.dbFn.mockReturnValue(fixture().db);
    const res = await listNotificationDeliveriesHandler({ data: {}, ...REQ } as any);
    const skipped = res.deliveries[1].attempts[0];
    expect(skipped.status).toBe('skipped');
    expect(skipped.skipReason).toBe('no-email-on-file');
    expect(skipped.providerMessageId).toBeNull();
  });

  it('never claims a delivery receipt it does not have', async () => {
    mocks.dbFn.mockReturnValue(fixture().db);
    const res = await listNotificationDeliveriesHandler({ data: {}, ...REQ } as any);
    // The engagement webhooks match external_messages only, so nothing ever
    // writes a receipt back to these channel subdocs. If that changes, this
    // assertion is the thing that must change with it.
    expect(res.receiptAvailable).toBe(false);
    expect(res.sentMeaning).toMatch(/provider accepted/i);
    expect(res.sentMeaning).toMatch(/no delivery receipt/i);
    for (const d of res.deliveries) {
      for (const a of d.attempts) {
        expect(a.status).not.toBe('delivered');
      }
    }
  });

  it('filters to one catalog key when asked', async () => {
    const ctx = fixture();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listNotificationDeliveriesHandler({
      data: { key: 'kintale.published' },
      ...REQ,
    } as any);
    expect(res.deliveries.map((d) => d.key)).toEqual(['kintale.published']);
  });

  it('reports a channel subdoc with no status as unknown, not as sent', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        notificationDispatch: [
          { id: 'd1', data: { key: 'invoice.new', recipientUid: 'k', createdAt: new Date(1) } },
        ],
        'notificationDispatch/d1/channels': [{ id: 'email', data: {} }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listNotificationDeliveriesHandler({ data: {}, ...REQ } as any);
    expect(res.deliveries[0].attempts[0].status).toBe('unknown');
    expect(res.deliveries[0].status).toBe('unknown');
  });

  it('returns an empty list rather than throwing when nothing has been dispatched', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const res = await listNotificationDeliveriesHandler({ data: {}, ...REQ } as any);
    expect(res.deliveries).toEqual([]);
    expect(res.receiptAvailable).toBe(false);
  });

  it('rejects a limit outside the allowed range', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      listNotificationDeliveriesHandler({ data: { limit: 5000 }, ...REQ } as any),
    ).rejects.toThrow();
  });
});
