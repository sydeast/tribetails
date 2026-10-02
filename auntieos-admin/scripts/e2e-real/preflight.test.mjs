import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { disconnectRisks, isForbiddenNumber, MARKER, plan, render } from './preflight.mjs';

/**
 * The refusals are the safety property of the real-services run (#1089): if
 * one of these stops refusing, a run can hand a live Stripe key, a real phone
 * line or the production Google grant to a test. Every phone number below is
 * from the 555-0100..0199 block, which is reserved for fiction; only the AREA
 * CODE is what the guard reads.
 */

const DECLARED = ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'TWILIO_FROM_NUMBER', 'TRIBE_PIN_PEPPER'];

describe('isForbiddenNumber', () => {
  it('refuses the two area codes in every common spelling', () => {
    for (const n of ['+18055550100', '18055550100', '8055550100', '(805) 555-0100', '+1 989 555 0199', '989.555.0199']) {
      expect(isForbiddenNumber(n), n).toBe(true);
    }
  });

  it('lets the Twilio test sender and other area codes through', () => {
    for (const n of ['+15005550006', '+15125550100', '', 'AC_e2e_not_configured']) {
      expect(isForbiddenNumber(n), n).toBe(false);
    }
  });
});

describe('plan', () => {
  it('writes every declared secret with a non-empty value when nothing is provided', () => {
    const { values, refusals, available } = plan(DECLARED, {});
    expect(refusals).toEqual([]);
    for (const name of DECLARED) expect(values[name], name).toMatch(/.+/);
    // A placeholder Stripe key is still test-shaped, so the guard holds for the file as a whole.
    expect(values.STRIPE_SECRET_KEY).toMatch(/^sk_test_/);
    expect(available.stripe).toBe(false);
  });

  it('uses provided test keys and reports the vendor as configured', () => {
    const { values, refusals, available } = plan(DECLARED, {
      STRIPE_TEST_SECRET_KEY: 'sk_test_abc',
      STRIPE_TEST_PUBLISHABLE_KEY: 'pk_test_abc',
    });
    expect(refusals).toEqual([]);
    expect(values.STRIPE_SECRET_KEY).toBe('sk_test_abc');
    expect(available.stripe).toBe(true);
  });

  it('refuses a live Stripe key, whichever variable it arrives in', () => {
    expect(plan(DECLARED, { STRIPE_TEST_SECRET_KEY: 'sk_live_abc' }).refusals.join('\n')).toMatch(
      /STRIPE_SECRET_KEY: not a Stripe test-mode value/,
    );
    expect(plan(DECLARED, { STRIPE_TEST_PUBLISHABLE_KEY: 'pk_live_abc' }).refusals.join('\n')).toMatch(
      /STRIPE_PUBLISHABLE_KEY/,
    );
    // Set in the shell but bound to nothing: still about to be inherited by the emulator.
    expect(plan(DECLARED, { STRIPE_SECRET_KEY: 'sk_live_abc' }).refusals.join('\n')).toMatch(
      /STRIPE_SECRET_KEY \(environment\)/,
    );
  });

  it('refuses a Twilio sender in a forbidden area code', () => {
    const { refusals } = plan(DECLARED, { TWILIO_TEST_FROM_NUMBER: '+18055550100' });
    expect(refusals.join('\n')).toMatch(/TWILIO_FROM_NUMBER: names a phone number in a forbidden area code/);
  });

  it('refuses a value with a line break, which would smuggle a second key into the file', () => {
    const { refusals } = plan(DECLARED, { STRIPE_TEST_SECRET_KEY: 'sk_test_a\nSENTRY_DSN=x' });
    expect(refusals.join('\n')).toMatch(/line break/);
  });
});

describe('render', () => {
  it('starts with the marker run.sh and the overwrite guard look for', () => {
    expect(render({ A: 'x' }).split('\n')[0]).toBe(MARKER);
  });
});

describe('disconnectRisks', () => {
  function specDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-specs-'));
    mkdirSync(join(dir, 'nested'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  it('flags a spec that names the callable or the control', () => {
    const dir = specDir({
      'a.cy.ts': "cy.intercept('**/disconnectGoogleCalendar')",
      'nested/b.cy.ts': "cy.contains('button', 'Disconnect').click()",
    });
    const risks = disconnectRisks(dir).join('\n');
    expect(risks).toMatch(/a\.cy\.ts: names the disconnectGoogleCalendar callable/);
    expect(risks).toMatch(/b\.cy\.ts: names the Disconnect control/);
  });

  it('passes a clean spec directory', () => {
    expect(disconnectRisks(specDir({ 'c.cy.ts': "cy.contains('button', 'Connect')" }))).toEqual([]);
  });
});
