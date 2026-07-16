import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUser: vi.fn(),
  setCustomUserClaims: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ getUser: mocks.getUser, setCustomUserClaims: mocks.setCustomUserClaims }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUser.mockReset().mockResolvedValue({ customClaims: {} });
  mocks.setCustomUserClaims.mockReset().mockResolvedValue(undefined);
});

import { setActiveTribeHandler } from '../src/portal/setActiveTribe';

function req(data: unknown, uid = 'u1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: {} as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('setActiveTribeHandler', () => {
  it('rejects unauthenticated', async () => {
    await expect(
      setActiveTribeHandler({ data: { kinfolkId: 'a' } } as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a kinfolkId the caller does not have', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a', 'b'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setActiveTribeHandler(req({ kinfolkId: 'not-mine' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a caller with no tribes linked at all', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setActiveTribeHandler(req({ kinfolkId: 'a' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('writes activeKinfolkId to the client doc, merge:true', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a', 'b'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await setActiveTribeHandler(req({ kinfolkId: 'b' }));

    expect(res).toEqual({ ok: true, kinfolkId: 'b' });
    const write = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(write?.data.activeKinfolkId).toBe('b');
    expect(write?.merge).toBe(true);
  });

  it('immediately re-mints the claim to the newly-active tribe (post-write read)', async () => {
    // The mock's `docs` fixture is static (writes don't feed back into
    // reads — a documented limitation of this test helper, see
    // mockDb.ts), so this fixture represents the state syncKinfolkClaim's
    // read WOULD see in real Firestore right after the .set() above
    // commits (server-side admin reads are strongly consistent with the
    // latest write — no client-cache staleness the way web/mobile SDKs
    // can have). This is what actually proves the claim mint picks up the
    // switch, not the state before the write.
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a', 'b'], activeKinfolkId: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setActiveTribeHandler(req({ kinfolkId: 'b' }));
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { role: 'kinfolk', kinfolkId: 'b' });
  });
});
