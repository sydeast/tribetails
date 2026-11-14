import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #1874: a reply from the office raises one notice on the household's
 * notifications list. Found on the Nov 10 walk: the reply showed on the portal
 * Messages page, and the bell and the notifications list never moved.
 *
 * Over the REAL dispatcher, so a notice here is a `notifications/` record the
 * household's list shows, and the send gate and their preferences decide.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      ...(actual.FieldValue as object),
      serverTimestamp: () => '__TS__',
      arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }),
      increment: (n: number) => ({ __increment: n }),
    },
  };
});

import { replyToConversationHandler } from '../src/admin/conversations';

const NOW = Date.UTC(2026, 10, 10, 17, 30, 0);
let ctx: ReturnType<typeof buildDbMock>;

function seed(docs: Record<string, Record<string, unknown> | null> = {}) {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      'kinfolk/kf1': { firstName: 'Dre', lastName: 'East', uid: 'uid_kinfolk' },
      'families/kf1': { displayName: 'Dre East' },
      'families/kf1/members/uid_kinfolk': { role: 'PRIMARY', status: 'ACTIVE' },
      'clients/uid_kinfolk': { displayName: 'Dre' },
      ...docs,
    },
  });
  mocks.dbFn.mockReset().mockReturnValue(ctx.db);
}

function reply(body = 'Thanks, see you Tuesday!') {
  return replyToConversationHandler({
    data: { kinfolkId: 'kf1', body },
    auth: { uid: 'admin1', token: { admin: true } },
  } as unknown as CallableRequest<unknown>);
}

const householdNotices = () =>
  ctx.writes.filter((w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.logEventFn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#1874 a reply from the office tells the household', () => {
  it('raises one notice on their notifications list, pointing at Messages', async () => {
    seed();
    const res = await reply();

    expect(res).toMatchObject({ ok: true, kinfolkId: 'kf1' });
    expect(householdNotices()).toHaveLength(1);
    expect(householdNotices()[0]?.data).toMatchObject({
      key: 'message.reply',
      targetType: 'conversation',
      targetId: 'kf1',
      // The row the household reads on their notifications list: the
      // catalog's household words (#2093), "your Auntie" with no business name set.
      title: 'New message from your Auntie',
      description: 'When your Auntie writes to you in Messages.',
    });
  });

  it('two replies are two notices, even a minute apart', async () => {
    seed();
    await reply('First');
    vi.setSystemTime(NOW + 60_000);
    await reply('Second');
    expect(householdNotices()).toHaveLength(2);
  });

  it('the household send gate off sends nothing, and the reply is still saved', async () => {
    seed({ [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } });
    const res = await reply();
    expect(res.ok).toBe(true);
    expect(householdNotices()).toHaveLength(0);
    expect(ctx.writes.some((w) => w.path.startsWith('conversations/kf1/messages/'))).toBe(true);
  });

  it('a household with no portal account gets no notice, and the reply is still saved', async () => {
    seed({ 'kinfolk/kf1': { firstName: 'Dre', lastName: 'East', uid: '' }, 'families/kf1/members/uid_kinfolk': null });
    const res = await reply();
    expect(res.ok).toBe(true);
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/') && w.data.key === 'message.reply')).toHaveLength(0);
  });

  it('a notice that cannot be sent never fails the reply', async () => {
    seed();
    const realCollection = ctx.db.collection.bind(ctx.db);
    vi.spyOn(ctx.db, 'collection').mockImplementation(((name: string) => {
      if (name === 'notifications') throw new Error('dispatcher down');
      return realCollection(name);
    }) as never);
    await expect(reply()).resolves.toMatchObject({ ok: true });
    expect(mocks.logEventFn).toHaveBeenCalledWith(
      expect.objectContaining({ function: 'replyToConversation', event: 'notification.dispatch.failed' }),
    );
  });
});
