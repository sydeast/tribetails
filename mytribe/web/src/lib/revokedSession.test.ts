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
  SESSION_ENDED_STORAGE_KEY,
  endRevokedSession,
  reactToCallableError,
  readAndClearSessionEndedNotice,
  resetRevokedSessionForTest,
  sessionEndedReason,
} from './revokedSession';
import { clearAccess } from './activeTribe';

vi.mock('./firebase', () => ({ auth: { name: 'test-auth' } }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./activeTribe', () => ({ clearAccess: vi.fn() }));

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

  it('falls back to the message when details did not survive the trip', () => {
    const err = callableError(
      'functions/unauthenticated',
      'Your session was ended (session-revoked). Sign in again.',
    );
    expect(sessionEndedReason(err)).toBe(REVOKED_REASON);
  });

  // The three-way distinction. Only a revoked/disabled session tears down.
  it('is null for a plain unauthenticated refusal — that is "not signed in", the guards own it', () => {
    expect(sessionEndedReason(callableError('functions/unauthenticated', 'Sign in required.'))).toBeNull();
  });

  it('is null for permission-denied — a real answer about this data, not about the session', () => {
    expect(sessionEndedReason(callableError('functions/permission-denied', 'not your family'))).toBeNull();
  });

  it('is null for a network/timeout failure — retrying can fix those', () => {
    expect(sessionEndedReason(new Error('Failed to fetch'))).toBeNull();
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
    vi.mocked(clearAccess).mockClear();
    sessionStorage.clear();
  });

  it('signs the local session out and drops cached tribe access', async () => {
    await endRevokedSession(REVOKED_REASON);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
    expect(clearAccess).toHaveBeenCalledTimes(1);
  });

  it('leaves an explanation for the sign-in screen', async () => {
    await endRevokedSession(REVOKED_REASON);
    expect(sessionStorage.getItem(SESSION_ENDED_STORAGE_KEY)).toMatch(/session ended/i);
  });

  it('says something different when the account was turned off', async () => {
    await endRevokedSession(DISABLED_REASON);
    expect(sessionStorage.getItem(SESSION_ENDED_STORAGE_KEY)).toMatch(/turned off/i);
  });

  it('still clears local state when the Firebase sign-out itself fails', async () => {
    vi.mocked(firebaseSignOut).mockRejectedValueOnce(new Error('network'));
    await expect(endRevokedSession(REVOKED_REASON)).resolves.toBeUndefined();
    expect(clearAccess).toHaveBeenCalledTimes(1);
  });

  it('runs once for a burst of refusals, not once per refused call', async () => {
    await Promise.all([
      endRevokedSession(REVOKED_REASON),
      endRevokedSession(REVOKED_REASON),
      endRevokedSession(REVOKED_REASON),
    ]);
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('readAndClearSessionEndedNotice shows the notice once', async () => {
    await endRevokedSession(REVOKED_REASON);
    expect(readAndClearSessionEndedNotice()).toMatch(/sign in again/i);
    expect(readAndClearSessionEndedNotice()).toBeNull();
  });
});

describe('reactToCallableError', () => {
  beforeEach(() => {
    resetRevokedSessionForTest();
    vi.mocked(firebaseSignOut).mockClear();
    sessionStorage.clear();
  });

  it('tears down on a revoked-session refusal', async () => {
    await reactToCallableError(
      callableError('functions/unauthenticated', 'ended', { reason: REVOKED_REASON }),
    );
    expect(firebaseSignOut).toHaveBeenCalledTimes(1);
  });

  it('leaves everything else alone', async () => {
    await reactToCallableError(callableError('functions/permission-denied', 'nope'));
    await reactToCallableError(new Error('Failed to fetch'));
    expect(firebaseSignOut).not.toHaveBeenCalled();
  });
});
