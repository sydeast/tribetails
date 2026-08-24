// @vitest-environment jsdom
// jsdom, not the default 'node' environment: this module writes the notice to
// `sessionStorage` and navigates via `window.location`, neither of which exists
// under 'node'.
import { FirebaseError } from 'firebase/app';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISABLED_REASON,
  REVOKED_REASON,
  endRevokedSession,
  noteSessionAlive,
  reactToCallableError,
  resetRevokedSessionForTest,
  sessionEndedReason,
} from './revokedSession';
import { SIGN_IN_NOTICE_STORAGE_KEY, readAndClearSignInNotice } from './signInNotice';

vi.mock('./firebase', () => ({ auth: { name: 'test-auth' } }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));

/** A callable rejection shaped exactly as the Functions SDK delivers one. */
function callableError(code: string, message: string, details?: unknown): FirebaseError {
  const err = new FirebaseError(code, message);
  if (details !== undefined) (err as FirebaseError & { details?: unknown }).details = details;
  return err;
}

describe('sessionEndedReason', () => {
  it('reads the reason off details', () => {
    const err = callableError('functions/unauthenticated', 'Your session was ended.', {
      reason: REVOKED_REASON,
    });
    expect(sessionEndedReason(err)).toBe(REVOKED_REASON);
  });

  it('recognises a disabled account', () => {
    const err = callableError('functions/unauthenticated', 'This account is turned off.', {
      reason: DISABLED_REASON,
    });
    expect(sessionEndedReason(err)).toBe(DISABLED_REASON);
  });

  it('falls back to the message token when details did not survive the trip', () => {
    // The literal `sessionRevocation.ts` sends, tokens included on purpose.
    const err = callableError(
      'functions/unauthenticated',
      'Your session was ended (session-revoked). Sign in again.',
    );
    expect(sessionEndedReason(err)).toBe(REVOKED_REASON);
  });

  // ---------------------------------------------------------------------
  // THE FOUR NON-TRIGGERS. Each one is a way for a callable to fail that is
  // not a statement about this session, and tearing down on any of them would
  // sign an operator out of a working session.
  // ---------------------------------------------------------------------
  it('is null for a bare unauthenticated refusal — that is "not signed in", the route guard owns it', () => {
    expect(
      sessionEndedReason(callableError('functions/unauthenticated', 'Sign in required.')),
    ).toBeNull();
  });

  it('is null for permission-denied — an answer about this data, not about the session', () => {
    expect(
      sessionEndedReason(callableError('functions/permission-denied', 'admin claim required')),
    ).toBeNull();
  });

  it('is null for a network failure — retrying is what fixes those', () => {
    expect(sessionEndedReason(new Error('Failed to fetch'))).toBeNull();
    expect(sessionEndedReason(callableError('functions/internal', 'internal'))).toBeNull();
  });

  it('is null for a cancellation or a timeout', () => {
    expect(sessionEndedReason(new DOMException('Aborted', 'AbortError'))).toBeNull();
    expect(sessionEndedReason(callableError('functions/deadline-exceeded', 'deadline'))).toBeNull();
  });

  it('is null for a non-error value', () => {
    expect(sessionEndedReason(null)).toBeNull();
    expect(sessionEndedReason('session-revoked')).toBeNull();
  });

  it('does not tear down on some OTHER error that happens to mention the token', () => {
    expect(
      sessionEndedReason(callableError('functions/internal', 'log line said session-revoked')),
    ).toBeNull();
  });
});

describe('endRevokedSession', () => {
  beforeEach(() => {
    resetRevokedSessionForTest();
    vi.mocked(firebaseSignOut).mockClear();
    vi.mocked(firebaseSignOut).mockResolvedValue(undefined);
    sessionStorage.clear();
  });

  it('signs the local Firebase session out', async () => {
    await endRevokedSession(REVOKED_REASON);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('leaves an explanation for the sign-in screen', async () => {
    await endRevokedSession(REVOKED_REASON);
    expect(sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toMatch(/session ended/i);
  });

  it('says something different when the account was turned off', async () => {
    await endRevokedSession(DISABLED_REASON);
    expect(sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toMatch(/turned off/i);
  });

  it('still leaves the notice when the Firebase sign-out itself fails', async () => {
    vi.mocked(firebaseSignOut).mockRejectedValueOnce(new Error('network'));
    await expect(endRevokedSession(REVOKED_REASON)).resolves.toBeUndefined();
    expect(sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toMatch(/session ended/i);
  });

  it('runs once for a burst of refusals, not once per refused call', async () => {
    await Promise.all([
      endRevokedSession(REVOKED_REASON),
      endRevokedSession(REVOKED_REASON),
      endRevokedSession(REVOKED_REASON),
    ]);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('re-arms after a callable succeeds, so a SECOND revocation is not ignored', async () => {
    await endRevokedSession(REVOKED_REASON);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);

    // Without noteSessionAlive this second teardown is swallowed by the burst
    // guard. jsdom refuses the navigation, so the page survives the first one
    // and the latch would otherwise stay closed for the rest of its life.
    await endRevokedSession(REVOKED_REASON);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);

    noteSessionAlive();
    await endRevokedSession(REVOKED_REASON);
    expect(firebaseSignOut).toHaveBeenCalledTimes(2);
  });

  it('readAndClearSignInNotice shows the notice once', async () => {
    await endRevokedSession(REVOKED_REASON);
    expect(readAndClearSignInNotice()).toMatch(/sign in again/i);
    expect(readAndClearSignInNotice()).toBeNull();
  });
});

describe('reactToCallableError', () => {
  beforeEach(() => {
    resetRevokedSessionForTest();
    vi.mocked(firebaseSignOut).mockClear();
    vi.mocked(firebaseSignOut).mockResolvedValue(undefined);
    sessionStorage.clear();
  });

  it('tears down on a revoked-session refusal', async () => {
    await reactToCallableError(
      callableError('functions/unauthenticated', 'ended', { reason: REVOKED_REASON }),
    );
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('tears down on a disabled account', async () => {
    await reactToCallableError(
      callableError('functions/unauthenticated', 'off', { reason: DISABLED_REASON }),
    );
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('leaves the four non-triggers alone', async () => {
    await reactToCallableError(callableError('functions/unauthenticated', 'Sign in required.'));
    await reactToCallableError(callableError('functions/permission-denied', 'nope'));
    await reactToCallableError(new Error('Failed to fetch'));
    await reactToCallableError(new DOMException('Aborted', 'AbortError'));
    expect(firebaseSignOut).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toBeNull();
  });
});
