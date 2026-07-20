import { describe, expect, it } from 'vitest';
import { isEmailAlreadyInUse, mapAuthError } from './authErrors';

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
