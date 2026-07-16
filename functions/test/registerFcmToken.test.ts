import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => mocks.dbFn.mockReset());

describe('registerFcmTokenHandler', () => {
  it('rejects unauth', async () => {
    const { registerFcmTokenHandler } = await import('../src/portal/registerFcmToken');
    await expect(registerFcmTokenHandler({ data: { token: 'tok-123456789', platform: 'web' }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects unknown platform', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { registerFcmTokenHandler } = await import('../src/portal/registerFcmToken');
    await expect(
      registerFcmTokenHandler({ data: { token: 'tok-123456789', platform: 'desktop' }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
  });

  it('writes token doc keyed by token', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { registerFcmTokenHandler } = await import('../src/portal/registerFcmToken');
    await registerFcmTokenHandler({
      data: { token: 'token-abcdefghij', platform: 'android', appVersion: '1.0.0' },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'fcm_tokens/token-abcdefghij');
    expect(w!.data.uid).toBe('u1');
    expect(w!.data.platform).toBe('android');
    expect(w!.merge).toBe(true);
  });
});

describe('unregisterFcmTokenHandler', () => {
  it('does not delete tokens that belong to other users', async () => {
    const ctx = buildDbMock({ docs: { 'fcm_tokens/tok-abcdefghij': { uid: 'someone-else' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { unregisterFcmTokenHandler } = await import('../src/portal/registerFcmToken');
    await unregisterFcmTokenHandler({ data: { token: 'tok-abcdefghij' }, auth: { uid: 'u1' } } as any);
    expect(ctx.deletes).toEqual([]);
  });

  it('deletes tokens owned by caller', async () => {
    const ctx = buildDbMock({ docs: { 'fcm_tokens/tok-abcdefghij': { uid: 'u1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { unregisterFcmTokenHandler } = await import('../src/portal/registerFcmToken');
    await unregisterFcmTokenHandler({ data: { token: 'tok-abcdefghij' }, auth: { uid: 'u1' } } as any);
    expect(ctx.deletes).toEqual(['fcm_tokens/tok-abcdefghij']);
  });
});
