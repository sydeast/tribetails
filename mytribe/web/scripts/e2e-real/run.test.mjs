import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classify } from '../../../../auntieos-admin/scripts/e2e-real/classify-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_E2E_DIR = resolve(HERE, '../../../../auntieos-admin/scripts/e2e-real');

/**
 * The portal run classifies itself under D3-e with the admin's classifier
 * (#1533), the same two call sites as the admin run.sh: once after Cypress,
 * and once in `on_exit` for a run that never reached Cypress. The contract the
 * release reads is the verdict file on disk and the exit code, so these cases
 * run the real `on_exit` (extracted from run.sh, not copied) and check both.
 */
describe('portal run.sh on_exit', () => {
  /** run.sh's real `on_exit` under a `node` that behaves as [fakeNode] says, or the real one. */
  function runOnExit(exitCode, { fakeNode = null, verdict = null } = {}) {
    const src = readFileSync(join(HERE, 'run.sh'), 'utf8');
    const fn = src.match(/^on_exit\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(fn, 'on_exit in run.sh').toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-portal-onexit-'));
    let path = process.env.PATH;
    if (fakeNode !== null) {
      const bin = join(dir, 'node');
      writeFileSync(bin, fakeNode);
      chmodSync(bin, 0o755);
      path = `${dir}:${process.env.PATH}`;
    }
    if (verdict !== null) writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
    const script = [
      'set -euo pipefail',
      `ADMIN_E2E_DIR=${JSON.stringify(ADMIN_E2E_DIR)}`,
      `REAL_DIR=${JSON.stringify(dir)}`,
      `VERDICT=${JSON.stringify(join(dir, 'verdict.json'))}`,
      `RESULTS=${JSON.stringify(join(dir, 'results.json'))}`,
      `LOG=${JSON.stringify(join(dir, 'emulators.log'))}`,
      `SECRETS_FILE=${JSON.stringify(join(dir, 'none'))}`,
      'STRIPE_PID=""',
      fn,
      'trap on_exit EXIT',
      `exit ${exitCode}`,
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: path }, encoding: 'utf8' });
    return { ...r, dir };
  }

  it('leaves a stop verdict when the run ended before Cypress, and keeps the exit code', () => {
    // A preflight refusal, say: no results file was ever written.
    const r = runOnExit(4);
    expect(r.status).toBe(4);
    expect(existsSync(join(r.dir, 'verdict.json'))).toBe(true);
    const v = JSON.parse(readFileSync(join(r.dir, 'verdict.json'), 'utf8'));
    expect(v.verdict).toBe('stop');
    expect(v.cypressExit).toBe(4);
    expect(v.reasons).toEqual(['stop: Cypress produced no results']);
  });

  it('calls the admin classifier with the portal paths and keeps the run’s exit code when it fails', () => {
    for (const code of [0, 1, 7]) {
      const r = runOnExit(code, { fakeNode: '#!/bin/sh\necho "fake node $*"\nexit 1\n' });
      expect(r.status, `exit ${code}`).toBe(code);
      // The classifier's own output is silenced in on_exit; the fake proves the call by writing the verdict.
      expect(existsSync(join(r.dir, 'verdict.json'))).toBe(false);
    }
    const r = runOnExit(3, { fakeNode: '#!/bin/sh\nprintf "%s" "$*" > "$(dirname "$0")/call"\necho "{}" > "$(dirname "$0")/verdict.json"\nexit 1\n' });
    expect(r.status).toBe(3);
    const call = readFileSync(join(r.dir, 'call'), 'utf8');
    expect(call).toContain(`${ADMIN_E2E_DIR}/classify-run.mjs`);
    expect(call).toContain(`--results ${join(r.dir, 'results.json')}`);
    expect(call).toContain(`--log ${join(r.dir, 'emulators.log')}`);
    expect(call).toContain(`--out ${join(r.dir, 'verdict.json')}`);
    expect(call).toContain('--cypress-exit 3');
  });

  it('does not classify again when the run already wrote its verdict after Cypress', () => {
    // on_exit silences the classifier's stdout, so the fake proves a call by
    // writing a marker file, and the case checks that no marker appeared.
    const r = runOnExit(1, {
      fakeNode: '#!/bin/sh\nprintf "%s" "$*" > "$(dirname "$0")/call"\nexit 0\n',
      verdict: { verdict: 'stop', reasons: ['stop: x'] },
    });
    expect(r.status).toBe(1);
    expect(existsSync(join(r.dir, 'call'))).toBe(false);
    expect(JSON.parse(readFileSync(join(r.dir, 'verdict.json'), 'utf8'))).toEqual({ verdict: 'stop', reasons: ['stop: x'] });
  });
});

