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

  it('rejects a platform outside the grammar', async () => {
    // 'desktop' used to be the example here. It is a legitimate base platform
    // now (the KMP jvm target registers as 'desktop-mytribe'), so the rejection
    // case has to be something genuinely unknown.
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { registerFcmTokenHandler } = await import('../src/portal/registerFcmToken');
    await expect(
      registerFcmTokenHandler({ data: { token: 'tok-123456789', platform: 'toaster' }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
    await expect(
      registerFcmTokenHandler({ data: { token: 'tok-123456789', platform: 'Android-MyTribe' }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
    expect(ctx.writes).toEqual([]);
  });

  it.each(['android', 'web', 'android-mytribe', 'web-mytribe', 'desktop-mytribe'])(
    'accepts %s, the platform strings the shipped clients actually send, stored verbatim',
    async (platform) => {
      // MYTRIBE-FUNCTIONS-A: the kinfolk portal's Android build sends
      // 'android-mytribe', which the old enum refused, so the shipped app
      // registered no token at all and got no push. That app cannot be updated
      // remotely, so the server accepts what it sends.
      const ctx = buildDbMock();
      mocks.dbFn.mockReturnValue(ctx.db);
      const { registerFcmTokenHandler } = await import('../src/portal/registerFcmToken');
      const token = `token-${platform}-0123456789`;
      await registerFcmTokenHandler({ data: { token, platform }, auth: { uid: 'u1' } } as any);
      const w = ctx.writes.find((w) => w.path === `fcm_tokens/${token}`);
      expect(w!.data.platform).toBe(platform);
      expect(w!.data.uid).toBe('u1');
    },
  );

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
