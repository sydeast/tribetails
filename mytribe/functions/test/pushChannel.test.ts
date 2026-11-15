import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getAdminFn: vi.fn(),
  multicast: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  getAdmin: mocks.getAdminFn,
  auth: vi.fn(),
}));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getAdminFn.mockReset();
  mocks.multicast.mockReset();
  mocks.getAdminFn.mockReturnValue({ messaging: () => ({ sendEachForMulticast: mocks.multicast }) });
});

import { sendPushChannel } from '../src/notifications/senders/pushChannel';
import type { NotificationDef } from '../src/notifications/types';

function def(overrides: Partial<NotificationDef> = {}): NotificationDef {
  return {
    key: 't.k',
    label: 'Test notification',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { push: 't.k' },
    description: 'test',
    ...overrides,
  };
}

/** Bespoke Firestore mock: doc fetch + filtered collection query for fcm_tokens. */
function buildPushDbMock(opts: {
  template?: { title?: string; body?: string; dataRoute?: string } | null;
  tokens?: string[];
  deletes?: string[];
}) {
  const deletes: string[] = opts.deletes ?? [];

  const docMock = (path: string) => ({
    get: vi.fn(async () => {
      if (path === 'pushTemplates/t.k') {
        return { exists: !!opts.template, data: () => opts.template ?? undefined };
      }
      return { exists: false, data: () => undefined };
    }),
    delete: vi.fn(async () => {
      deletes.push(path);
    }),
  });

  const fcmCollection = {
    where: vi.fn(() => fcmCollection),
    get: vi.fn(async () => ({
      docs: (opts.tokens ?? []).map((id) => ({
        id,
        data: () => ({ uid: 'u1', token: id }),
      })),
    })),
    doc: (id: string) => docMock(`fcm_tokens/${id}`),
  } as any;

  const db = {
    doc: (path: string) => docMock(path),
    collection: (path: string) => {
      if (path === 'fcm_tokens') return fcmCollection;
      return { doc: (id: string) => docMock(`${path}/${id}`) };
    },
  };

  return { db, deletes };
}

