import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { classify, extractVendorErrors, isOutageShaped, VENDORS } from './classify-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The D3-e rule (#1089, #1196): our integration failing stops the release; a
 * vendor outage only warns, and only when the call got a 5xx or timed out AND
 * the vendor's status page listed an incident at that moment. 4xx, auth and
 * payload errors always stop, and anything the classifier cannot prove stops.
 *
 * Fixtures below are shaped like the real inputs: `results` like the trimmed
 * `after:run` object `cypress.real.config.ts` writes, log lines like
 * `mytribe/functions/src/lib/logger.ts`'s `logEvent` output as teed into
 * `cypress/.real/emulators.log`, status answers like Statuspage's
 * `/api/v2/incidents.json` and Google Workspace's `incidents.json`.
 */

const SPEC_START = '2026-10-23T15:00:00.000Z';
const SPEC_END = '2026-10-23T15:02:00.000Z';
const DURING = '2026-10-23T15:01:00.000Z';
const NOW = Date.parse('2026-10-23T15:05:00.000Z');

function results(tests, { error = null } = {}) {
  return {
    totalTests: tests.length,
    totalPassed: tests.filter((t) => t.state === 'passed').length,
    totalFailed: tests.filter((t) => t.state === 'failed').length,
    totalPending: 0,
    runs: [
      {
        spec: { relative: 'cypress/e2e-real/invoice-paid-stripe.cy.ts' },
        error,
        stats: { startedAt: SPEC_START, endedAt: SPEC_END },
        tests,
      },
    ],
  };
}

const failedHarness = {
  title: ['invoice paid', 'records a payment'],
  state: 'failed',
  displayError:
    "AssertionError: error lines our functions logged during this test (harness condition): expected [ Array(1) ] to deeply equal []\n    at Context.eval (webpack:///./cypress/e2e-real/invoice-paid-stripe.cy.ts:42:10)",
};

function logLine(fields, ts = DURING) {
  return `>  ${JSON.stringify({ ts, severity: 'error', function: 'markInvoicePaid', event: 'vendor_failed', ...fields })}`;
}

function statuspage(incidents) {
  return { page: { id: 'x', name: 'Vendor' }, incidents };
}

const STRIPE_INCIDENT = {
  name: 'Elevated API error rates',
  status: 'investigating',
  created_at: '2026-10-23T14:50:00.000Z',
  started_at: '2026-10-23T14:50:00.000Z',
  resolved_at: null,
  shortlink: 'https://stspg.io/example',
};

