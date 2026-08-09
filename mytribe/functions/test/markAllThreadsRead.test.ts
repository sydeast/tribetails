import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
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

import {
  markAllThreadsReadHandler,
  MAX_THREADS_PER_BULK_READ,
} from '../src/admin/markAllThreadsRead';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'u1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

/**
 * A conversations fixture with `unread` unread threads and `read` already-read
 * ones. Each unread thread also carries one unread kinfolk message, because
 * clearing the SUMMARY flag without stamping `readAt` on the messages would
 * make "read" mean two different things depending on which surface asked.
 */
function fixture(unread: string[], read: string[] = []) {
  const docs: Record<string, Record<string, unknown> | null> = {};
  const queryDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {
    conversations: [
      ...unread.map((id) => ({ id, data: { kinfolkId: id, kinfolkName: id, unreadForAdmin: true } })),
      ...read.map((id) => ({ id, data: { kinfolkId: id, kinfolkName: id, unreadForAdmin: false } })),
    ],
  };
  for (const id of [...unread, ...read]) {
    docs[`conversations/${id}`] = { kinfolkId: id, unreadForAdmin: unread.includes(id) };
    queryDocs[`conversations/${id}/messages`] = unread.includes(id)
      ? [{ id: `m-${id}`, data: { senderRole: 'kinfolk', readAt: null, createdAtMs: 1 } }]
      : [];
  }
  return buildDbMock({ docs, queryDocs });
}

describe('markAllThreadsRead', () => {
  it('clears every thread waiting on the admin and reports how many', async () => {
    const ctx = fixture(['kf1', 'kf2', 'kf3']);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await markAllThreadsReadHandler(req({}));

    expect(res).toEqual({ ok: true, cleared: 3 });
    for (const id of ['kf1', 'kf2', 'kf3']) {
      const summary = ctx.writes.find((w) => w.path === `conversations/${id}`);
      expect(summary?.data.unreadForAdmin).toBe(false);
      // The kinfolk message is stamped read too, the same thing opening the
      // thread does (markMessagesRead), so `readAt` never lies.
      expect(ctx.writes.find((w) => w.path === `conversations/${id}/messages/m-${id}`)?.data.readAt)
        .toEqual(expect.any(Number));
    }
  });

  it('never touches a thread that was already answered', async () => {
    const ctx = fixture(['kf1'], ['kf-answered']);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await markAllThreadsReadHandler(req({}));

    expect(res.cleared).toBe(1);
    expect(ctx.writes.some((w) => w.path.startsWith('conversations/kf-answered'))).toBe(false);
  });

  it('reports zero, not a failure, when nothing is unread', async () => {
    const ctx = fixture([], ['kf-answered']);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await markAllThreadsReadHandler(req({}));

    expect(res).toEqual({ ok: true, cleared: 0 });
    expect(ctx.writes).toEqual([]);
    // Nothing happened, so nothing is audited.
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('reads unreadForAdmin as a stored BOOLEAN: a numeric 1 is not a match', async () => {
    // The field is written as `senderRole === 'kinfolk'` (lib/conversations.ts),
    // so it is always a boolean. A `> 0` or truthiness predicate would pick up
    // this hand-written row; `== true` correctly does not.
    const ctx = buildDbMock({
      queryDocs: { conversations: [{ id: 'kf-numeric', data: { unreadForAdmin: 1 } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await markAllThreadsReadHandler(req({}));

    expect(res.cleared).toBe(0);
    expect(ctx.writes).toEqual([]);
  });

  it('audits the bulk clear with the count it actually made', async () => {
    const ctx = fixture(['kf1', 'kf2']);
    mocks.dbFn.mockReturnValue(ctx.db);

    await markAllThreadsReadHandler(req({}));

    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CONVERSATIONS_BULK_READ',
        actorUid: 'u1',
        payload: expect.objectContaining({ cleared: 2 }),
      }),
    );
  });

  it('bounds one call so a huge backlog cannot run past the callable timeout', async () => {
    const ids = Array.from({ length: MAX_THREADS_PER_BULK_READ + 5 }, (_, i) => `kf${i}`);
    const ctx = fixture(ids);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await markAllThreadsReadHandler(req({}));

    expect(res.cleared).toBe(MAX_THREADS_PER_BULK_READ);
  });

  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(markAllThreadsReadHandler(req({}, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('accepts a call with no argument at all (the client sends none)', async () => {
    const ctx = fixture(['kf1']);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markAllThreadsReadHandler(req(undefined))).resolves.toMatchObject({ cleared: 1 });
  });

  it('rejects an unexpected argument rather than silently ignoring it', async () => {
    mocks.dbFn.mockReturnValue(fixture(['kf1']).db);
    await expect(markAllThreadsReadHandler(req({ kinfolkId: 'kf1' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('fails loud when a thread write fails, naming how many had been cleared', async () => {
    const ctx = fixture(['kf1']);
    mocks.dbFn.mockReturnValue(ctx.db);
    const realBatch = ctx.db.batch;
    ctx.db.batch = () => {
      const b = realBatch();
      b.commit = vi.fn(async () => {
        throw new Error('DEADLINE_EXCEEDED');
      });
      return b;
    };

    await expect(markAllThreadsReadHandler(req({}))).rejects.toMatchObject({ code: 'internal' });
  });
});
