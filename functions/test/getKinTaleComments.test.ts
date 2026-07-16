import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

import { getKinTaleCommentsHandler } from '../src/portal/getKinTaleComments';

function req(data: unknown, uid: string | null = 'u1', admin = false): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? { uid, token: admin ? ({ admin: true } as any) : ({} as any) } : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

// RULING O-6, Q2: kinfolkId is now DERIVED from the kin_care_reports/{taleId}
// doc itself, never trusted from the client — see resolveKinTaleAccess.ts.
describe('getKinTaleComments', () => {
  it('HAPPY admin WITH a matching kinfolkId: returns comments ordered asc incl a guest row', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/t1': { kinfolkId: 'f1' } },
      queryDocs: {
        'kin_care_reports/t1/comments': [
          { id: 'c1', data: { authorRole: 'kinfolk', authorUid: 'k1', body: 'first', createdAtMs: 100 } },
          { id: 'c2', data: { authorRole: 'admin', authorUid: 'a1', body: 'reply', parentCommentId: 'c1', createdAtMs: 200 } },
          { id: 'c3', data: { authorRole: 'guest', authorUid: null, guestName: 'Pat', body: 'guest hi', createdAtMs: 300 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getKinTaleCommentsHandler(req({ kinfolkId: 'f1', taleId: 't1' }, 'admin1', true));
    expect(res.comments).toHaveLength(3);
    expect(res.comments[0]).toMatchObject({ id: 'c1', authorRole: 'kinfolk', body: 'first', parentCommentId: null });
    expect(res.comments[1]).toMatchObject({ id: 'c2', authorRole: 'admin', parentCommentId: 'c1' });
    expect(res.comments[2]).toMatchObject({ id: 'c3', authorRole: 'guest', guestName: 'Pat', authorUid: null });
  });

  it('HAPPY kinfolk (non-staff member) path: kinfolkId derived from the tale, no arg needed', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_reports/t1': { kinfolkId: 'f1' },
        'clients/kin1': { kinfolkIds: ['f1'] },
      },
      queryDocs: {
        'kin_care_reports/t1/comments': [
          { id: 'c1', data: { authorRole: 'kinfolk', body: 'hi', createdAtMs: 10 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getKinTaleCommentsHandler(req({ taleId: 't1' }, 'kin1', false));
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0]).toMatchObject({ id: 'c1', body: 'hi' });
  });

  it('NEW CAPABILITY (closes CWE-863 split): admin WITHOUT a kinfolkId arg now succeeds', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/t1': { kinfolkId: 'f1' } },
      queryDocs: { 'kin_care_reports/t1/comments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getKinTaleCommentsHandler(req({ taleId: 't1' }, 'admin1', true));
    expect(res.comments).toEqual([]);
  });

  it('ERROR admin with a MISMATCHED kinfolkId: throws invalid-argument (never trusted as authority)', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/t1': { kinfolkId: 'f1' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getKinTaleCommentsHandler(req({ kinfolkId: 'WRONG', taleId: 't1' }, 'admin1', true)),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('ERROR non-member non-staff caller: throws not-found (existence oracle avoided)', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_reports/t1': { kinfolkId: 'f1' },
        'clients/kin1': { kinfolkIds: ['some-other-household'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getKinTaleCommentsHandler(req({ taleId: 't1' }, 'kin1', false)),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('ERROR tale does not exist: throws not-found', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_reports/t1': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getKinTaleCommentsHandler(req({ kinfolkId: 'f1', taleId: 't1' }, 'admin1', true)),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('ERROR unauthenticated: throws unauthenticated', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getKinTaleCommentsHandler(req({ taleId: 't1' }, null)),
    ).rejects.toThrow(/Sign-in required/);
  });

  it('HAPPY empty thread: returns empty array (not an error)', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/t1': { kinfolkId: 'f1' } },
      queryDocs: { 'kin_care_reports/t1/comments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getKinTaleCommentsHandler(req({ kinfolkId: 'f1', taleId: 't1' }, 'admin1', true));
    expect(res.comments).toEqual([]);
  });
});
