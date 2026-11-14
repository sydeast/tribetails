/**
 * Pays a Stripe test-mode Checkout Session without Stripe's hosted card form
 * (#2304). Called by the `stripeConfirmCheckout` task in
 * `cypress.real.config.ts`, for `cypress/e2e-real/pay-invoice-stripe.cy.ts`.
 *
 * WHY. Since 2026-11-14 Stripe serves a session at `/g/pay/` with its form in
 * a frame, and for an automated browser (`navigator.webdriver` true) that
 * frame stays 2 px tall: no field, no button, in Electron 146 (run
 * 43629608013) and in Chrome 157 (run 43632254872). There is nothing on the
 * page for a spec to type into.
 *
 * HOW. The same three requests the Stripe CLI's own
 * `stripe trigger checkout.session.completed` makes (its fixture
 * `pkg/fixtures/triggers/checkout.session.completed.json`, read at v1.55.1 and
 * unchanged on its main branch on 2026-11-14), sent by `stripe fixtures`, but
 * against the session OUR `payInvoice` created instead of one the CLI makes:
 *
 *   1. GET  /v1/payment_pages/{session}
 *   2. POST /v1/payment_methods            card token `tok_visa`
 *   3. POST /v1/payment_pages/{session}/confirm   payment_method, expected_amount
 *
 * Stripe then completes the session for real, in test mode, and sends its own
 * signed `checkout.session.completed` and `payment_intent.succeeded` with the
 * metadata `payInvoice` put on the session. Nothing here builds an event,
 * signs one, or calls `stripeWebhook`.
 *
 * CAVEAT. `/v1/payment_pages` is the endpoint Stripe's CLI uses, not one in
 * Stripe's public API reference. If Stripe changes it, step 1 or 3 is refused
 * and this throws with Stripe's answer.
 *
 * NOTHING SECRET IS PRINTED. The key travels in the CLI's environment. Every
 * string that leaves this module goes through `redact`, which cuts Stripe
 * object ids (the session id among them) and anything key-shaped.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CONFIRM_STEPS = ['payment_page', 'payment_method', 'payment_page_confirm'];

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const TEST_SESSION = /^cs_test_[A-Za-z0-9]+$/;
const OUTPUT_MAX = 1500;

/** Stripe ids and key-shaped words cut out; [literals] (the key in use) cut out whole. */
export function redact(text, literals = []) {
  let out = String(text);
  for (const literal of literals) {
    if (typeof literal === 'string' && literal.length >= 8) out = out.split(literal).join('[redacted]');
  }
  return out
    // `*` too: Stripe echoes a refused key as sk_test_****abcd, last four kept.
    .replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, '$1_$2_...')
    .replace(/whsec_[A-Za-z0-9]+/g, 'whsec_...')
    .replace(/\b(cs|pi|pm|seti|cus|acct|ch|evt)_(test_|live_)?[A-Za-z0-9]{8,}/g, '$1_...');
}

/** The fixture file's content: the CLI trigger's three steps, aimed at [sessionId]. */
export function confirmFixture({ sessionId, amountCents, email, name }) {
  return {
    _meta: { template_version: 0 },
    fixtures: [
      { name: 'payment_page', path: `/v1/payment_pages/${sessionId}`, method: 'get' },
      {
        name: 'payment_method',
        path: '/v1/payment_methods',
        method: 'post',
        params: {
          type: 'card',
          card: { token: 'tok_visa' },
          // The address is the one in the CLI's own fixture: a test card needs
          // a plausible one, and no household's address belongs in a test.
          billing_details: {
            email,
            name,
            address: {
              line1: '354 Oyster Point Blvd',
              postal_code: '94080',
              city: 'South San Francisco',
              state: 'CA',
              country: 'US',
            },
          },
        },
      },
      {
        name: 'payment_page_confirm',
        path: `/v1/payment_pages/${sessionId}/confirm`,
        method: 'post',
        params: { payment_method: '${payment_method:id}', expected_amount: amountCents },
      },
    ],
  };
}

/**
 * Runs the three steps through `stripe fixtures`. Returns the step names the
 * CLI reported. Throws, with Stripe's answer redacted, when the key or the
 * session is not test mode, the CLI cannot start, a step is refused, or the
 * CLI ends without having run the confirm step.
 */
export function confirmCheckoutByCli({ sessionId, amountCents, email, name }, { env = process.env, spawn = spawnSync } = {}) {
  const key = env.STRIPE_TEST_SECRET_KEY ?? '';
  if (!TEST_KEY.test(key)) {
    throw new Error('REFUSED: STRIPE_TEST_SECRET_KEY is missing or is not a test-mode key; no payment was attempted');
  }
  if (typeof sessionId !== 'string' || !TEST_SESSION.test(sessionId)) {
    throw new Error('REFUSED: the Checkout Session is not a test-mode session (its id does not start cs_test_); no payment was attempted');
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`REFUSED: expected amount ${String(amountCents)} is not a positive whole number of cents`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'e2e-real-portal-stripe-confirm-'));
  const file = join(dir, 'confirm.fixture.json');
  let result;
  try {
    writeFileSync(file, JSON.stringify(confirmFixture({ sessionId, amountCents, email, name }), null, 2));
    // The key goes in the environment, not on the command line, as in run.sh.
    result = spawn('stripe', ['fixtures', file], {
      env: { ...env, STRIPE_API_KEY: key },
      encoding: 'utf8',
      timeout: 60_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const output = redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, [key, sessionId]).trim();
  const clipped = output.length > OUTPUT_MAX ? `...${output.slice(-OUTPUT_MAX)}` : output;
  const ran = CONFIRM_STEPS.filter((step) => output.includes(`Running fixture for: ${step}`));
  if (result.error) {
    throw new Error(`the Stripe CLI could not run the test payment (${redact(String(result.error.message), [key, sessionId])}). Its output: ${clipped}`);
  }
  if (result.status !== 0) {
    const at = ran[ran.length - 1] ?? 'none started';
    throw new Error(
      `Stripe refused the test payment. Last step started: ${at}. \`stripe fixtures\` exit ${String(result.status)}. Its output, Stripe's answer included: ${clipped}`,
    );
  }
  if (!ran.includes('payment_page_confirm')) {
    throw new Error(`\`stripe fixtures\` exited 0 without running the confirm step. Its output: ${clipped}`);
  }
  return ran;
}
