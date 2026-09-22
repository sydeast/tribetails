import { describe, it, expect, vi, beforeEach } from 'vitest';

const docGet = vi.fn();
const createUser = vi.fn();
const getUserByEmail = vi.fn();
const createCustomToken = vi.fn();

vi.mock('../src/lib/rateLimit', () => ({ enforceRateLimit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (p: string) => ({ get: vi.fn().mockImplementation(() => docGet(p)) }),
  }),
  auth: vi.fn(),
  // #912: the handler's auth access goes through getAdmin(), the accessor that
  // initializes the Admin app, not a bare getAuth() on the default app.
  getAdmin: () => ({ auth: () => ({ createUser, getUserByEmail, createCustomToken }) }),
}));
// #910: these requests carry no X-Forwarded-For, so clientIpOf logs an error.
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/notifications', () => ({ enqueueNotification: vi.fn() }));

beforeEach(() => {
  docGet.mockReset();
  createUser.mockReset();
  getUserByEmail.mockReset();
  createCustomToken.mockReset();
});

function validInvite() {
  return {
    exists: true,
    data: () => ({
      status: 'EMAIL_SENT',
      invitedEmail: 'kin@example.com',
      tribeId: 't1',
      expiresAt: { toMillis: () => Date.now() + 100000 },
    }),
  };
}

describe('claimInviteSignupHandler', () => {
  it('creates the user with the invited email and returns a custom token', async () => {
    docGet.mockResolvedValue(validInvite());
    getUserByEmail.mockRejectedValue({ code: 'auth/user-not-found' });
    createUser.mockResolvedValue({ uid: 'new-uid' });
    createCustomToken.mockResolvedValue('custom-token-1');
    const { claimInviteSignupHandler } = await import('../src/membership/claimInviteSignup');
    const res = await claimInviteSignupHandler({
      data: { inviteId: 'i1', password: 'longenough' },
    } as any);
    expect(createUser).toHaveBeenCalledWith({
      email: 'kin@example.com',
      password: 'longenough',
      emailVerified: true,
    });
    expect(createCustomToken).toHaveBeenCalledWith('new-uid');
    expect(res).toEqual({ token: 'custom-token-1' });
  });

  it('rejects with already-exists when the email has an account', async () => {
    docGet.mockResolvedValue(validInvite());
    getUserByEmail.mockResolvedValue({ uid: 'existing' });
    const { claimInviteSignupHandler } = await import('../src/membership/claimInviteSignup');
    await expect(
      claimInviteSignupHandler({ data: { inviteId: 'i1', password: 'longenough' } } as any),
    ).rejects.toMatchObject({ code: 'already-exists' });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('rejects invalid or expired invites without creating anything', async () => {
    docGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'EMAIL_SENT',
        invitedEmail: 'kin@example.com',
        tribeId: 't1',
        expiresAt: { toMillis: () => Date.now() - 1000 },
      }),
    });
    const { claimInviteSignupHandler } = await import('../src/membership/claimInviteSignup');
    await expect(
      claimInviteSignupHandler({ data: { inviteId: 'i1', password: 'longenough' } } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('rejects unknown invite ids', async () => {
    docGet.mockResolvedValue({ exists: false, data: () => null });
    const { claimInviteSignupHandler } = await import('../src/membership/claimInviteSignup');
    await expect(
      claimInviteSignupHandler({ data: { inviteId: 'nope', password: 'longenough' } } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects accepted/revoked invites', async () => {
    for (const status of ['ACCEPTED', 'REVOKED', 'EXPIRED']) {
      docGet.mockResolvedValue({
        exists: true,
        data: () => ({
          status,
          invitedEmail: 'kin@example.com',
          tribeId: 't1',
          expiresAt: { toMillis: () => Date.now() + 100000 },
        }),
      });
      const { claimInviteSignupHandler } = await import('../src/membership/claimInviteSignup');
      await expect(
        claimInviteSignupHandler({ data: { inviteId: 'i1', password: 'longenough' } } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    }
    expect(createUser).not.toHaveBeenCalled();
  });

  it('rejects short passwords before touching auth', async () => {
    const { claimInviteSignupHandler } = await import('../src/membership/claimInviteSignup');
    await expect(
      claimInviteSignupHandler({ data: { inviteId: 'i1', password: 'short' } } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(docGet).not.toHaveBeenCalled();
  });
});
