import { describe, expect, it } from 'vitest';
import { FirebaseError } from 'firebase/app';
import { INVITES_UNAVAILABLE_MESSAGE, isConfigGapError } from './inviteFailure';
describe('#1277 isConfigGapError', () => {
  it('catches the refusal the QA walk saw, with and without the status suffix', () => {
    expect(isConfigGapError(new FirebaseError('functions/failed-precondition', 'AUNTIE_OS_REVIEW_BASE_URL is not configured'))).toBe(true);
    expect(isConfigGapError(new Error('AUNTIE_OS_REVIEW_BASE_URL is not configured [400]'))).toBe(true);
    expect(isConfigGapError(new FirebaseError('functions/failed-precondition', 'CLAIM_LINK_BASE_URL is not configured'))).toBe(true);
  });
  it('leaves the refusals a household can act on alone', () => {
    expect(isConfigGapError(new FirebaseError('functions/failed-precondition', 'You cannot invite yourself.'))).toBe(false);
    expect(isConfigGapError(new FirebaseError('functions/failed-precondition', 'This secondary kinfolk already has portal access.'))).toBe(false);
    expect(isConfigGapError(new Error('Your email is not configured'))).toBe(false);
    expect(isConfigGapError('CLAIM_LINK_BASE_URL is not configured')).toBe(false);
    expect(isConfigGapError(null)).toBe(false);
  });
  it('the household message names no setting', () => {
    expect(INVITES_UNAVAILABLE_MESSAGE).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    expect(INVITES_UNAVAILABLE_MESSAGE).not.toContain('—');
  });
});