/** A fetch that answers each status URL from [byUrl], and records what it was asked. */
function fakeFetch(byUrl) {
  return vi.fn(async (url) => {
    const answer = byUrl[url];
    if (answer === undefined) throw new Error(`unexpected fetch ${url}`);
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return { ok: false, status: answer, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  });
}

const STRIPE_URL = VENDORS.stripe.status.url;
const SMTP_URL = VENDORS.email.status.url;

describe('classify: the verdict rule', () => {
  it('a 4xx from the vendor stops, without asking the status page', async () => {
    const fetchImpl = fakeFetch({});
    const v = await classify({
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'Stripe refused the request: statusCode: 402 card_declined' }),
      cypressExit: 1,
      fetchImpl,
      now: NOW,
    });
    expect(v.verdict).toBe('stop');
    expect(v.reasons.join('\n')).toMatch(/stripe answered 402: our request/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a 5xx while the status page lists an incident warns, with the incident as evidence', async () => {
    const v = await classify({
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'smtp2go send failed (HTTP 503): service unavailable' }),
      cypressExit: 1,
      fetchImpl: fakeFetch({ [SMTP_URL]: statuspage([{ ...STRIPE_INCIDENT, name: 'Delayed sending' }]) }),
      now: NOW,
    });
    expect(v.verdict).toBe('warn');
    expect(v.reasons.join('\n')).toMatch(/warn: .*email 503 during "Delayed sending"/);
    expect(v.statusPages.email.ok).toBe(true);
    expect(v.failures[0].vendorErrors[0]).toMatchObject({ vendor: 'email', status: 503 });
  });

  it('a 5xx with no incident on the status page stops', async () => {
    const v = await classify({
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'smtp2go send failed (HTTP 502): bad gateway' }),
      cypressExit: 1,
      fetchImpl: fakeFetch({ [SMTP_URL]: statuspage([]) }),
      now: NOW,
    });
    expect(v.verdict).toBe('stop');
    expect(v.reasons.join('\n')).toMatch(/email 502 with no incident on its status page/);
  });

  it('a timeout while the status page lists an incident warns', async () => {
    const v = await classify({
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'Stripe request to api.stripe.com failed: ETIMEDOUT' }),
      cypressExit: 1,
      fetchImpl: fakeFetch({ [STRIPE_URL]: statuspage([STRIPE_INCIDENT]) }),
      now: NOW,
    });
    expect(v.verdict).toBe('warn');
    expect(v.reasons.join('\n')).toMatch(/stripe timeout during "Elevated API error rates"/);
  });

  it('a status page that does not answer stops (fail closed), whatever the error was', async () => {
    for (const answer of [new Error('getaddrinfo ENOTFOUND'), 503, { not: 'a statuspage answer' }]) {
      const v = await classify({
        results: results([failedHarness]),
        logText: logLine({ errorMessage: 'Stripe API error: statusCode: 500' }),
        cypressExit: 1,
        fetchImpl: fakeFetch({ [STRIPE_URL]: answer }),
        now: NOW,
      });
      expect(v.verdict, JSON.stringify(String(answer))).toBe('stop');
      expect(v.reasons.join('\n')).toMatch(/stripe status page did not answer/);
      expect(v.statusPages.stripe.ok).toBe(false);
    }
  });

  it('an auth error stops even when it also reads as a 5xx', async () => {
    const v = await classify({
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'Twilio: authentication failed (status 500 from proxy)' }),
      cypressExit: 1,
      fetchImpl: fakeFetch({}),
      now: NOW,
    });
    expect(v.verdict).toBe('stop');
    expect(v.reasons.join('\n')).toMatch(/twilio refused our credentials/);
  });

  it('one 4xx beside an outage-shaped 5xx in the same failure stops', async () => {
    const v = await classify({
      results: results([failedHarness]),
      logText: [
        logLine({ errorMessage: 'Stripe API error: statusCode: 503' }),
        logLine({ errorMessage: 'Stripe invalid_request_error: statusCode: 400' }),
      ].join('\n'),
      cypressExit: 1,
      fetchImpl: fakeFetch({ [STRIPE_URL]: statuspage([STRIPE_INCIDENT]) }),
      now: NOW,
    });
    expect(v.verdict).toBe('stop');
  });

  it('a failure with no vendor error in it is our integration and stops', async () => {
    const v = await classify({
      results: results([
        { title: ['tags', 'removes a tag'], state: 'failed', displayError: "AssertionError: expected 'All tags' to not include 'E2E'" },
      ]),
      logText: '',
      cypressExit: 1,
      fetchImpl: fakeFetch({}),
      now: NOW,
    });
    expect(v.verdict).toBe('stop');
    expect(v.reasons.join('\n')).toMatch(/no vendor error .*our integration/);
  });

  it('a vendor error with no status code or timeout stops', async () => {
    const v = await classify({
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'Cloudinary upload failed: Invalid image file' }),
      cypressExit: 1,
      fetchImpl: fakeFetch({}),
      now: NOW,
    });
    expect(v.verdict).toBe('stop');
    expect(v.reasons.join('\n')).toMatch(/cloudinary error with no status code or timeout/);
  });

  it('an incident that ended before the failure does not cover it; one that ended after still does', async () => {
    const before = { ...STRIPE_INCIDENT, resolved_at: '2026-10-23T14:55:00.000Z' };
    const after = { ...STRIPE_INCIDENT, resolved_at: '2026-10-23T15:03:00.000Z' };
    const input = {
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'Stripe API error: statusCode: 500' }),
      cypressExit: 1,
      now: NOW,
    };
    expect((await classify({ ...input, fetchImpl: fakeFetch({ [STRIPE_URL]: statuspage([before]) }) })).verdict).toBe('stop');
    expect((await classify({ ...input, fetchImpl: fakeFetch({ [STRIPE_URL]: statuspage([after]) }) })).verdict).toBe('warn');
  });

  it('a log line outside the failing spec’s window is not its evidence', async () => {
    const v = await classify({
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'Stripe API error: statusCode: 503' }, '2026-10-23T14:00:00.000Z'),
      cypressExit: 1,
      fetchImpl: fakeFetch({ [STRIPE_URL]: statuspage([STRIPE_INCIDENT]) }),
      now: NOW,
    });
    expect(v.verdict).toBe('stop');
    expect(v.reasons.join('\n')).toMatch(/no vendor error/);
  });

  it('Google Calendar counts only incidents on the Calendar product', async () => {
    const google = [
      { begin: '2026-10-23T14:00:00+00:00', end: null, service_name: 'Gmail', affected_products: [{ title: 'Gmail' }], external_desc: 'Gmail delays', uri: 'incidents/a' },
    ];
    const input = {
      results: results([failedHarness]),
      logText: logLine({ errorMessage: 'Google Calendar insert failed: HTTP 503' }),
      cypressExit: 1,
      now: NOW,
    };
    const url = VENDORS.googleCalendar.status.url;
    expect((await classify({ ...input, fetchImpl: fakeFetch({ [url]: google }) })).verdict).toBe('stop');
    const calendar = [{ ...google[0], service_name: 'Google Calendar', affected_products: [{ title: 'Google Calendar' }], external_desc: 'Calendar errors' }];
    expect((await classify({ ...input, fetchImpl: fakeFetch({ [url]: calendar }) })).verdict).toBe('warn');
  });
});

