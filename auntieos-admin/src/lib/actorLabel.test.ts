import { describe, it, expect } from 'vitest';
import { actorLabel, ADMIN_ACTOR_FALLBACK } from './actorLabel';
import type { StaffMember } from '../api/staff';

/**
 * #1962: a "saved by" stamp is a uid, or a sign-in email on older records.
 * Neither is ever printed: the line shows the person's name or "an Admin".
 */
const UID = 'nppJNdMNYJfUigibGKUQj3n4obt2';
const STAFF: StaffMember[] = [
  { uid: UID, displayName: 'Syd East', email: 'e2e-admin@tribetails.com' },
  { uid: 'u-nameless', displayName: null, email: null },
  // What `listStaff` answers for a record with no name: the sign-in email.
  { uid: 'u-email-only', displayName: 'catch@hanasamku.com', email: null },
  { uid: 'u-uid-name', displayName: 'u-uid-name', email: null },
];

describe('actorLabel', () => {
  it('names the staff member a uid stamp belongs to', () => {
    expect(actorLabel(UID, STAFF)).toBe('Syd East');
  });

  it('names the staff member an older sign-in email stamp belongs to, in any letter case', () => {
    expect(actorLabel('e2e-admin@tribetails.com', STAFF)).toBe('Syd East');
    expect(actorLabel(' E2E-Admin@TribeTails.com ', STAFF)).toBe('Syd East');
  });

  it('says "an Admin" for a uid nobody on the roster answers to', () => {
    expect(actorLabel('gone-uid-0000000000000000000', STAFF)).toBe('an Admin');
    expect(ADMIN_ACTOR_FALLBACK).toBe('an Admin');
  });

  it('says "an Admin" for an email nobody on the roster answers to', () => {
    expect(actorLabel('pawsome@hanasamku.com', STAFF)).toBe('an Admin');
  });

  it('never gives an email or a uid back as the name the roster holds', () => {
    expect(actorLabel('u-nameless', STAFF)).toBe('an Admin');
    expect(actorLabel('u-email-only', STAFF)).toBe('an Admin');
    expect(actorLabel('catch@hanasamku.com', STAFF)).toBe('an Admin');
    expect(actorLabel('u-uid-name', STAFF)).toBe('an Admin');
  });

  it('never returns the stamp, whatever it is', () => {
    const stamps = [UID, 'e2e-admin@tribetails.com', 'gone-uid', 'pawsome@hanasamku.com', 'admin', 'u-email-only'];
    for (const stamp of stamps) {
      for (const roster of [STAFF, []]) {
        expect(actorLabel(stamp, roster)).not.toBe(stamp);
        expect(actorLabel(stamp, roster)).not.toContain('@');
      }
    }
  });

  it('has nothing to print for a blank stamp', () => {
    expect(actorLabel('', STAFF)).toBe('');
    expect(actorLabel('   ', STAFF)).toBe('');
    expect(actorLabel(null, STAFF)).toBe('');
    expect(actorLabel(undefined, STAFF)).toBe('');
  });

  it('has nothing to print until the roster has been read, and falls back once it has', () => {
    expect(actorLabel(UID, null)).toBe('');
    expect(actorLabel(UID, [])).toBe('an Admin');
  });

  it('takes another fallback from a screen that needs one', () => {
    expect(actorLabel('gone-uid', STAFF, 'an Auntie')).toBe('an Auntie');
  });
});
