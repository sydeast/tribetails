import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  profileFullName,
  profileDisplayName,
  profileInitials,
  providerLabel,
  roleLabel,
  authDateLabel,
  emailVerifiedLabel,
} from './accountFormat';

// File-scope TZ pin: authDateLabel reads LOCAL wall-clock parts, so a fixed zone
// makes the assertion deterministic across runners (the AO-18 principle).
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function prof(over: Partial<Parameters<typeof profileDisplayName>[0]> = {}) {
  return { displayName: '', firstName: '', lastName: '', ...over };
}

describe('profileFullName', () => {
  it('joins first and last, dropping blanks', () => {
    expect(profileFullName({ firstName: 'Nora', lastName: 'Brooks' })).toBe('Nora Brooks');
    expect(profileFullName({ firstName: 'Nora', lastName: '' })).toBe('Nora');
    expect(profileFullName({ firstName: '', lastName: '' })).toBe('');
  });
});

describe('profileDisplayName (priority order, never blank)', () => {
  it('prefers the explicit displayName', () => {
    expect(profileDisplayName(prof({ displayName: 'Auntie Nora' }), 'Auth Name', 'x@y.com')).toBe('Auntie Nora');
  });
  it('falls to First Last, then auth displayName, then email local-part, then Operator', () => {
    expect(profileDisplayName(prof({ firstName: 'Nora', lastName: 'Brooks' }), null, null)).toBe('Nora Brooks');
    expect(profileDisplayName(prof(), 'Auth Name', null)).toBe('Auth Name');
    expect(profileDisplayName(prof(), null, 'nora@tribetails.com')).toBe('nora');
    expect(profileDisplayName(prof(), null, null)).toBe('Operator');
  });
});

describe('profileInitials', () => {
  it('takes up to two uppercase initials', () => {
    expect(profileInitials('Nora Brooks')).toBe('NB');
    expect(profileInitials('Nora')).toBe('N');
    expect(profileInitials('  ')).toBe('?');
    expect(profileInitials('')).toBe('?');
  });
});

describe('providerLabel', () => {
  it('maps known providers and falls back to the raw id', () => {
    expect(providerLabel('password')).toBe('Email and password');
    expect(providerLabel('google.com')).toBe('Google');
    expect(providerLabel('')).toBe('Unknown');
    expect(providerLabel('saml.custom')).toBe('saml.custom');
  });
});

describe('roleLabel', () => {
  it('labels each resolved access', () => {
    expect(roleLabel({ status: 'admin' })).toBe('Operator (full admin)');
    expect(roleLabel({ status: 'caretaker' })).toBe('Auntie (caretaker)');
    expect(roleLabel({ status: 'testAdmin', testTribeId: '0I' })).toBe('Test admin (sandbox)');
    expect(roleLabel({ status: 'denied' })).toBe('No access');
  });

  it('never calls a caretaker the Operator (#944)', () => {
    // The Account screen's Role row is where someone looks to find out which
    // boundary they are on, and the whole point of the split is that hers is
    // narrower than the owner's. Asserted separately from the wording above so
    // a copy edit cannot quietly reintroduce "Operator" here.
    expect(roleLabel({ status: 'caretaker' })).not.toContain('Operator');
    expect(roleLabel({ status: 'caretaker' })).not.toContain('admin');
  });
});

describe('authDateLabel (LOCAL, AO-18)', () => {
  it('formats an RFC-1123 auth timestamp in LOCAL time', () => {
    // 12:00 GMT is 07:00 in America/Chicago (CDT), same calendar day.
    expect(authDateLabel('Thu, 16 Jul 2026 12:00:00 GMT')).toBe('Jul 16, 2026, 07:00');
  });
  it('is "Unknown" on blank, and echoes unparseable text verbatim', () => {
    expect(authDateLabel('')).toBe('Unknown');
    expect(authDateLabel('   ')).toBe('Unknown');
    expect(authDateLabel('not a date')).toBe('not a date');
  });
});

describe('emailVerifiedLabel', () => {
  it('labels verified state', () => {
    expect(emailVerifiedLabel(true)).toBe('Verified');
    expect(emailVerifiedLabel(false)).toBe('Not verified');
  });
});
