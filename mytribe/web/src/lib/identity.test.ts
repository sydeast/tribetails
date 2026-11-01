import { describe, expect, it } from 'vitest';
import { resolveIdentity } from './identity';
const acct = (over: Partial<{ displayName: string | null; email: string | null; impersonated: boolean }> = {}) => ({
  displayName: null,
  email: 'casey.qa@example.com',
  impersonated: false,
  ...over,
});
describe('resolveIdentity (#1290)', () => {
  it('uses the saved display name for the avatar and a first-name greeting', () => {
    const id = resolveIdentity({ account: acct({ displayName: 'Casey QA' }) });
    expect(id).toEqual({ name: 'Casey QA', firstName: 'Casey', initial: 'C' });
  });
  it('is the same answer whether or not the household name is known', () => {
    const a = resolveIdentity({ account: acct({ displayName: 'Casey QA' }), householdName: 'TEST SANDBOX' });
    const b = resolveIdentity({ account: acct({ displayName: 'Casey QA' }) });
    expect(a).toEqual(b);
  });
  it('falls back to the sign-in email when the name is empty, blank or just the email', () => {
    for (const displayName of [null, '', '   ', 'casey.qa@example.com']) {
      const id = resolveIdentity({ account: acct({ displayName }) });
      expect(id).toEqual({ name: 'casey.qa@example.com', firstName: 'Casey', initial: 'C' });
    }
  });
  it('uses the sign-in email before the account has loaded', () => {
    const id = resolveIdentity({ account: undefined, signInEmail: 'jordan@example.com', householdName: 'TEST SANDBOX' });
    expect(id).toEqual({ name: 'jordan@example.com', firstName: 'Jordan', initial: 'J' });
  });
  it('never produces an empty initial', () => {
    expect(resolveIdentity({ account: undefined }).initial).toBe('M');
    expect(resolveIdentity({ account: acct({ displayName: '  ' , email: null }) }).initial).toBe('M');
  });
  it('skips punctuation when picking the initial', () => {
    expect(resolveIdentity({ account: acct({ displayName: '"Riley" Kinfolk' }) }).initial).toBe('R');
  });
  it('turns a shouted or lower-case first word into sentence case, and leaves mixed case alone', () => {
    expect(resolveIdentity({ account: acct({ displayName: 'CASEY QA' }) }).firstName).toBe('Casey');
    expect(resolveIdentity({ account: acct({ displayName: 'casey qa' }) }).firstName).toBe('Casey');
    expect(resolveIdentity({ account: acct({ displayName: 'McKenzie Ng' }) }).firstName).toBe('McKenzie');
  });
  it('shows the household an operator stepped into, not the operator', () => {
    const id = resolveIdentity({
      account: acct({ displayName: 'Operator Person', impersonated: true }),
      signInEmail: 'op@example.com',
      householdName: 'TEST SANDBOX',
    });
    expect(id).toEqual({ name: 'TEST SANDBOX', firstName: 'Test', initial: 'T' });
  });
});
