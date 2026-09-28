import { describe, expect, it } from 'vitest';
import { parseInviteId, stepForPreview, validateNewPassword } from './claimFlow';

describe('stepForPreview', () => {
  const valid = { status: 'valid', invitedEmail: 'Kin@Example.com', tribeName: 'The Parkers' } as const;

  it('signed out + valid invite -> createAccount with email and tribe name', () => {
    expect(stepForPreview(valid, false, null)).toEqual({
      kind: 'createAccount',
      invitedEmail: 'Kin@Example.com',
      tribeName: 'The Parkers',
    });
  });

  it('signed in with matching email (case-insensitive) -> autoAccept', () => {
    expect(stepForPreview(valid, true, 'kin@example.com')).toEqual({
      kind: 'autoAccept',
      invitedEmail: 'Kin@Example.com',
    });
  });

  it('signed in as someone else -> wrongAccount', () => {
    const step = stepForPreview(valid, true, 'other@example.com');
    expect(step).toEqual({
      kind: 'wrongAccount',
      invitedEmail: 'Kin@Example.com',
      currentEmail: 'other@example.com',
    });
  });

  it('signed in with no email -> wrongAccount with empty currentEmail', () => {
    expect(stepForPreview(valid, true, null)).toEqual({
      kind: 'wrongAccount',
      invitedEmail: 'Kin@Example.com',
      currentEmail: '',
    });
  });

  it.each([
    ['claimed', 'already used'],
    ['expired', 'expired'],
    ['revoked', 'no longer active'],
    ['not_found', "couldn't find"],
  ] as const)('%s -> inviteInvalid', (status, fragment) => {
    const step = stepForPreview({ status }, false, null);
    expect(step.kind).toBe('inviteInvalid');
    if (step.kind === 'inviteInvalid') {
      expect(step.message.toLowerCase()).toContain(fragment);
    }
  });
});

describe('validateNewPassword', () => {
  it('rejects short passwords', () => {
    expect(validateNewPassword('short', 'short')).toMatch(/8 characters/);
  });
  it('rejects mismatched passwords', () => {
    expect(validateNewPassword('longenough', 'different')).toMatch(/match/);
  });
  it('accepts a valid pair', () => {
    expect(validateNewPassword('longenough', 'longenough')).toBeNull();
  });
});

describe('parseInviteId', () => {
  it('parses the ?invite= query form (what invite emails send)', () => {
    expect(parseInviteId({ hash: '', pathname: '/claim', search: '?invite=abc123' })).toBe('abc123');
  });
  it('parses the legacy hash form #/claim/<id>', () => {
    expect(parseInviteId({ hash: '#/claim/xyz', pathname: '/', search: '' })).toBe('xyz');
  });
  it('parses the path form /claim/<id>', () => {
    expect(parseInviteId({ hash: '', pathname: '/claim/pqr', search: '' })).toBe('pqr');
  });
  it('prefers hash over path over query', () => {
    expect(
      parseInviteId({ hash: '#/claim/h1', pathname: '/claim/p1', search: '?invite=q1' }),
    ).toBe('h1');
  });
  it('returns null when nothing matches', () => {
    expect(parseInviteId({ hash: '', pathname: '/claim', search: '' })).toBeNull();
    expect(parseInviteId({ hash: '', pathname: '/claim', search: '?invite=' })).toBeNull();
  });
});
describe('withTimeout (O-35)', () => {
  it('resolves with the value when the promise wins', async () => {
    const { withTimeout } = await import('./claimFlow');
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'X')).resolves.toBe('ok');
  });
  it('rejects with a labeled timeout error when the promise stalls', async () => {
    const { withTimeout } = await import('./claimFlow');
    const never = new Promise<never>(() => undefined);
    await expect(withTimeout(never, 20, 'Joining your Tribe')).rejects.toThrow(
      'Joining your Tribe timed out. Please try again.',
    );
  });
  it('propagates the original rejection untouched', async () => {
    const { withTimeout } = await import('./claimFlow');
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'X')).rejects.toThrow('boom');
  });
});
