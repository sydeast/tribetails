import { FirebaseError } from 'firebase/app';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call, CallableTimeoutError } from './fns';
import { resetRevokedSessionForTest } from './revokedSession';

vi.mock('./firebase', () => ({ functions: {}, auth: { name: 'test-auth' } }));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./auth', () => ({ purgeSessionCaches: vi.fn() }));

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

  // The guard in revokedSession.ts collapses ONE burst; it must not latch. A
  // page that survived a teardown without navigating (assign refused) would
  // otherwise go deaf to the next revocation.
  it('signs out again after a successful call has proven a new session', async () => {
    const revoked = new FirebaseError(
      'functions/unauthenticated',
      'Your session was ended (session-revoked). Sign in again.',
    );
    (revoked as FirebaseError & { details?: unknown }).details = { reason: 'session-revoked' };

    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(revoked) as never);
    await expect(call('getMyHome', {})).rejects.toBe(revoked);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);

    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockResolvedValue({ data: { ok: true } }) as never);
    await call('getMyHome', {});

    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(revoked) as never);
    await expect(call('getMyHome', {})).rejects.toBe(revoked);
    expect(firebaseSignOut).toHaveBeenCalledTimes(2);
  });

  it('does NOT sign the kinfolk out for an untagged unauthenticated refusal', async () => {
    const notSignedIn = new FirebaseError('functions/unauthenticated', 'Sign in required.');
    vi.mocked(httpsCallable).mockReturnValue(vi.fn().mockRejectedValue(notSignedIn) as never);
    await expect(call('getMyHome', {})).rejects.toBe(notSignedIn);
    expect(firebaseSignOut).not.toHaveBeenCalled();
  });
});

/**
 * #644 / #630. The retry is the whole point of the idempotency key, and it is
 * opt-in per call site because `functions/internal` cannot distinguish "never
 * arrived" from "committed, reply lost". On the portal a wrong opt-in is the
 * worse one: where the operator has auto-confirm on, a duplicated request
 * becomes a second set of CONFIRMED sessions, not merely a second queue entry.
 */
describe('call, the opt-in retry', () => {
  /** Rejects [failures] times with [code], then resolves with [data]. */
  function failThenSucceed(failures: number, code: string, data: unknown) {
    let seen = 0;
    const fn = vi.fn((_payload: unknown) => {
      seen += 1;
      return seen <= failures
        ? Promise.reject(new FirebaseError(code, code.replace('functions/', '')))
        : Promise.resolve({ data });
    });
    vi.mocked(httpsCallable).mockReturnValue(fn as never);
    return fn;
  }

  it('retries once on functions/internal when the caller opted in', async () => {
    const fn = failThenSucceed(1, 'functions/internal', { batchId: 'req_1_abcdef' });
    await expect(call('requestBooking', {}, { idempotent: true })).resolves.toEqual({
      batchId: 'req_1_abcdef',
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries ONCE, not until it works', async () => {
    const fn = failThenSucceed(5, 'functions/internal', {});
    await expect(call('requestBooking', {}, { idempotent: true })).rejects.toBeInstanceOf(
      FirebaseError,
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never retries a callable that did not opt in', async () => {
    const fn = failThenSucceed(1, 'functions/internal', {});
    await expect(call('getMyHome', {})).rejects.toBeInstanceOf(FirebaseError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never retries a deadline, even for an opted-in callable', async () => {
    // The 20s timeout exists so a hang becomes a visible, household-driven
    // retry. Doubling the wait silently would undo exactly that.
    const fn = failThenSucceed(1, 'functions/deadline-exceeded', {});
    await expect(call('requestBooking', {}, { idempotent: true })).rejects.toBeInstanceOf(
      CallableTimeoutError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry other codes for an opted-in callable', async () => {
    const fn = failThenSucceed(1, 'functions/already-exists', {});
    await expect(call('requestBooking', {}, { idempotent: true })).rejects.toBeInstanceOf(
      FirebaseError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sends the identical payload on the retry, key included', async () => {
    const fn = failThenSucceed(1, 'functions/internal', {});
    const payload = { kinfolkId: 'kf1', idempotencyKey: 'req_1756400000000_a1b2c3' };
    await call('requestBooking', payload, { idempotent: true });
    // A retry that re-minted the key would be a fresh booking to the server.
    expect(fn.mock.calls[0]?.[0]).toEqual(payload);
    expect(fn.mock.calls[1]?.[0]).toEqual(payload);
  });
});
