import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

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

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUser.mockReset().mockResolvedValue({ customClaims: {} });
  mocks.setCustomUserClaims.mockReset().mockResolvedValue(undefined);
});

import { syncKinfolkClaim } from '../src/lib/kinfolkClaim';

describe('syncKinfolkClaim', () => {
  it('mints the sole id when there is exactly one, with no activeKinfolkId set', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const result = await syncKinfolkClaim('u1');
    expect(result).toEqual({ kinfolkId: 'a' });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { role: 'kinfolk', kinfolkId: 'a' });
  });

  it('mints the sole id even when activeKinfolkId is stale (one id is not a choice)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a'], activeKinfolkId: 'revoked' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const result = await syncKinfolkClaim('u1');
    expect(result).toEqual({ kinfolkId: 'a' });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { role: 'kinfolk', kinfolkId: 'a' });
  });

  it('prefers activeKinfolkId over kinfolkIds[0] when it is one of the caller\'s own ids', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a', 'b'], activeKinfolkId: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const result = await syncKinfolkClaim('u1');
    expect(result).toEqual({ kinfolkId: 'b' });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { role: 'kinfolk', kinfolkId: 'b' });
  });

  it('mints NO kinfolk claim for 2+ ids with no activeKinfolkId, instead of designating kinfolkIds[0]', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a', 'b'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const result = await syncKinfolkClaim('u1');
    expect(result).toEqual({ kinfolkId: null });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', {});
  });

  it('mints NO kinfolk claim when activeKinfolkId names an id the client does not have', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a', 'b'], activeKinfolkId: 'revoked' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const result = await syncKinfolkClaim('u1');
    expect(result).toEqual({ kinfolkId: null });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', {});
  });

  it('CLEARS a previously minted claim when it refuses, rather than leaving the old one standing', async () => {
    // The revocation case: 'b' was the active household and has been taken away.
    // Leaving the stale claim in place would keep the revoked household readable.
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a', 'c'], activeKinfolkId: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getUser.mockResolvedValue({ customClaims: { role: 'kinfolk', kinfolkId: 'b', admin: true } });
    const result = await syncKinfolkClaim('u1');
    expect(result).toEqual({ kinfolkId: null });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { admin: true });
  });

  it('does not backwrite a uid onto any kinfolk doc when it refuses', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a', 'b'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await syncKinfolkClaim('u1');
    expect(ctx.writes.filter((w) => w.path.startsWith('kinfolk/'))).toEqual([]);
  });

  it('preserves an unrelated existing claim (e.g. admin) instead of replacing wholesale', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getUser.mockResolvedValue({ customClaims: { admin: true } });
    await syncKinfolkClaim('u1');
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { admin: true, role: 'kinfolk', kinfolkId: 'a' });
  });

  it('clears role+kinfolkId (but keeps other claims) when kinfolkIds is empty', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getUser.mockResolvedValue({ customClaims: { role: 'kinfolk', kinfolkId: 'stale', admin: true } });
    const result = await syncKinfolkClaim('u1');
    expect(result).toEqual({ kinfolkId: null });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { admin: true });
  });

  it('backwrites uid onto the active kinfolk doc', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['a'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await syncKinfolkClaim('u1');
    const w = ctx.writes.find((w) => w.path === 'kinfolk/a');
    expect(w).toBeDefined();
    expect(w!.data.uid).toBe('u1');
    expect(w!.merge).toBe(true);
  });

  it('does not throw when the client doc does not exist (treated as no tribes)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const result = await syncKinfolkClaim('u1');
    expect(result).toEqual({ kinfolkId: null });
  });
});