describe('classify: the run as a whole', () => {
  it('passes with no failed test and a zero exit', async () => {
    const v = await classify({
      results: results([{ title: ['a'], state: 'passed', displayError: null }]),
      cypressExit: 0,
      fetchImpl: fakeFetch({}),
      now: NOW,
    });
    expect(v.verdict).toBe('pass');
    expect(v.reasons).toEqual(['pass: 1 passed, 0 pending, none failed']);
  });

  it('stops when there are no results, Cypress could not run, or a spec did not load', async () => {
    const fetchImpl = fakeFetch({});
    expect((await classify({ results: null, cypressExit: 1, fetchImpl, now: NOW })).reasons).toEqual([
      'stop: Cypress produced no results',
    ]);
    expect((await classify({ results: { status: 'failed', message: 'no specs' }, cypressExit: 1, fetchImpl, now: NOW })).verdict).toBe('stop');
    expect((await classify({ results: results([], { error: 'Error: Webpack compilation failed' }), cypressExit: 1, fetchImpl, now: NOW })).verdict).toBe('stop');
  });

  it('stops when Cypress exited non-zero but no test failed', async () => {
    const v = await classify({ results: results([]), cypressExit: 3, fetchImpl: fakeFetch({}), now: NOW });
    expect(v.verdict).toBe('stop');
    expect(v.reasons).toEqual(['stop: Cypress exited 3 with no failed test in its results']);
  });

  it('any stopping failure stops the run even beside an outage', async () => {
    const r = results([failedHarness]);
    // A second spec, later, failing on its own assertion with nothing from a vendor.
    r.runs.push({
      spec: { relative: 'cypress/e2e-real/settings-tags.cy.ts' },
      error: null,
      stats: { startedAt: '2026-10-23T15:03:00.000Z', endedAt: '2026-10-23T15:04:00.000Z' },
      tests: [{ title: ['tags'], state: 'failed', displayError: 'AssertionError: expected 1 to equal 2' }],
    });
    const v = await classify({
      results: r,
      logText: logLine({ errorMessage: 'Stripe API error: statusCode: 503' }),
      cypressExit: 1,
      fetchImpl: fakeFetch({ [STRIPE_URL]: statuspage([STRIPE_INCIDENT]) }),
      now: NOW,
    });
    expect(v.failures.map((f) => f.outcome)).toEqual(['warn', 'stop']);
    expect(v.verdict).toBe('stop');
  });
});

