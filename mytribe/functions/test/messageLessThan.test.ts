import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #1873 end to end on the write path: what the household or the Auntie typed
 * is what is stored, what the messages list previews and what the office's
 * new-message notice quotes. Same mocks as conversations.test.ts, plus the
 * notification dispatcher so the notice preview can be read.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveKinfolkAccess: vi.fn(), enqueueNotification: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkAccess', () => ({ resolveKinfolkAccess: mocks.resolveKinfolkAccess }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueueNotification }));
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

import { sendKinfolkMessageHandler } from '../src/portal/sendKinfolkMessage';
import { replyToConversationHandler } from '../src/admin/conversations';

beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
  mocks.resolveKinfolkAccess.mockReset().mockResolvedValue({ kinfolkId: 'kf1', isOperator: false });
  mocks.enqueueNotification.mockReset().mockResolvedValue(undefined);
});

function req(data: unknown, uid: string | null = 'u1', admin = true): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

function household() {
  const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'Jane', lastName: 'Doe' } } });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

function stored(ctx: ReturnType<typeof buildDbMock>) {
  const msg = ctx.writes.find((w) => w.path.startsWith('conversations/kf1/messages/'));
  const summary = ctx.writes.find((w) => w.path === 'conversations/kf1');
  return { body: msg?.data.body, preview: summary?.data.lastMessagePreview };
}

function noticePreview(): unknown {
  const call = mocks.enqueueNotification.mock.calls.find((c) => c[0]?.key === 'message.received');
  return call?.[0]?.data?.preview;
}

describe('sendKinfolkMessage keeps a message with a less-than sign whole (#1873)', () => {
  it('happy: the portal editor (signs sent as entities) stores, previews and notifies every word', async () => {
    const ctx = household();
    await sendKinfolkMessageHandler(
      req({ body: '<p>I think 5 &lt; 6 and &lt;y and z&gt; and <strong>bold</strong> four more words</p>' }),
    );
    const s = stored(ctx);
    expect(s.body).toBe('<p>I think 5 < 6 and <y and z> and <strong>bold</strong> four more words</p>');
    expect(s.preview).toBe('I think 5 < 6 and <y and z> and bold four more words');
    expect(noticePreview()).toBe('I think 5 < 6 and <y and z> and bold four more words');
  });

  it('happy: MyTribe Android (plain text) keeps a word between angle brackets', async () => {
    const ctx = household();
    await sendKinfolkMessageHandler(req({ body: 'write to Pawsome <pawsome@hanasamku.com> today' }));
    const s = stored(ctx);
    expect(s.body).toBe('write to Pawsome <pawsome@hanasamku.com> today');
    expect(s.preview).toBe('write to Pawsome <pawsome@hanasamku.com> today');
    expect(noticePreview()).toBe('write to Pawsome <pawsome@hanasamku.com> today');
  });

  it('negative: a typed script tag is kept as the text typed, never removed', async () => {
    const ctx = household();
    await sendKinfolkMessageHandler(req({ body: '<p>&lt;script&gt;alert(1)&lt;/script&gt; is what I saw</p>' }));
    expect(stored(ctx).body).toBe('<p><script>alert(1)</script> is what I saw</p>');
    expect(stored(ctx).preview).toBe('<script>alert(1)</script> is what I saw');
  });

  it('sad: a body with no words at all is refused', async () => {
    household();
    await expect(sendKinfolkMessageHandler(req({ body: '<p><br></p>' }))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'message_body_empty',
    });
  });
});

describe('replyToConversation keeps an Auntie reply with a less-than sign whole (#1873)', () => {
  it('happy: a plain reply keeps a word between angle brackets and a script-like word', async () => {
    const ctx = buildDbMock({ docs: { 'conversations/kf1': { kinfolkName: 'Jane Doe', messageCount: 2 } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await replyToConversationHandler(req({ kinfolkId: 'kf1', body: 'use the <side gate> and ignore <script> 2 < 3' }));
    const s = stored(ctx);
    expect(s.body).toBe('use the <side gate> and ignore <script> 2 < 3');
    expect(s.preview).toBe('use the <side gate> and ignore <script> 2 < 3');
  });
});
