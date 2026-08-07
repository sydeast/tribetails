import { describe, it, expect, beforeEach } from 'vitest';
import { requireBaseUrl } from '../src/lib/requireBaseUrl';

const VAR = 'TEST_LINK_BASE_URL';

describe('requireBaseUrl', () => {
  beforeEach(() => {
    delete process.env[VAR];
  });

  it('throws failed-precondition when unset', () => {
    expect(() => requireBaseUrl(VAR)).toThrow(
      expect.objectContaining({ code: 'failed-precondition', message: expect.stringContaining(VAR) }),
    );
  });

  it('throws failed-precondition when empty', () => {
    process.env[VAR] = '';
    expect(() => requireBaseUrl(VAR)).toThrow(
      expect.objectContaining({ code: 'failed-precondition', message: expect.stringContaining(VAR) }),
    );
  });

  it('throws failed-precondition when only a slash (normalizes to empty before the check)', () => {
    process.env[VAR] = '/';
    expect(() => requireBaseUrl(VAR)).toThrow(
      expect.objectContaining({ code: 'failed-precondition', message: expect.stringContaining(VAR) }),
    );
  });

  it('throws failed-precondition when only repeated slashes', () => {
    process.env[VAR] = '///';
    expect(() => requireBaseUrl(VAR)).toThrow(
      expect.objectContaining({ code: 'failed-precondition', message: expect.stringContaining(VAR) }),
    );
  });

  it('is never invalid-argument: a misconfigured server is not the caller’s fault', () => {
    expect(() => requireBaseUrl(VAR)).not.toThrow(expect.objectContaining({ code: 'invalid-argument' }));
  });

  it('strips a trailing slash instead of doubling it downstream', () => {
    process.env[VAR] = 'https://example.com/claim/';
    expect(requireBaseUrl(VAR)).toBe('https://example.com/claim');
  });

  it('strips repeated trailing slashes', () => {
    process.env[VAR] = 'https://example.com/claim///';
    expect(requireBaseUrl(VAR)).toBe('https://example.com/claim');
  });

  it('returns a valid value unchanged', () => {
    process.env[VAR] = 'https://example.com/claim';
    expect(requireBaseUrl(VAR)).toBe('https://example.com/claim');
  });
});
