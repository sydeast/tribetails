import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveKinfolkAccess: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkAccess', () => ({ resolveKinfolkAccess: mocks.resolveKinfolkAccess }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }),
    },
  };
});

import { previewOf, markMessagesRead } from '../src/lib/conversations';
import {
  sendKinfolkMessageHandler,
  getMyConversationHandler,
  markThreadReadHandler,
} from '../src/portal/sendKinfolkMessage';
import {
  listConversationsHandler,
  getConversationThreadHandler,
  replyToConversationHandler,
  markConversationReadHandler,
} from '../src/admin/conversations';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
  mocks.resolveKinfolkAccess.mockReset().mockResolvedValue({ kinfolkId: 'kf1', isOperator: false });
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'u1', admin = true): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

describe('previewOf', () => {
  it('collapses whitespace + truncates long bodies', () => {
    expect(previewOf('hello   world\n\nthere')).toBe('hello world there');
    expect(previewOf('x'.repeat(200)).length).toBe(140);
    expect(previewOf('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('sendKinfolkMessage (portal)', () => {
  it('appends a kinfolk message, sets unreadForAdmin, audits', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendKinfolkMessageHandler(req({ body: 'Hi auntie' }));
    expect(res.ok).toBe(true);
    expect(res.kinfolkId).toBe('kf1');
    // message written under the thread
    const msg = ctx.writes.find((w) => w.path.startsWith('conversations/kf1/messages/'));
    expect(msg?.data.senderRole).toBe('kinfolk');
    expect(msg?.data.body).toBe('Hi auntie');
    expect(typeof msg?.data.deliveredAt).toBe('number');
    expect(msg?.data.readAt).toBeNull();
    // summary set with unreadForAdmin true + name resolved
    const summary = ctx.writes.find((w) => w.path === 'conversations/kf1');
    expect(summary?.data.unreadForAdmin).toBe(true);
    expect(summary?.data.unreadForKinfolk).toBe(false);
    expect(summary?.data.kinfolkName).toBe('Jane Doe');
    expect(summary?.data.lastSenderRole).toBe('kinfolk');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'CONVERSATION_MESSAGE_SENT' }));
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(sendKinfolkMessageHandler(req({ body: 'x' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects empty body', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(sendKinfolkMessageHandler(req({ body: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('cannot reach another household (resolveKinfolkAccess throws)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    mocks.resolveKinfolkAccess.mockRejectedValueOnce(Object.assign(new Error('No access.'), { code: 'permission-denied' }));
    await expect(sendKinfolkMessageHandler(req({ kinfolkId: 'other', body: 'x' }))).rejects.toBeTruthy();
  });

  it('strips injected markup from the message body before writing and previewing', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendKinfolkMessageHandler(req({ body: '<img src=x onerror="evil()">See you at 3pm' }));
    const msg = ctx.writes.find((w) => w.path.startsWith('conversations/kf1/messages/'));
    expect(msg?.data.body).toBe('See you at 3pm');
    const summary = ctx.writes.find((w) => w.path === 'conversations/kf1');
    expect(summary?.data.lastMessagePreview).toBe('See you at 3pm');
  });

  it('rejects a body that is only markup (empty after sanitizing)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      sendKinfolkMessageHandler(req({ body: '<script>alert(1)</script>' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

// CRITICAL-4: sendKinfolkMessage must enforce messaging_direct. resolveKinfolkAccess
// is mocked to 'kf1', so the gate reads families/kf1/members/u1 via the real db mock.
describe('sendKinfolkMessage CRITICAL-4 permission gate (messaging_direct)', () => {
  const KINTALES_ONLY_MEMBER = {
    role: 'SECONDARY',
    status: 'ACTIVE',
    permissions: {
      billing_full: false,
      messaging_direct: false,
      messaging_group: false,
      kin_edit: false,
      kintales_only: true,
    },
  };
  const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };

  it('DENIES a kintales_only secondary and writes no message', async () => {
    const ctx = buildDbMock({
      docs: {
        'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' },
        'families/kf1/members/u1': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    // admin:false — RULING O-6's isStaff bypass now checks the real claim, so
    // this must be a genuine non-staff caller to actually exercise the
    // member-permission denial being tested here.
    await expect(sendKinfolkMessageHandler(req({ body: 'Hi auntie' }, 'u1', false))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(ctx.writes.find((w) => w.path.startsWith('conversations/kf1/messages/'))).toBeUndefined();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('ALLOWS a PRIMARY member', async () => {
    const ctx = buildDbMock({
      docs: {
        'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' },
        'families/kf1/members/u1': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendKinfolkMessageHandler(req({ body: 'Hi auntie' }, 'u1', false));
    expect(res.ok).toBe(true);
    expect(ctx.writes.find((w) => w.path.startsWith('conversations/kf1/messages/'))).toBeDefined();
  });

  it('ALLOWS legacy (no member doc)', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendKinfolkMessageHandler(req({ body: 'Hi auntie' }, 'u1', false));
    expect(res.ok).toBe(true);
  });

  it('ALLOWS an operator (bypass, no member doc)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendKinfolkMessageHandler(req({ body: 'Hi auntie' }, 'op-uid'));
    expect(res.ok).toBe(true);
  });
});

// CRITICAL-4 (audit fidelity): the audit entry must label the real sender, not a
// hardcoded PRIMARY. A messaging_direct secondary -> SECONDARY, operator -> AUNTIE,
// legacy primary -> PRIMARY.
describe('sendKinfolkMessage audit actorRole reflects the real sender', () => {
  const MESSAGING_SECONDARY = {
    role: 'SECONDARY',
    status: 'ACTIVE',
    permissions: {
      billing_full: false,
      messaging_direct: true,
      messaging_group: false,
      kin_edit: false,
      kintales_only: false,
    },
  };
  const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };

  it('audits a messaging_direct SECONDARY as SECONDARY', async () => {
    const ctx = buildDbMock({
      docs: {
        'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' },
        'families/kf1/members/u1': MESSAGING_SECONDARY,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    // RULING O-6: requireKinfolkPerm's staff-bypass now checks the REAL admin
    // claim (isStaff), not just the env allowlist — this test wants a genuine
    // non-staff kinfolk caller so it actually exercises the member-doc lookup
    // (and thus the SECONDARY labeling) instead of short-circuiting past it.
    const res = await sendKinfolkMessageHandler(req({ body: 'Hi auntie' }, 'u1', false));
    expect(res.ok).toBe(true);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CONVERSATION_MESSAGE_SENT', actorRole: 'SECONDARY' }),
    );
  });

  it('audits a PRIMARY member as PRIMARY', async () => {
    const ctx = buildDbMock({
      docs: {
        'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' },
        'families/kf1/members/u1': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendKinfolkMessageHandler(req({ body: 'Hi auntie' }, 'u1', false));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CONVERSATION_MESSAGE_SENT', actorRole: 'PRIMARY' }),
    );
  });

  it('audits a legacy send (no member doc) as PRIMARY', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendKinfolkMessageHandler(req({ body: 'Hi auntie' }, 'u1', false));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CONVERSATION_MESSAGE_SENT', actorRole: 'PRIMARY' }),
    );
  });

  it('audits an operator send as AUNTIE', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    mocks.resolveKinfolkAccess.mockResolvedValueOnce({ kinfolkId: 'kf1', isOperator: true });
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendKinfolkMessageHandler(req({ body: 'Hi auntie' }, 'op-uid'));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CONVERSATION_MESSAGE_SENT', actorRole: 'AUNTIE' }),
    );
  });
});

describe('getMyConversation (portal)', () => {
  it('returns messages oldest-first and clears kinfolk unread', async () => {
    const ctx = buildDbMock({
      docs: { 'conversations/kf1': { unreadForKinfolk: true } },
      queryDocs: {
        // Every message doc is created with an explicit `readAt: null`
        // (conversations.ts:80). Omitting it here would put the fixture outside
        // the `.where('readAt','==',null)` index, so markMessagesRead would
        // match nothing and this test would pass through its fallback branch.
        'conversations/kf1/messages': [
          { id: 'm2', data: { senderRole: 'auntie', body: 'second', createdAtMs: 200, readAt: null } },
          { id: 'm1', data: { senderRole: 'kinfolk', body: 'first', createdAtMs: 100, readAt: null } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getMyConversationHandler(req({}));
    expect(res.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    const cleared = ctx.writes.find((w) => w.path === 'conversations/kf1');
    expect(cleared?.data.unreadForKinfolk).toBe(false);
  });
});

describe('listConversations (admin)', () => {
  it('returns conversations newest-first', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        conversations: [
          { id: 'a', data: { kinfolkName: 'A', lastMessageAtMs: 10, unreadForAdmin: false } },
          { id: 'b', data: { kinfolkName: 'B', lastMessageAtMs: 20, unreadForAdmin: true } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listConversationsHandler(req({}));
    expect(res.conversations.map((c) => c.kinfolkId)).toEqual(['b', 'a']);
    expect(res.conversations[0].unreadForAdmin).toBe(true);
  });
});

describe('getConversationThread (admin)', () => {
  it('returns the thread and clears admin unread', async () => {
    const ctx = buildDbMock({
      docs: { 'conversations/kf1': { unreadForAdmin: true } },
      queryDocs: {
        'conversations/kf1/messages': [
          { id: 'm1', data: { senderRole: 'kinfolk', body: 'hi', createdAtMs: 1, readAt: null } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getConversationThreadHandler(req({ kinfolkId: 'kf1' }));
    expect(res.messages.length).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'conversations/kf1')?.data.unreadForAdmin).toBe(false);
  });
});

describe('replyToConversation (admin)', () => {
  it('appends an auntie reply and sets unreadForKinfolk', async () => {
    const ctx = buildDbMock({ docs: { 'conversations/kf1': { kinfolkName: 'Jane Doe', messageCount: 2 } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await replyToConversationHandler(req({ kinfolkId: 'kf1', body: 'Thanks!' }));
    expect(res.ok).toBe(true);
    const msg = ctx.writes.find((w) => w.path.startsWith('conversations/kf1/messages/'));
    expect(msg?.data.senderRole).toBe('auntie');
    const summary = ctx.writes.find((w) => w.path === 'conversations/kf1');
    expect(summary?.data.unreadForKinfolk).toBe(true);
    expect(summary?.data.unreadForAdmin).toBe(false);
    expect(summary?.data.messageCount).toBe(3);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'CONVERSATION_REPLIED' }));
  });

  it('falls back to the kinfolk doc name when no thread exists yet', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'New', lastName: 'Client' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await replyToConversationHandler(req({ kinfolkId: 'kf1', body: 'Welcome' }));
    const summary = ctx.writes.find((w) => w.path === 'conversations/kf1');
    expect(summary?.data.kinfolkName).toBe('New Client');
    expect(summary?.data.messageCount).toBe(1); // created fresh
  });

  it('rejects empty body', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(replyToConversationHandler(req({ kinfolkId: 'kf1', body: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('strips injected markup from an auntie reply body', async () => {
    const ctx = buildDbMock({ docs: { 'conversations/kf1': { kinfolkName: 'Jane Doe', messageCount: 2 } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await replyToConversationHandler(req({ kinfolkId: 'kf1', body: '<script>alert(1)</script>Thanks!' }));
    const msg = ctx.writes.find((w) => w.path.startsWith('conversations/kf1/messages/'));
    expect(msg?.data.body).toBe('Thanks!');
  });
});

describe('markConversationRead (admin)', () => {
  it('clears unreadForAdmin', async () => {
    const ctx = buildDbMock({ docs: { 'conversations/kf1': { unreadForAdmin: true } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markConversationReadHandler(req({ kinfolkId: 'kf1' }));
    expect(res.ok).toBe(true);
    expect(ctx.writes.find((w) => w.path === 'conversations/kf1')?.data.unreadForAdmin).toBe(false);
  });

  it('throws not-found for a missing thread', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(markConversationReadHandler(req({ kinfolkId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('stamps readAt on the unread kinfolk messages the where() clause matched', async () => {
    // The double now applies
    // `.where('senderRole','==','kinfolk').where('readAt','==',null)` for real,
    // so the fixture is the raw subcollection and the filter picks the match.
    // The admin is reading, so kinfolk-authored unread messages are the target.
    const ctx = buildDbMock({
      docs: { 'conversations/kf1': { unreadForAdmin: true } },
      queryDocs: {
        'conversations/kf1/messages': [{ id: 'm1', data: { senderRole: 'kinfolk', readAt: null } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await markConversationReadHandler(req({ kinfolkId: 'kf1' }));
    expect(ctx.writes.find((w) => w.path === 'conversations/kf1/messages/m1')?.data.readAt).toEqual(
      expect.any(Number),
    );
  });
});

describe('markMessagesRead (lib)', () => {
  it('stamps readAt on every unread message from the other side and clears the flag', async () => {
    const ctx = buildDbMock({
      docs: { 'conversations/kf1': { unreadForKinfolk: true } },
      queryDocs: {
        'conversations/kf1/messages': [
          { id: 'm1', data: { senderRole: 'auntie', readAt: null } },
          { id: 'm2', data: { senderRole: 'auntie', readAt: null } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const count = await markMessagesRead('kf1', 'kinfolk');
    expect(count).toBe(2);
    expect(ctx.writes.find((w) => w.path === 'conversations/kf1/messages/m1')?.data.readAt).toEqual(
      expect.any(Number),
    );
    expect(ctx.writes.find((w) => w.path === 'conversations/kf1/messages/m2')?.data.readAt).toEqual(
      expect.any(Number),
    );
    expect(ctx.writes.find((w) => w.path === 'conversations/kf1')?.data.unreadForKinfolk).toBe(false);
  });

  it('is a clean no-op when there is nothing unread (and no thread yet)', async () => {
    const ctx = buildDbMock({ queryDocs: { 'conversations/kf1/messages': [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const count = await markMessagesRead('kf1', 'kinfolk');
    expect(count).toBe(0);
    expect(ctx.writes.length).toBe(0);
  });

  it('still clears a stale unread flag even if every message already has readAt', async () => {
    const ctx = buildDbMock({
      docs: { 'conversations/kf1': { unreadForKinfolk: true } },
      queryDocs: { 'conversations/kf1/messages': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await markMessagesRead('kf1', 'kinfolk');
    expect(ctx.writes.find((w) => w.path === 'conversations/kf1')?.data.unreadForKinfolk).toBe(false);
  });
});

describe('markThreadRead (portal)', () => {
  it('marks unread auntie messages read for the caller\'s own thread', async () => {
    const ctx = buildDbMock({
      docs: { 'conversations/kf1': { unreadForKinfolk: true } },
      queryDocs: {
        'conversations/kf1/messages': [{ id: 'm1', data: { senderRole: 'auntie', readAt: null } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markThreadReadHandler(req({}));
    expect(res.ok).toBe(true);
    expect(res.kinfolkId).toBe('kf1');
    expect(res.markedCount).toBe(1);
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(markThreadReadHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