describe('portal run.sh calls the classifier after Cypress', () => {
  it('names the admin classifier, the portal results and log, and exits with its code', () => {
    const src = readFileSync(join(HERE, 'run.sh'), 'utf8');
    const after = src.split('== e2e-real (portal): classifying the run')[1] ?? '';
    expect(after).toMatch(/node "\$ADMIN_E2E_DIR\/classify-run\.mjs" --results "\$RESULTS" --log "\$LOG" --out "\$VERDICT" --cypress-exit "\$status"/);
    expect(after).toMatch(/verdict_status=\$\?/);
    expect(after.trim().endsWith('exit "$verdict_status"')).toBe(true);
    // The earlier run's files are removed before the trap, so neither can be read as this run's.
    expect(src).toMatch(/rm -f "\$RESULTS" "\$VERDICT"\ntrap on_exit EXIT/);
    expect(src).toMatch(/RESULTS="\$REAL_DIR\/results\.json"/);
    expect(src).toMatch(/VERDICT="\$REAL_DIR\/verdict\.json"/);
  });
});

/**
 * The classifier needs no portal-only change: a failure on the webhook side
 * (`stripeWebhook`, the function that settles a portal payment) attributes to
 * the Stripe vendor through the same `\bstripe` match, and the D3-e rules
 * apply unchanged.
 */
describe('the admin classifier reads a portal run', () => {
  const START = '2026-11-04T15:00:00.000Z';
  const END = '2026-11-04T15:02:00.000Z';
  const NOW = Date.parse('2026-11-04T15:05:00.000Z');

  function results(state, displayError = null) {
    return {
      totalTests: 2,
      totalPassed: state === 'passed' ? 2 : 1,
      totalFailed: state === 'failed' ? 1 : 0,
      totalPending: 0,
      runs: [
        {
          spec: { relative: 'cypress/e2e-real/pay-invoice-stripe.cy.ts' },
          error: null,
          stats: { startedAt: START, endedAt: END },
          tests: [
            { title: ['invoice-open', 'lists the invoice'], state: 'passed', displayError: null },
            { title: ['pay-invoice-stripe', 'pays by card'], state, displayError },
          ],
        },
      ],
    };
  }

  it('stops on a stripeWebhook 400 in the emulator log during the pay spec', async () => {
    const logText = `${JSON.stringify({ severity: 'error', ts: '2026-11-04T15:01:00.000Z', fn: 'stripeWebhook', message: 'stripeWebhook: signature check failed, status 400' })}\n`;
    const v = await classify({ results: results('failed', 'AssertionError: expected PAID'), logText, cypressExit: 1, now: NOW, fetchImpl: async () => { throw new Error('must not be asked'); } });
    expect(v.verdict).toBe('stop');
    expect(v.failures[0].vendorErrors[0].vendor).toBe('stripe');
    expect(v.reasons.join('\n')).toMatch(/stripe answered 400: our request/);
  });

  it('warns on a stripeWebhook 503 inside a listed Stripe incident', async () => {
    const logText = `${JSON.stringify({ severity: 'error', ts: '2026-11-04T15:01:00.000Z', fn: 'stripeWebhook', message: 'stripeWebhook: api.stripe.com answered HTTP 503' })}\n`;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ incidents: [{ name: 'Elevated API errors', started_at: '2026-11-04T14:50:00.000Z', resolved_at: null, shortlink: 'https://stspg.io/x' }] }),
    });
    const v = await classify({ results: results('failed', 'AssertionError: expected PAID'), logText, cypressExit: 1, now: NOW, fetchImpl });
    expect(v.verdict).toBe('warn');
    expect(v.reasons.join('\n')).toMatch(/stripe 503 during "Elevated API errors"/);
  });

  it('passes a green portal run', async () => {
    const v = await classify({ results: results('passed'), logText: '', cypressExit: 0, now: NOW });
    expect(v.verdict).toBe('pass');
    expect(v.reasons).toEqual(['pass: 2 passed, 0 pending, none failed']);
  });
});