describe('sendPushChannel', () => {
  it('renders + multicasts to all uid tokens; returns first successful message id', async () => {
    const ctx = buildPushDbMock({
      template: { title: 'Hi {{name}}', body: '{{msg}}', dataRoute: '/kc/{{id}}' },
      tokens: ['t1', 't2'],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 2,
      failureCount: 0,
      responses: [
        { success: true, messageId: 'm-1' },
        { success: true, messageId: 'm-2' },
      ],
    });

    const res = await sendPushChannel({
      def: def(),
      recipientUid: 'u1',
      data: { name: 'Sam', msg: 'hi', id: 'kc123' },
    });

    expect(res.providerMessageId).toBe('m-1');
    const call = mocks.multicast.mock.calls[0]![0];
    expect(call.tokens).toEqual(['t1', 't2']);
    expect(call.notification).toEqual({ title: 'Hi Sam', body: 'hi' });
    expect(call.data).toEqual({ notificationKey: 't.k', route: '/kc/kc123' });
  });

  it('#2093: a quote with no Kin still reads whole in a push template stored before re-import', async () => {
    const push = async (template: { title: string; body: string }) => {
      const ctx = buildPushDbMock({ template, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockReset();
      mocks.multicast.mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true, messageId: 'm' }] });
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: { kinName: '', quoteHouseholdKinNames: 'Rex, Mo' } });
      return mocks.multicast.mock.calls[0]![0].notification as { title: string; body: string };
    };
    expect(await push({ title: 'Quote accepted', body: "You're all set for {{kinName}}'s care." })).toEqual({
      title: 'Quote accepted',
      body: "You're all set for Rex, Mo's care.",
    });
    expect(await push({ title: 'Quote accepted', body: "You're all set{{#if kinName}} for {{kinName}}'s care{{/if}}." })).toEqual({
      title: 'Quote accepted',
      body: "You're all set.",
    });
  });

  it('prunes invalid tokens reported by FCM', async () => {
    const ctx = buildPushDbMock({
      template: { title: 't', body: 'b' },
      tokens: ['live', 'dead'],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true, messageId: 'ok' },
        { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'gone' } },
      ],
    });
    await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(ctx.deletes).toContain('fcm_tokens/dead');
    expect(ctx.deletes).not.toContain('fcm_tokens/live');
  });

  it('throws when all sends fail', async () => {
    const ctx = buildPushDbMock({
      template: { title: 't', body: 'b' },
      tokens: ['t1'],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: { code: 'messaging/internal-error', message: 'oops' } }],
    });
    await expect(
      sendPushChannel({ def: def(), recipientUid: 'u1', data: {} }),
    ).rejects.toThrow(/all 1 sends failed/);
  });

  it('throws when recipient has no tokens', async () => {
    const ctx = buildPushDbMock({
      template: { title: 't', body: 'b' },
      tokens: [],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendPushChannel({ def: def(), recipientUid: 'u1', data: {} }),
    ).rejects.toThrow(/no registered fcm tokens/);
  });

  it('sends GENERIC wording when the template has no body, rather than throwing', async () => {
    const ctx = buildPushDbMock({ template: { title: 't' }, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'm1' }],
    });
    const res = await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res.usedFallback).toBe(true);
    expect(res.fallbackReason).toBe('pushTemplates/t.k');
    expect(mocks.multicast.mock.calls[0]![0].notification).toEqual({
      title: 'An update about your care',
      body: 'Tap to see it.',
    });
  });
  it('sends GENERIC wording when the template document does not exist', async () => {
    // The whole point: a new catalog key must not be dead in prod until someone
    // writes public-facing copy, and mass-deleting the template set must not
    // take the notification system down.
    const ctx = buildPushDbMock({ template: null, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'm1' }],
    });
    const res = await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res.usedFallback).toBe(true);
    expect(mocks.multicast.mock.calls[0]![0].notification.title).toBe('An update about your care');
  });
  it('points an office-facing key at AuntieOS, not the household portal', async () => {
    const ctx = buildPushDbMock({ template: null, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'm1' }],
    });
    const res = await sendPushChannel({
      def: def({ audience: 'business', audiences: { business: true }, kinfolkFacing: false }),
      recipientUid: 'u1',
      data: {},
    });
    expect(res.usedFallback).toBe(true);
    expect(mocks.multicast.mock.calls[0]![0].notification.title).toBe('An update in AuntieOS');
  });
  it('does NOT flag a fallback when the template is fully authored', async () => {
    const ctx = buildPushDbMock({ template: { title: 'Hi', body: 'there' }, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'm1' }],
    });
    const res = await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res.usedFallback).toBeUndefined();
    expect(mocks.multicast.mock.calls[0]![0].notification).toEqual({ title: 'Hi', body: 'there' });
  });
  describe('#2280: a household push is short and opens MyTribe', () => {
    const ok = { successCount: 1, failureCount: 0, responses: [{ success: true, messageId: 'm1' }] };
    const sent = () => mocks.multicast.mock.calls[0]![0] as { notification: { title: string; body: string }; data: Record<string, string> };
    const longNote = 'Please leave the side gate unlatched. '.repeat(14).trim();
    it('cuts a long line to 200 characters with an ellipsis and carries the notifications route', async () => {
      const ctx = buildPushDbMock({ template: { title: 'Care request declined', body: 'We could not take it. {{note}}' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: { note: longNote }, stream: 'kinfolk' });
      const { notification, data } = sent();
      expect(longNote.length).toBeGreaterThan(400);
      expect(notification.body.length).toBeLessThanOrEqual(200);
      expect(notification.body.endsWith('…')).toBe(true);
      expect(notification.body.startsWith('We could not take it. Please leave the side gate')).toBe(true);
      expect(data).toEqual({ notificationKey: 't.k', route: '/notifications' });
    });
    it('leaves a short line as written and still carries the route', async () => {
      const ctx = buildPushDbMock({ template: { title: 'Visit coming up', body: 'Tap for details.' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: {}, stream: 'kinfolk' });
      expect(sent().notification).toEqual({ title: 'Visit coming up', body: 'Tap for details.' });
      expect(sent().data['route']).toBe('/notifications');
    });
    it("keeps the template's own route when it names one", async () => {
      const ctx = buildPushDbMock({ template: { title: 'A', body: 'B', dataRoute: '/kincare/{{id}}' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: { id: 'v9' }, stream: 'kinfolk' });
      expect(sent().data['route']).toBe('/kincare/v9');
    });
    it('the generic wording for a missing template carries the route too', async () => {
      const ctx = buildPushDbMock({ template: null, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: {}, stream: 'kinfolk' });
      expect(sent().data['route']).toBe('/notifications');
    });
    it('#2259: opens the thing the notice is about, and carries its target for the Android app', async () => {
      const ctx = buildPushDbMock({ template: { title: 'Auntie has arrived', body: 'Tap for details.' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def(),
        recipientUid: 'u1',
        data: {},
        stream: 'kinfolk',
        open: { route: '/schedule/v1', data: { targetType: 'booking', targetId: 'v1', visitId: 'v1' } },
      });
      expect(sent().data).toEqual({
        notificationKey: 't.k',
        route: '/schedule/v1',
        targetType: 'booking',
        targetId: 'v1',
        visitId: 'v1',
      });
      // The wording and the short line are untouched.
      expect(sent().notification).toEqual({ title: 'Auntie has arrived', body: 'Tap for details.' });
    });
    it('#2259: a notice with nothing to open still lands on the notifications list', async () => {
      const ctx = buildPushDbMock({ template: { title: 'A', body: 'B' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: {}, stream: 'kinfolk', open: { data: {} } });
      expect(sent().data).toEqual({ notificationKey: 't.k', route: '/notifications' });
    });
    it("#2259: the template's own route still wins over the target's", async () => {
      const ctx = buildPushDbMock({ template: { title: 'A', body: 'B', dataRoute: '/kintales' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def(),
        recipientUid: 'u1',
        data: {},
        stream: 'kinfolk',
        open: { route: '/schedule/v1', data: { targetType: 'booking', targetId: 'v1' } },
      });
      expect(sent().data['route']).toBe('/kintales');
    });
    it('#2259: target data can never replace the notification key or the route', async () => {
      const ctx = buildPushDbMock({ template: { title: 'A', body: 'B' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def(),
        recipientUid: 'u1',
        data: {},
        stream: 'kinfolk',
        open: { route: '/schedule/v1', data: { notificationKey: 'other.key', route: 'https://evil.example' } },
      });
      expect(sent().data).toEqual({ notificationKey: 't.k', route: '/schedule/v1' });
    });
    it.each(['business', 'staff'] as const)('#2100: a %s copy carries its target and still no route', async (stream) => {
      const ctx = buildPushDbMock({ template: { title: 'Visit changed', body: 'B' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def({ audience: 'both', audiences: { kinfolk: true, business: true } }),
        recipientUid: 'u1',
        data: {},
        stream,
        open: { data: { targetType: 'booking', targetId: 'v1', visitId: 'v1', kinfolkId: 'fam1' } },
      });
      expect(sent().data).toEqual({ notificationKey: 't.k', targetType: 'booking', targetId: 'v1', visitId: 'v1', kinfolkId: 'fam1' });
    });
    it.each(['business', 'staff', undefined] as const)('a %s copy is sent as written, with no route added', async (stream) => {
      const ctx = buildPushDbMock({ template: { title: 'Care request', body: '{{note}}' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def({ audience: 'both', audiences: { kinfolk: true, business: true } }),
        recipientUid: 'u1',
        data: { note: longNote },
        ...(stream ? { stream } : {}),
      });
      expect(sent().notification.body).toBe(longNote);
      expect(sent().data).toEqual({ notificationKey: 't.k' });
    });
  });
});
