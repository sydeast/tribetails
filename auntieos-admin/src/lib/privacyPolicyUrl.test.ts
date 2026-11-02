import { describe, it, expect } from 'vitest';
import {
  PRIVACY_POLICY_URL_MAX_LENGTH,
  isValidPrivacyPolicyUrl,
  privacyPolicyUrlError,
} from './privacyPolicyUrl';

/**
 * #1410: these cases are the same ones `functions/test/privacyPolicyUrl.test.ts`
 * pins on the server and the rules suite pins on `bsHttpsUrl`. A value that
 * passes here must pass there, or the operator sees Save light up and the
 * write refused.
 */
describe('isValidPrivacyPolicyUrl (#1410)', () => {
  it('accepts blank and a plain https URL', () => {
    expect(isValidPrivacyPolicyUrl('')).toBe(true);
    expect(isValidPrivacyPolicyUrl('https://example.com')).toBe(true);
    expect(isValidPrivacyPolicyUrl('https://www.example.com/legal/privacy?lang=en#top')).toBe(true);
  });

  it('refuses http, other schemes, a bare domain and a scheme with no host', () => {
    expect(isValidPrivacyPolicyUrl('http://example.com/privacy')).toBe(false);
    expect(isValidPrivacyPolicyUrl('javascript:alert(1)')).toBe(false);
    expect(isValidPrivacyPolicyUrl('example.com/privacy')).toBe(false);
    expect(isValidPrivacyPolicyUrl('https://')).toBe(false);
    expect(isValidPrivacyPolicyUrl('https:///privacy')).toBe(false);
  });

  it('refuses whitespace and characters that could break out of an href', () => {
    expect(isValidPrivacyPolicyUrl('https://example.com/privacy policy')).toBe(false);
    expect(isValidPrivacyPolicyUrl('https://example.com/"onmouseover="x')).toBe(false);
    expect(isValidPrivacyPolicyUrl('https://example.com/<b>')).toBe(false);
  });

  it('caps the length at exactly the constant', () => {
    const prefix = 'https://example.com/';
    const atCap = prefix + 'a'.repeat(PRIVACY_POLICY_URL_MAX_LENGTH - prefix.length);
    expect(isValidPrivacyPolicyUrl(atCap)).toBe(true);
    expect(isValidPrivacyPolicyUrl(atCap + 'a')).toBe(false);
  });
});

describe('privacyPolicyUrlError (#1410)', () => {
  it('says nothing for blank, whitespace, or a valid link with padding', () => {
    expect(privacyPolicyUrlError('')).toBeNull();
    expect(privacyPolicyUrlError('   ')).toBeNull();
    expect(privacyPolicyUrlError('  https://example.com/privacy  ')).toBeNull();
  });

  it('asks for a full https link for anything that is not one', () => {
    expect(privacyPolicyUrlError('http://example.com/privacy')).toBe('Enter a full https:// link.');
    expect(privacyPolicyUrlError('example.com/privacy')).toBe('Enter a full https:// link.');
    expect(privacyPolicyUrlError('https://')).toBe('Enter a full https:// link.');
  });

  it('names the cap when the link is too long', () => {
    const tooLong = 'https://example.com/' + 'a'.repeat(PRIVACY_POLICY_URL_MAX_LENGTH);
    expect(privacyPolicyUrlError(tooLong)).toBe('Keep the link under 2048 characters.');
  });
});
