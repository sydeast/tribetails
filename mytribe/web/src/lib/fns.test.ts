import { FirebaseError } from 'firebase/app';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call, CallableTimeoutError } from './fns';
import { resetRevokedSessionForTest } from './revokedSession';

vi.mock('./firebase', () => ({ functions: {}, auth: { name: 'test-auth' } }));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./activeTribe', () => ({ clearAccess: vi.fn() }));

beforeEach(() => {
  resetRevokedSessionForTest();
  vi.mocked(firebaseSignOut).mockClear();
});

describe('call', () => {
  it('returns the callable result data', async () => {
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockResolvedValue({ data: { ok: true } }) as never);
    await expect(call('getMyHome', {})).resolves.toEqual({ ok: true });
  });

  it('passes a bounded timeout to httpsCallable so a stuck call cannot hang forever', async () => {
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockResolvedValue({ data: {} }) as never);
    await call('getMyHome', {});
    expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'getMyHome', { timeout: 20_000 });
  });

  it('converts a deadline-exceeded rejection into a CallableTimeoutError naming the callable', async () => {
    const deadlineExceeded = new FirebaseError('functions/deadline-exceeded', 'deadline exceeded');
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(deadlineExceeded) as never);
    await expect(call('addKinTaleComment', {})).rejects.toThrow(CallableTimeoutError);
    await expect(call('addKinTaleComment', {})).rejects.toThrow(/addKinTaleComment/);
  });

  it('rethrows non-timeout errors unchanged', async () => {
    const permissionDenied = new FirebaseError('functions/permission-denied', 'nope');
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(permissionDenied) as never);
    await expect(call('archiveKin', {})).rejects.toBe(permissionDenied);
  });

  // #557. This is the reproduction: a callable made with a revoked session's ID
  // token comes back tagged, and the portal has to end the session instead of
  // handing the screen an error it will retry forever.
  it('signs the kinfolk out when the backend says the session was revoked', async () => {
    const revoked = new FirebaseError(
      'functions/unauthenticated',
      'Your session was ended (session-revoked). Sign in again.',
    );
    (revoked as FirebaseError & { details?: unknown }).details = { reason: 'session-revoked' };
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(revoked) as never);

    // Still rejects: this reacts to the error, it does not swallow it.
    await expect(call('getMyHome', {})).rejects.toBe(revoked);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('does NOT sign the kinfolk out for an untagged unauthenticated refusal', async () => {
    const notSignedIn = new FirebaseError('functions/unauthenticated', 'Sign in required.');
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(notSignedIn) as never);
    await expect(call('getMyHome', {})).rejects.toBe(notSignedIn);
    expect(firebaseSignOut).not.toHaveBeenCalled();
  });
});
