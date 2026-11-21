import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #2487: the channel trigger tells the enricher which side a copy is on, so a
 * household's copy of a key that also reaches the office is worded for the
 * household (its visit time as the portal's window, #1863), the way its
 * notifications list line already is.
 */
const mocks = vi.hoisted(() => ({
  enrich: vi.fn(
    async (_k: string, _u: string, data: Record<string, unknown>, _extra: readonly string[] = [], _household = false) => ({
      ...data,
    }),
  ),
  emailSender: vi.fn().mockResolvedValue({ providerMessageId: 'm-1' }),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({ wrapTrigger: (_n: string, fn: (...a: unknown[]) => unknown) => fn }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/notifications/enrichTemplateData', () => ({ enrichTemplateData: mocks.enrich }));
vi.mock('../src/notifications/senders', () => ({
  channelSenders: { email: mocks.emailSender, sms: vi.fn(), push: vi.fn() },
}));
vi.mock('../src/notifications/noticeAudit', () => ({
  noticeFamilyId: () => '',
  noticeRecipientWords: async () => 'the office',
  noticeStream: (s: unknown) => s,
  recordNoticeNotSent: vi.fn(),
  noticeLineId: () => 'x',
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', increment: (n: number) => n } };
});

beforeEach(() => {
  mocks.enrich.mockClear();
  mocks.emailSender.mockClear();
});

function eventFor(stream: string | undefined) {
  const parent = {
    key: 'kincare.booking.cancel',
    recipientUid: 'u1',
    data: { kinfolkId: 'fam1', visitId: 'v1' },
    ...(stream ? { stream } : {}),
  };
  const parentRef = { id: 'n1', path: 'notificationDispatch/n1', get: async () => ({ data: () => parent }) };
  const snap = { data: () => ({ status: 'pending' }), ref: { parent: { parent: parentRef }, set: vi.fn() } };
  return { data: snap, params: { channel: 'email', id: 'n1' } };
}

describe("onNotificationChannelCreate enriches each copy for its own side", () => {
  it("a household's copy is enriched as the household's", async () => {
    const { onNotificationChannelCreateHandler } = await import('../src/notifications/triggers/onNotificationChannelCreate');
    await onNotificationChannelCreateHandler(eventFor('kinfolk'));
    expect(mocks.enrich).toHaveBeenCalledWith('kincare.booking.cancel', 'u1', { kinfolkId: 'fam1', visitId: 'v1' }, [], true);
  });

  it("the office's copy of the same key is not", async () => {
    const { onNotificationChannelCreateHandler } = await import('../src/notifications/triggers/onNotificationChannelCreate');
    await onNotificationChannelCreateHandler(eventFor('business'));
    expect(mocks.enrich.mock.calls[0]![4]).toBe(false);
  });

  it('a work order with no stream stamped is not treated as the household', async () => {
    const { onNotificationChannelCreateHandler } = await import('../src/notifications/triggers/onNotificationChannelCreate');
    await onNotificationChannelCreateHandler(eventFor(undefined));
    expect(mocks.enrich.mock.calls[0]![4]).toBe(false);
  });
});
