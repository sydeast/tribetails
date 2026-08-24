import { describe, expect, it } from 'vitest';
import { bookingWizardSearch, pickGuardRedirect } from './router';
import type { AccessState } from './lib/activeTribe';

function access(overrides: Partial<AccessState>): AccessState {
  return { kinfolkIds: [], isOperator: false, activeKinfolkId: null, error: null, ...overrides };
}

/**
 * Operator ruling 2026-08-06, "one kinfolk, one tribe": the picker is
 * withdrawn for non-operators, so a non-operator who navigates to /pick
 * directly (bookmark, back-button, typed URL) must not see the screen.
 */
describe('pickGuardRedirect (guard for the /pick route)', () => {
  it('stays for an operator, even with a single kinfolkId', () => {
    expect(pickGuardRedirect(access({ kinfolkIds: ['k1'], isOperator: true }))).toBeNull();
  });

  it('stays for an operator with 5 kinfolkIds', () => {
    expect(
      pickGuardRedirect(access({ kinfolkIds: ['k1', 'k2', 'k3', 'k4', 'k5'], isOperator: true })),
    ).toBeNull();
  });

  it('redirects a non-operator with exactly one tribe to /home', () => {
    expect(pickGuardRedirect(access({ kinfolkIds: ['k1'] }))).toBe('/home');
  });

  it('redirects a non-operator with 2+ tribes to /error, not /home and not the picker (data defect)', () => {
    // Not /home: nothing has resolved an activeKinfolkId for this account, and
    // Home's query would fall back server-side to the caller's first linked
    // id (resolveKinfolkAccess.ts) rather than fail — /error is the only
    // destination that fires no kinfolkId-scoped query at all.
    expect(pickGuardRedirect(access({ kinfolkIds: ['k1', 'k2'] }))).toBe('/error');
  });

  it('redirects a signed-in non-operator with 0 tribes to /no-tribes', () => {
    expect(pickGuardRedirect(access({ kinfolkIds: [] }))).toBe('/no-tribes');
  });

  it('stays when access failed to load (unrelated to this gate)', () => {
    expect(pickGuardRedirect(access({ error: 'boom' }))).toBeNull();
  });
});

/**
 * #545: kinfolk should never see the invoice options screen — and "never" has
 * to include a typed URL, not only a stepper that stopped offering it. The
 * step the wizard is on is component state with no URL representation, and
 * this validator is where that is enforced: it returns a fresh object with one
 * key, so a hand-written `?step=4` (or anything else) is dropped rather than
 * passed through to the screen.
 */
describe('bookingWizardSearch (/schedule/book search validation)', () => {
  it('reads the one parameter the route has', () => {
    expect(bookingWizardSearch({ weekly: '1' })).toEqual({ weekly: true });
    expect(bookingWizardSearch({ weekly: true })).toEqual({ weekly: true });
    expect(bookingWizardSearch({})).toEqual({ weekly: false });
    expect(bookingWizardSearch({ weekly: '0' })).toEqual({ weekly: false });
  });

  it('drops any other search parameter, so no URL can select a wizard step', () => {
    expect(bookingWizardSearch({ step: 4 })).toEqual({ weekly: false });
    expect(bookingWizardSearch({ step: '4', invoice: '1', weekly: '1' })).toEqual({ weekly: true });
    expect(Object.keys(bookingWizardSearch({ step: 4, anything: 'else' }))).toEqual(['weekly']);
  });
});
