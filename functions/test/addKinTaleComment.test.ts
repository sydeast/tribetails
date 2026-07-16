import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

import { addKinTaleCommentHandler } from '../src/portal/kinTaleEngagement';

function req(data: unknown, uid = 'u1', admin = false): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: admin ? ({ admin: true } as any) : ({} as any) },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('addKinTaleComment', () => {
  it('HAPPY kinfolk top-level: writes with authorRole=kinfolk and null parentCommentId', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addKinTaleCommentHandler(req({ taleId: 't1', body: 'nice tale!' }));
    expect(res.commentId).toMatch(/^auto-/);
    const add = ctx.adds.find((a) => a.collection.endsWith('/comments'));
    expect(add).toBeDefined();
    expect(add?.data.authorRole).toBe('kinfolk');
    expect(add?.data.parentCommentId).toBeNull();
    expect(add?.data.body).toBe('nice tale!');
  });

  it('HAPPY kinfolk reply: writes with parentCommentId set', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body' },
        'kin_care_reports/t1/comments/parentC': { body: 'parent' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addKinTaleCommentHandler(
      req({ taleId: 't1', body: 'replying', parentCommentId: 'parentC' }),
    );
    expect(res.commentId).toMatch(/^auto-/);
    const add = ctx.adds.find((a) => a.collection.endsWith('/comments'));
    expect(add?.data.parentCommentId).toBe('parentC');
  });

  it('SAD kinfolk reply to missing parent: throws not-found', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addKinTaleCommentHandler(
        req({ taleId: 't1', body: 'orphan reply', parentCommentId: 'ghost' }),
      ),
    ).rejects.toThrow();
  });

  it('HAPPY admin: writes with authorRole=admin (kinfolkId required, clients/{uid} not read)', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body' },
        // No clients/admin1 doc — admin path must skip that lookup.
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addKinTaleCommentHandler(
      req({ kinfolkId: 'f1', taleId: 't1', body: 'admin reply' }, 'admin1', true),
    );
    expect(res.commentId).toMatch(/^auto-/);
    const add = ctx.adds.find((a) => a.collection.endsWith('/comments'));
    expect(add?.data.authorRole).toBe('admin');
  });

  it('SAD admin without kinfolkId: throws invalid-argument', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addKinTaleCommentHandler(req({ taleId: 't1', body: 'hello' }, 'admin1', true)),
    ).rejects.toThrow();
  });

  it('SAD unauthenticated: throws unauthenticated', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addKinTaleCommentHandler({ data: { taleId: 't1', body: 'hi' } } as CallableRequest<unknown>),
    ).rejects.toThrow();
  });

  it('strips a script tag from the comment body before writing', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await addKinTaleCommentHandler(
      req({ taleId: 't1', body: 'nice tale <script>alert(1)</script>!' }),
    );
    const add = ctx.adds.find((a) => a.collection.endsWith('/comments'));
    expect(add?.data.body).toBe('nice tale !');
  });

  it('SAD body that is only markup (empty after sanitizing) rejected', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, 'kin_care_reports/t1': { kinfolkId: 'f1' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addKinTaleCommentHandler(req({ taleId: 't1', body: '<script>alert(1)</script>' })),
    ).rejects.toThrow();
  });

  it('SAD whitespace-only body rejected by zod', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, 'kin_care_reports/t1': { kinfolkId: 'f1' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addKinTaleCommentHandler(req({ taleId: 't1', body: '   ' })),
    ).rejects.toThrow();
  });

  it('SAD kinfolk has no tribe linkage: throws failed-precondition', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: [] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addKinTaleCommentHandler(req({ taleId: 't1', body: 'hi' })),
    ).rejects.toThrow();
  });

  it('emits CONTENT_KINTALE_COMMENT_POSTED audit on successful kinfolk comment', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await addKinTaleCommentHandler(req({ taleId: 't1', body: 'audit test' }));
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CONTENT_KINTALE_COMMENT_POSTED',
        actorRole: 'PRIMARY',
        actorUid: 'u1',
      }),
    );
  });

  it('emits CONTENT_KINTALE_COMMENT_POSTED with actorRole=AUNTIE for admin', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'tale body' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await addKinTaleCommentHandler(
      req({ kinfolkId: 'f1', taleId: 't1', body: 'admin' }, 'admin1', true),
    );
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CONTENT_KINTALE_COMMENT_POSTED',
        actorRole: 'AUNTIE',
        actorUid: 'admin1',
      }),
    );
  });

});
