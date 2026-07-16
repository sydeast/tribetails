import { describe, it, expect, beforeEach } from 'vitest';
import { isAuntieOperator, requireAuntieOperator } from '../src/lib/operatorAllowlist';

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = 'uid-auntie,uid-backup';
});

describe('operatorAllowlist', () => {
  it('returns true for an allowlisted uid', () => {
    expect(isAuntieOperator('uid-auntie')).toBe(true);
    expect(isAuntieOperator('uid-backup')).toBe(true);
  });

  it('returns false for any other uid', () => {
    expect(isAuntieOperator('uid-stranger')).toBe(false);
  });

  it('throws HttpsError "permission-denied" when uid not allowlisted', () => {
    expect(() => requireAuntieOperator('uid-stranger')).toThrowError(/permission-denied/);
  });
});
