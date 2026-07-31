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

  it('throws when template missing required fields', async () => {
    const ctx = buildPushDbMock({ template: { title: 't' }, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendPushChannel({ def: def(), recipientUid: 'u1', data: {} }),
    ).rejects.toThrow(/requires title \+ body/);
  });
});
