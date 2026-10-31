import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { disconnectRisks } from '../../../../auntieos-admin/scripts/e2e-real/preflight.mjs';
import { portalPlan } from './preflight.mjs';

/**
 * The portal run imports the admin preflight's rules (#1194). These tests
 * re-assert the three refusals THROUGH the portal's entry point, so "the portal
 * run has the same refusals" is checked here rather than taken on trust from
 * the import, and they cover the one flag this file adds. Phone numbers are
 * from the 555-0100..0199 block, reserved for fiction; only the area code is
 * what the guard reads.
 */

const DECLARED = ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TWILIO_FROM_NUMBER'];
const KEYS = { STRIPE_TEST_SECRET_KEY: 'sk_test_abc', STRIPE_TEST_PUBLISHABLE_KEY: 'pk_test_abc' };

describe('portalPlan refusals (the admin rules, through the portal entry point)', () => {
  it('refuses a live Stripe key', () => {
    expect(portalPlan(DECLARED, { ...KEYS, STRIPE_TEST_SECRET_KEY: 'sk_live_abc' }).refusals.join('\n')).toMatch(
      /STRIPE_SECRET_KEY: not a Stripe test-mode value/,
    );
  });

  it('refuses a webhook secret that is not a whsec_ value', () => {
    expect(portalPlan(DECLARED, { ...KEYS, STRIPE_TEST_WEBHOOK_SECRET: 'not-a-secret' }).refusals.join('\n')).toMatch(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });

  it('refuses a Twilio sender in either forbidden area code', () => {
    for (const n of ['+18055550100', '(989) 555-0199']) {
      expect(portalPlan(DECLARED, { TWILIO_TEST_FROM_NUMBER: n }).refusals.join('\n'), n).toMatch(
        /TWILIO_FROM_NUMBER: names a phone number in a forbidden area code/,
      );
    }
  });

  it('refuses a real-suite spec that names Google Calendar Disconnect', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-e2e-real-'));
    writeFileSync(join(dir, 'bad.cy.ts'), "cy.contains('button', 'Disconnect').click();\n");
    writeFileSync(join(dir, 'ok.cy.ts'), "cy.contains('button', 'Pay with Credit Card').click();\n");
    const risks = disconnectRisks(dir);
    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatch(/bad\.cy\.ts: names the Disconnect control/);
  });
});

describe('portalPlan stripeWebhook availability', () => {
  it('is false with no Stripe keys at all', () => {
    const { available, refusals } = portalPlan(DECLARED, {});
    expect(refusals).toEqual([]);
    expect(available.stripe).toBe(false);
    expect(available.stripeWebhook).toBe(false);
  });

  it('is false with keys but no forwarder secret, while stripe alone reads configured', () => {
    const { available } = portalPlan(DECLARED, KEYS);
    expect(available.stripe).toBe(true);
    expect(available.stripeWebhook).toBe(false);
  });

  it('is false with a forwarder secret but no keys', () => {
    const { available } = portalPlan(DECLARED, { STRIPE_TEST_WEBHOOK_SECRET: 'whsec_abc' });
    expect(available.stripeWebhook).toBe(false);
  });

  it('is true with keys and a whsec_ secret, and writes that secret to the file', () => {
    const { available, values, refusals } = portalPlan(DECLARED, { ...KEYS, STRIPE_TEST_WEBHOOK_SECRET: 'whsec_abc' });
    expect(refusals).toEqual([]);
    expect(available.stripeWebhook).toBe(true);
    expect(values.STRIPE_WEBHOOK_SECRET).toBe('whsec_abc');
  });
});
