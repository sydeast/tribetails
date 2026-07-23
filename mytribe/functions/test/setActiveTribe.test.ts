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

function req(data: unknown, uid = 'u1', token: Record<string, unknown> = {}): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: token as any },
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

    expect(res).toEqual({ ok: true, kinfolkId: 'b', claimReminted: true });
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

  // ── Operator stepping into a household that is not theirs ────────────────
  // This used to throw permission-denied, and the portal caught that throw into
  // a console.warn, so every operator tribe switch logged a swallowed error.

  it('lets an operator view a foreign household instead of throwing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op1': { kinfolkIds: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setActiveTribeHandler(req({ kinfolkId: 'someone-else' }, 'op1', { admin: true }));

    expect(res).toEqual({ ok: true, kinfolkId: 'someone-else', claimReminted: false });
  });

  it('does NOT write or re-mint for the operator view', async () => {
    // Both omissions are load-bearing, not laziness. syncKinfolkClaim
    // re-validates activeKinfolkId against the caller's OWN kinfolkIds and would
    // fall back to kinfolkIds[0], so the write buys nothing; and its
    // `kinfolk/{activeId}.uid = uid` back-write would overwrite the real
    // kinfolk's uid on their own doc, breaking push targeting for that
    // household.
    const ctx = buildDbMock({ docs: { 'clients/op1': { kinfolkIds: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await setActiveTribeHandler(req({ kinfolkId: 'someone-else' }, 'op1', { admin: true }));

    expect(ctx.writes).toHaveLength(0);
    expect(mocks.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('still rejects a NON-operator asking for a foreign household', async () => {
    // The operator branch must not become a hole for an ordinary kinfolk.
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      setActiveTribeHandler(req({ kinfolkId: 'someone-else' }, 'u1', { admin: false })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('takes the normal path when an operator picks a household they DO own', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op1': { kinfolkIds: ['a', 'b'], activeKinfolkId: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setActiveTribeHandler(req({ kinfolkId: 'b' }, 'op1', { admin: true }));

    expect(res).toEqual({ ok: true, kinfolkId: 'b', claimReminted: true });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('op1', { role: 'kinfolk', kinfolkId: 'b' });
  });
});
