import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => mocks.dbFn.mockReset());

import { getKinTaleReactionHandler, toggleKinTaleLoveHandler } from '../src/portal/kinTaleEngagement';

function req(data: unknown, uid = 'u1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: {} as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const TALE_PATH = 'kin_care_reports/t1';
const REACTIONS_PATH = 'kin_care_reports/t1/reactions';

describe('getKinTaleReactionHandler', () => {
  it('rejects unauthenticated', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getKinTaleReactionHandler({ data: { taleId: 't1' } } as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('404s when the tale does not exist', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['f1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getKinTaleReactionHandler(req({ taleId: 'ghost' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('returns loved=false, loveCount=0 when nobody has reacted', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [TALE_PATH]: { kinfolkId: 'f1' } },
      queryDocs: { [REACTIONS_PATH]: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getKinTaleReactionHandler(req({ taleId: 't1' }));
    expect(res).toEqual({ loved: false, loveCount: 0 });
  });

  it('returns loved=true when the caller already reacted, counting all reactors', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [TALE_PATH]: { kinfolkId: 'f1' },
        [`${REACTIONS_PATH}/u1`]: { createdAtMs: 100 },
      },
      queryDocs: { [REACTIONS_PATH]: [{ id: 'u1', data: {} }, { id: 'u2', data: {} }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getKinTaleReactionHandler(req({ taleId: 't1' }));
    expect(res).toEqual({ loved: true, loveCount: 2 });
  });

  it('rejects a supplied kinfolkId that does not match the tale (RULING O-6: derived, never trusted)', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [TALE_PATH]: { kinfolkId: 'f1' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getKinTaleReactionHandler(req({ taleId: 't1', kinfolkId: 'other' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('existence-oracle fix: a non-member gets not-found (not invalid-argument) whether or not their guessed kinfolkId matches the real one', async () => {
    // u2 has no linkage to f1 at all — this simulates an attacker who only
    // knows a valid taleId and is probing which household owns it.
    const ctx = buildDbMock({
      docs: { 'clients/u2': { kinfolkIds: [] }, [TALE_PATH]: { kinfolkId: 'f1' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getKinTaleReactionHandler(req({ taleId: 't1', kinfolkId: 'f1' }, 'u2')),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      getKinTaleReactionHandler(req({ taleId: 't1', kinfolkId: 'guessed-wrong' }, 'u2')),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('toggleKinTaleLoveHandler', () => {
  it('rejects unauthenticated', async () => {
    await expect(
      toggleKinTaleLoveHandler({ data: { taleId: 't1' } } as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('404s when the tale does not exist', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['f1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      toggleKinTaleLoveHandler(req({ taleId: 'ghost' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('reacts (love) when the caller has not reacted yet: creates the doc, count goes 0 -> 1', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [TALE_PATH]: { kinfolkId: 'f1' } },
      // BEFORE state: no existing u1 reaction doc, nobody has reacted yet.
      queryDocs: { [REACTIONS_PATH]: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await toggleKinTaleLoveHandler(req({ taleId: 't1' }));
    expect(res).toEqual({ loved: true, loveCount: 1 });
    const write = ctx.writes.find((w) => w.path === `${REACTIONS_PATH}/u1`);
    expect(write).toBeDefined();
    expect(write!.data.createdAtMs).toBeTypeOf('number');
  });

  it('un-reacts (unlove) when the caller already reacted: deletes the doc, count goes 1 -> 0', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [TALE_PATH]: { kinfolkId: 'f1' },
        [`${REACTIONS_PATH}/u1`]: { createdAtMs: 100 },
      },
      // BEFORE state: only u1 has reacted so far.
      queryDocs: { [REACTIONS_PATH]: [{ id: 'u1', data: {} }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await toggleKinTaleLoveHandler(req({ taleId: 't1' }));
    expect(res).toEqual({ loved: false, loveCount: 0 });
    expect(ctx.deletes).toContain(`${REACTIONS_PATH}/u1`);
  });

  it('un-reacts when others have also reacted: count drops by exactly one', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [TALE_PATH]: { kinfolkId: 'f1' },
        [`${REACTIONS_PATH}/u1`]: { createdAtMs: 100 },
      },
      queryDocs: { [REACTIONS_PATH]: [{ id: 'u1', data: {} }, { id: 'u2', data: {} }, { id: 'u3', data: {} }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await toggleKinTaleLoveHandler(req({ taleId: 't1' }));
    expect(res).toEqual({ loved: false, loveCount: 2 });
  });

  it('rejects a supplied kinfolkId that does not match the tale (RULING O-6: derived, never trusted)', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [TALE_PATH]: { kinfolkId: 'f1' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      toggleKinTaleLoveHandler(req({ taleId: 't1', kinfolkId: 'other' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD kinfolk has no tribe linkage: throws not-found (existence oracle avoided)', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: [] }, [TALE_PATH]: { kinfolkId: 'f1' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      toggleKinTaleLoveHandler(req({ taleId: 't1' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
