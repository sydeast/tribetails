import { describe, it, expect } from 'vitest';
import {
  PRIVACY_POLICY_URL_MAX_LENGTH,
  isValidPrivacyPolicyUrl,
  readPrivacyPolicyUrl,
} from '../src/lib/privacyPolicyUrl';

/**
 * #1410: the one predicate every layer mirrors. The rules helper `bsHttpsUrl`
 * and the three admin editors must agree with these cases; a value that passes
 * here and is refused there (or the reverse) is a drift, not a judgement call.
 */
describe('isValidPrivacyPolicyUrl (#1410)', () => {
  it('accepts blank: no policy published yet is a legal state', () => {
    expect(isValidPrivacyPolicyUrl('')).toBe(true);
  });

  it('accepts a plain https URL, with or without a path or query', () => {
    expect(isValidPrivacyPolicyUrl('https://example.com')).toBe(true);
    expect(isValidPrivacyPolicyUrl('https://example.com/privacy')).toBe(true);
    expect(isValidPrivacyPolicyUrl('https://www.example.com/legal/privacy?lang=en#top')).toBe(true);
  });

  it('refuses http and every other scheme', () => {
    expect(isValidPrivacyPolicyUrl('http://example.com/privacy')).toBe(false);
    expect(isValidPrivacyPolicyUrl('javascript:alert(1)')).toBe(false);
    expect(isValidPrivacyPolicyUrl('mailto:privacy@example.com')).toBe(false);
    expect(isValidPrivacyPolicyUrl('example.com/privacy')).toBe(false);
  });

  it('refuses a scheme with no host', () => {
    expect(isValidPrivacyPolicyUrl('https://')).toBe(false);
    expect(isValidPrivacyPolicyUrl('https:///privacy')).toBe(false);
  });

  it('refuses whitespace and characters that could break out of an href', () => {
    expect(isValidPrivacyPolicyUrl('https://example.com/privacy policy')).toBe(false);
    expect(isValidPrivacyPolicyUrl('https://example.com/"onmouseover="x')).toBe(false);
    expect(isValidPrivacyPolicyUrl("https://example.com/'")).toBe(false);
    expect(isValidPrivacyPolicyUrl('https://example.com/<b>')).toBe(false);
    expect(isValidPrivacyPolicyUrl('https://example.com/`')).toBe(false);
    expect(isValidPrivacyPolicyUrl('https://example.com\\privacy')).toBe(false);
  });

  it('caps the length at exactly the constant', () => {
    const prefix = 'https://example.com/';
    const atCap = prefix + 'a'.repeat(PRIVACY_POLICY_URL_MAX_LENGTH - prefix.length);
    expect(atCap.length).toBe(PRIVACY_POLICY_URL_MAX_LENGTH);
    expect(isValidPrivacyPolicyUrl(atCap)).toBe(true);
    expect(isValidPrivacyPolicyUrl(atCap + 'a')).toBe(false);
  });
});

describe('readPrivacyPolicyUrl (#1410)', () => {
  it('returns a valid stored value, trimmed', () => {
    expect(readPrivacyPolicyUrl({ privacyPolicyUrl: '  https://example.com/privacy ' }))
      .toBe('https://example.com/privacy');
  });

  it('returns blank when the key is absent, not a string, or blank', () => {
    expect(readPrivacyPolicyUrl({})).toBe('');
    expect(readPrivacyPolicyUrl({ privacyPolicyUrl: 42 })).toBe('');
    expect(readPrivacyPolicyUrl({ privacyPolicyUrl: null })).toBe('');
    expect(readPrivacyPolicyUrl({ privacyPolicyUrl: '   ' })).toBe('');
  });

  it('returns blank for a stored value that fails the predicate, never the raw string', () => {
    expect(readPrivacyPolicyUrl({ privacyPolicyUrl: 'http://example.com/privacy' })).toBe('');
    expect(readPrivacyPolicyUrl({ privacyPolicyUrl: 'javascript:alert(1)' })).toBe('');
    expect(readPrivacyPolicyUrl({ privacyPolicyUrl: 'https://example.com/"' })).toBe('');
  });
});
