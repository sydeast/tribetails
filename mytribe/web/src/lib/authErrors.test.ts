import { describe, expect, it } from 'vitest';
import { isEmailAlreadyInUse, isEmailUnverified, mapAuthError } from './authErrors';

function fbError(code: string, message = ''): { code: string; message: string } {
  return { code, message };
}

describe('mapAuthError', () => {
  it('maps wrong password / invalid credential to a credentials message', () => {
    for (const code of ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email']) {
      const out = mapAuthError(fbError(code));
      expect(out.kind).toBe('credentials');
      expect(out.message).toMatch(/did not match/);
    }
  });

  it('maps the REST INVALID_LOGIN_CREDENTIALS shape to credentials', () => {
    expect(mapAuthError(new Error('Firebase: Error (INVALID_LOGIN_CREDENTIALS).')).kind).toBe('credentials');
  });

  it('maps too-many-requests to rateLimit', () => {
    const out = mapAuthError(fbError('auth/too-many-requests'));
    expect(out.kind).toBe('rateLimit');
    expect(out.message).toMatch(/few minutes/);
  });

  it('maps network failures to network', () => {
    expect(mapAuthError(fbError('auth/network-request-failed')).kind).toBe('network');
    expect(mapAuthError(new Error('Failed to fetch')).kind).toBe('network');
  });

  it('falls back to unknown for anything else', () => {
    const out = mapAuthError(new Error('quota exceeded'));
    expect(out.kind).toBe('unknown');
    expect(out.message.length).toBeGreaterThan(0);
  });

  it('never throws on weird inputs', () => {
    expect(mapAuthError(undefined).kind).toBe('unknown');
    expect(mapAuthError(null).kind).toBe('unknown');
    expect(mapAuthError(42).kind).toBe('unknown');
  });
});

describe('isEmailAlreadyInUse', () => {
  it('detects the JS SDK code', () => {
    expect(isEmailAlreadyInUse(fbError('auth/email-already-in-use'))).toBe(true);
  });
  it('detects the REST EMAIL_EXISTS shape', () => {
    expect(isEmailAlreadyInUse(new Error('EMAIL_EXISTS'))).toBe(true);
  });
  it('detects the claimInviteSignup already-exists HttpsError', () => {
    expect(isEmailAlreadyInUse({ code: 'functions/already-exists', message: 'EMAIL_EXISTS' })).toBe(true);
  });
  it('rejects unrelated errors', () => {
    expect(isEmailAlreadyInUse(fbError('auth/wrong-password'))).toBe(false);
    expect(isEmailAlreadyInUse(undefined)).toBe(false);
  });
});

/**
 * RULING: "secondary needs email verification as well."
 *
 * `acceptInvite` refuses an unverified invitee with `failed-precondition` and an
 * actionable message. The claim screen has to tell that apart from the OTHER
 * `failed-precondition` that callable throws, for a dead invite, because one is
 * "do this and come back" and the other is "this link is finished".
 */
describe('isEmailUnverified', () => {
  it('detects the acceptInvite verification refusal', () => {
    expect(
      isEmailUnverified({
        code: 'functions/failed-precondition',
        message:
          'Verify jane@example.com before joining. We just emailed a verification link to that address. Open it, then come back to this invite link.',
      }),
    ).toBe(true);
  });
  it('detects the refusal that could NOT send the mail', () => {
    // FOLLOWUPS #16: the refusal has two wordings now, because a suppressed send
    // is reported back to the handler and the message stopped claiming a mail
    // that never left. Both have to reach the verify card, or a failed send
    // drops the invitee into the generic "didn't finish. Try again." retry loop.
    expect(
      isEmailUnverified({
        code: 'functions/failed-precondition',
        message:
          'Verify jane@example.com before joining. We could not send the verification email just now. Look for an earlier one in that inbox, or try again in a minute.',
      }),
    ).toBe(true);
  });
  it('does NOT swallow the dead-invite failed-precondition', () => {
    expect(isEmailUnverified({ code: 'functions/failed-precondition', message: 'invite no longer valid' })).toBe(false);
    expect(isEmailUnverified({ code: 'functions/failed-precondition', message: 'invite expired' })).toBe(false);
  });
  it('rejects unrelated errors and junk', () => {
    expect(isEmailUnverified({ code: 'functions/permission-denied', message: 'invite email mismatch' })).toBe(false);
    expect(isEmailUnverified(undefined)).toBe(false);
    expect(isEmailUnverified(null)).toBe(false);
    expect(isEmailUnverified('verify your email')).toBe(false);
  });
});
