import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIRM_STEPS, confirmCheckoutByCli, confirmFixture, redact } from './stripe-confirm.mjs';

/**
 * `stripe-confirm.mjs` pays the pay spec's Checkout Session through the Stripe
 * CLI (#2304). The CLI and Stripe are not reachable from a unit test, so these
 * cases hand it a stand-in for `spawnSync` and check what it was asked to run,
 * what is refused before anything runs, and what a refusal from Stripe looks
 * like once it has been through the redaction.
 */

const KEY = `sk_test_${'k3Y'.repeat(10)}`;
const SESSION = `cs_test_${'a1B2'.repeat(12)}`;
const INPUT = { sessionId: SESSION, amountCents: 4200, email: 'catch@hanasamku.com', name: 'The Wren Household' };
const ALL_STEPS = CONFIRM_STEPS.map((s) => `Setting up fixture for: ${s}\nRunning fixture for: ${s}`).join('\n');

/** A `spawnSync` stand-in that records its call and reads the fixture file while it still exists. */
function fakeSpawn(result) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options, fixture: JSON.parse(readFileSync(args[1], 'utf8')) });
    return result;
  };
  return { spawn, calls };
}

describe('confirmFixture', () => {
  it('is the CLI trigger’s three steps, aimed at the given session and amount', () => {
    const { fixtures } = confirmFixture(INPUT);
    expect(fixtures.map((f) => `${f.method} ${f.path}`)).toEqual([
      `get /v1/payment_pages/${SESSION}`,
      'post /v1/payment_methods',
      `post /v1/payment_pages/${SESSION}/confirm`,
    ]);
    expect(fixtures.map((f) => f.name)).toEqual(CONFIRM_STEPS);
    expect(fixtures[1].params.card).toEqual({ token: 'tok_visa' });
    expect(fixtures[1].params.billing_details.email).toBe('catch@hanasamku.com');
    expect(fixtures[2].params).toEqual({ payment_method: '${payment_method:id}', expected_amount: 4200 });
  });
});

describe('confirmCheckoutByCli', () => {
  it('runs `stripe fixtures` on that file with the key in the environment, and removes the file', () => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: ALL_STEPS, stderr: '' });
    const ran = confirmCheckoutByCli(INPUT, { env: { STRIPE_TEST_SECRET_KEY: KEY, PATH: '/bin' }, spawn });
    expect(ran).toEqual(CONFIRM_STEPS);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('stripe');
    expect(calls[0].args[0]).toBe('fixtures');
    expect(calls[0].args.join(' ')).not.toContain(KEY);
    expect(calls[0].options.env.STRIPE_API_KEY).toBe(KEY);
    expect(calls[0].fixture.fixtures[2].path).toBe(`/v1/payment_pages/${SESSION}/confirm`);
    expect(existsSync(calls[0].args[1])).toBe(false);
  });

  it.each([
    ['no key', {}],
    ['a live key', { STRIPE_TEST_SECRET_KEY: `sk_live_${'x'.repeat(24)}` }],
    ['a publishable key', { STRIPE_TEST_SECRET_KEY: `pk_test_${'x'.repeat(24)}` }],
  ])('refuses %s before the CLI runs', (_label, env) => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: ALL_STEPS, stderr: '' });
    expect(() => confirmCheckoutByCli(INPUT, { env, spawn })).toThrow(/REFUSED: STRIPE_TEST_SECRET_KEY/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a live session', `cs_live_${'a1B2'.repeat(12)}`],
    ['a session id with a path in it', `${SESSION}/../x`],
    ['no session', undefined],
  ])('refuses %s before the CLI runs', (_label, sessionId) => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: ALL_STEPS, stderr: '' });
    expect(() => confirmCheckoutByCli({ ...INPUT, sessionId }, { env: { STRIPE_TEST_SECRET_KEY: KEY }, spawn })).toThrow(
      /REFUSED: the Checkout Session is not a test-mode session/,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses an amount that is not a positive whole number of cents', () => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: ALL_STEPS, stderr: '' });
    for (const amountCents of [0, -1, 42.5, '4200']) {
      expect(() => confirmCheckoutByCli({ ...INPUT, amountCents }, { env: { STRIPE_TEST_SECRET_KEY: KEY }, spawn })).toThrow(
        /REFUSED: expected amount/,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it('throws Stripe’s answer when a step is refused, naming the step, with the session id and key cut out', () => {
    const body = `{"error":{"message":"No such payment_page: '${SESSION}'","type":"invalid_request_error"}}`;
    const { spawn } = fakeSpawn({
      status: 1,
      stdout: 'Setting up fixture for: payment_page\nRunning fixture for: payment_page\n',
      stderr: `Request failed, status=404, body=${body} (key ${KEY})`,
    });
    let message = '';
    try {
      confirmCheckoutByCli(INPUT, { env: { STRIPE_TEST_SECRET_KEY: KEY }, spawn });
    } catch (error) {
      message = String(error.message);
    }
    expect(message).toContain('Stripe refused the test payment. Last step started: payment_page.');
    expect(message).toContain('status=404');
    expect(message).toContain('No such payment_page');
    expect(message).toContain('invalid_request_error');
    expect(message).not.toContain(SESSION);
    expect(message).not.toContain(KEY);
    expect(message).not.toMatch(/cs_test_[A-Za-z0-9]{8,}/);
  });

  it('throws when the CLI cannot start', () => {
    const { spawn } = fakeSpawn({ status: null, stdout: '', stderr: '', error: new Error('spawnSync stripe ENOENT') });
    expect(() => confirmCheckoutByCli(INPUT, { env: { STRIPE_TEST_SECRET_KEY: KEY }, spawn })).toThrow(
      /the Stripe CLI could not run the test payment \(spawnSync stripe ENOENT\)/,
    );
  });

  it('throws when the CLI exits 0 without having run the confirm step', () => {
    const { spawn } = fakeSpawn({ status: 0, stdout: 'Running fixture for: payment_page\n', stderr: '' });
    expect(() => confirmCheckoutByCli(INPUT, { env: { STRIPE_TEST_SECRET_KEY: KEY }, spawn })).toThrow(
      /exited 0 without running the confirm step/,
    );
  });
});

describe('redact', () => {
  it('cuts Stripe ids and key-shaped words, and keeps the words around them', () => {
    const out = redact(`session ${SESSION} intent pi_3PabcDEF12345678 method pm_1Qabcdefgh1234 key ${KEY} whsec_abcDEF123`);
    expect(out).toBe('session cs_... intent pi_... method pm_... key sk_test_... whsec_...');
  });

  it('cuts the starred key Stripe echoes back, last four characters included', () => {
    // Stripe's real 401 body, as `stripe fixtures` 1.55.1 printed it for a made-up key.
    const body = '"message": "Invalid API Key provided: sk_test_*******************************t000",';
    expect(redact(body)).toBe('"message": "Invalid API Key provided: sk_test_...",');
  });

  it('cuts a literal it is given even when it has no known shape', () => {
    expect(redact('token oddly-shaped-value-123 here', ['oddly-shaped-value-123'])).toBe('token [redacted] here');
  });
});