describe('extractVendorErrors', () => {
  it('ignores Cypress’s own retry and task timeouts', () => {
    const e = extractVendorErrors("Timed out retrying after 15000ms: Expected to find content: 'Pay with Stripe'");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ vendor: 'stripe', status: null, timeout: false });
    expect(isOutageShaped(e[0])).toBe(false);
  });

  it('a 4xx is never outage-shaped, even beside a timeout word', () => {
    const [e] = extractVendorErrors('Stripe retry gave up after ETIMEDOUT, last answer HTTP 400');
    expect(e).toMatchObject({ vendor: 'stripe', status: 400, timeout: true });
    expect(isOutageShaped(e)).toBe(false);
  });

  it('ignores stack frames that name a vendor’s spec file', () => {
    expect(extractVendorErrors('    at Context.eval (webpack:///./cypress/e2e-real/invoice-paid-stripe.cy.ts:42:10)')).toEqual([]);
  });

  it('reads the status from the shapes our code and the SDKs print', () => {
    const cases = [
      ['smtp2go send failed (HTTP 503): x', 503],
      ['Stripe refused the fixture session: 502 upstream', 502],
      ['{"vendor":"twilio","status":500}', 500],
      ['cloudinary {"http_code":420}', 420],
      ['StripeAPIError statusCode: 500', 500],
    ];
    for (const [text, status] of cases) expect(extractVendorErrors(text)[0]?.status, text).toBe(status);
  });
});

/**
 * The contract the release reads: the file on disk and the exit code. These
 * run the real script with the real `node`; neither case asks a status page.
 */
describe('classify-run.mjs as run.sh calls it', () => {
  /** Environment with no Cloudinary credentials, so the cleanup in on_exit is a skip and touches no network. */
  function bareEnv() {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('E2E_CLOUDINARY_')) delete env[k];
    return env;
  }

  function cli(dir, cypressExit) {
    return spawnSync(
      process.execPath,
      [
        join(HERE, 'classify-run.mjs'),
        '--results', join(dir, 'results.json'),
        '--log', join(dir, 'emulators.log'),
        '--out', join(dir, 'verdict.json'),
        '--cypress-exit', String(cypressExit),
      ],
      { encoding: 'utf8', env: bareEnv() },
    );
  }

  it('writes a stop verdict and exits 1 when there is no results file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-classify-'));
    const r = cli(dir, 1);
    expect(r.status).toBe(1);
    const v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
    expect(v.verdict).toBe('stop');
    expect(v.cypressExit).toBe(1);
    expect(v.reasons).toEqual(['stop: Cypress produced no results']);
    expect(r.stdout).toMatch(/verdict STOP/);
  });

  it('writes a pass verdict and exits 0 on a green run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-classify-'));
    writeFileSync(join(dir, 'results.json'), JSON.stringify(results([{ title: ['a'], state: 'passed', displayError: null }])));
    const r = cli(dir, 0);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')).verdict).toBe('pass');
  });

  it('exits 2 with a usage line when a path is missing', () => {
    const r = spawnSync(process.execPath, [join(HERE, 'classify-run.mjs'), '--results', 'x'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: classify-run\.mjs/);
  });

  it('run.sh on_exit leaves a stop verdict when the run ended before Cypress, and keeps the exit code', () => {
    const src = readFileSync(join(HERE, 'run.sh'), 'utf8');
    const fn = src.match(/^on_exit\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(fn, 'on_exit in run.sh').toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-onexit-'));
    const script = [
      'set -euo pipefail',
      `SCRIPT_DIR=${JSON.stringify(HERE)}`,
      `REAL_DIR=${JSON.stringify(dir)}`,
      `VERDICT=${JSON.stringify(join(dir, 'verdict.json'))}`,
      `RESULTS=${JSON.stringify(join(dir, 'results.json'))}`,
      `LOG=${JSON.stringify(join(dir, 'emulators.log'))}`,
      `SECRETS_FILE=${JSON.stringify(join(dir, 'none'))}`,
      fn,
      'trap on_exit EXIT',
      // A preflight refusal, say: the run never reached Cypress.
      'exit 4',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: bareEnv() });
    expect(r.status).toBe(4);
    expect(existsSync(join(dir, 'verdict.json'))).toBe(true);
    const v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
    expect(v.verdict).toBe('stop');
    expect(v.cypressExit).toBe(4);
    expect(r.stdout).toMatch(/cloudinary-cleanup: skipped/);
  });
});
