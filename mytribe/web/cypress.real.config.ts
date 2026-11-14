import { defineConfig } from 'cypress';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import seed, { remove, upsert } from './cypress/seed';

/**
 * Cypress config for the portal's REAL-SERVICES run (#1194, operator ruling D3,
 * 2026-10-01). `npm run e2e:real` starts it through `scripts/e2e-real/run.sh`;
 * never start it any other way, because that script writes the functions
 * secrets file, refuses an unsafe one, and starts the Stripe webhook forwarder.
 * The admin's `cypress.real.config.ts` (#1089) is the model; this differs only
 * where the portal does.
 *
 * WHAT IS DIFFERENT FROM `cypress.config.ts`. That config is the PR-time suite:
 * auth and Firestore emulators only, callables pinned at a dead port and
 * answered by `cypress/support/callables.ts`. Here the functions emulator
 * serves the real `mytribe/functions` build, so the access chain
 * (`getMyAccess`, `getMyHome`, `setActiveTribe`), `getMyInvoices` and
 * `payInvoice` run their real handlers, and a Stripe call really leaves the
 * machine in test mode. Specs live in `cypress/e2e-real/`, so neither suite
 * collects the other's files.
 *
 * TESTS STILL DRIVE AND ASSERT FROM THE UI (2026-09-01 ruling). The tasks
 * below set up fixtures, and read the emulator log for the support file's
 * harness condition (our functions' error lines). No spec asserts on the log.
 */

const PORT = 5173; // the portal's dev port, as in cypress.config.ts

/** Written by `run.sh`. Absent when someone ran `cypress open` by hand: every vendor then reads as not configured. */
const REAL_DIR = 'cypress/.real';
const VENDORS_FILE = `${REAL_DIR}/vendors.json`;
/** Read by the admin's `scripts/e2e-real/classify-run.mjs` for the D3-e verdict (#1196, #1533). */
const RESULTS_FILE = `${REAL_DIR}/results.json`;

/**
 * The run's results, trimmed to what the classifier reads. The full object
 * carries the resolved config, which has no business in an artifact. Same
 * shape as the admin config writes, so one classifier reads both.
 */
function writeRunResults(results: CypressCommandLine.CypressRunResult | CypressCommandLine.CypressFailedRunResult): void {
  mkdirSync(REAL_DIR, { recursive: true });
  const trimmed =
    'status' in results && results.status === 'failed'
      ? { status: 'failed', message: results.message }
      : {
          totalTests: (results as CypressCommandLine.CypressRunResult).totalTests,
          totalPassed: (results as CypressCommandLine.CypressRunResult).totalPassed,
          totalFailed: (results as CypressCommandLine.CypressRunResult).totalFailed,
          totalPending: (results as CypressCommandLine.CypressRunResult).totalPending,
          totalSkipped: (results as CypressCommandLine.CypressRunResult).totalSkipped,
          runs: (results as CypressCommandLine.CypressRunResult).runs.map((run) => ({
            spec: { relative: run.spec.relative },
            error: run.error,
            stats: run.stats,
            tests: run.tests.map((t) => ({ title: t.title, state: t.state, displayError: t.displayError })),
          })),
        };
  writeFileSync(RESULTS_FILE, JSON.stringify(trimmed, null, 2));
}

/** Which vendors have credentials in this run, as booleans only, never a value. */
function vendorAvailability(): Record<string, boolean> {
  if (!existsSync(VENDORS_FILE)) return {};
  const parsed = JSON.parse(readFileSync(VENDORS_FILE, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v === true]));
}

/** The emulator log `run.sh` tees. Empty string when the run was not started by it. */
const SERVER_LOG = process.env.E2E_SERVER_LOG ?? '';

function serverLogSince(since: number): string {
  if (SERVER_LOG === '' || !existsSync(SERVER_LOG)) return '';
  return readFileSync(SERVER_LOG).subarray(since).toString('utf8');
}

/** Structured error lines our own functions wrote (`lib/logger.ts`'s `logEvent`). */
function structuredErrors(text: string): string[] {
  return text.split('\n').filter((line) => /"severity":"(error|critical)"/.test(line));
}

/**
 * WHAT STRIPE'S PAGE WROTE TO THE BROWSER CONSOLE (#2304). The pay spec can
 * only count the errors Stripe's scripts throw: the browser hands a page
 * another origin's exception as the bare words "Script error.". Chrome's own
 * log has the message and the script's address. `e2e:real:run` starts Chrome
 * (it was Electron until #2304), and the launch hook below asks Chrome to
 * write that log to a file outside the repo.
 *
 * Only console lines that name a Stripe address are kept, with session ids and
 * key-shaped words cut out, so nothing the portal itself logged reaches the
 * job log or the artifact. A missing file is said, never an error: the log is
 * there to explain a red pay spec, not to decide one.
 */
const CHROME_LOG = join(tmpdir(), `e2e-real-portal-chrome-${process.pid}.log`);
const STRIPE_CONSOLE_FILE = 'cypress/.artifacts/real/stripe-page-console.log';
const STRIPE_CONSOLE_MAX_LINES = 60;
function stripeConsoleLines(chromeLog: string): string[] {
  return chromeLog
    .split('\n')
    .filter((line) => line.includes(':CONSOLE(') && /stripe\.(com|network)/.test(line))
    .map((line) =>
      line
        .replace(/\b(cs|pi|seti|pm|cus|acct)_(test_)?[A-Za-z0-9]{8,}/g, '$1_...')
        .replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, '$1_$2_...')
        .replace(/whsec_[A-Za-z0-9]+/g, 'whsec_...')
        .slice(0, 400),
    );
}
function reportStripeConsole(): void {
  if (!existsSync(CHROME_LOG)) {
    console.log('== e2e-real (portal): Stripe page console: Chrome wrote no log file');
    return;
  }
  const lines = stripeConsoleLines(readFileSync(CHROME_LOG, 'utf8'));
  rmSync(CHROME_LOG, { force: true });
  const shown = lines.slice(0, STRIPE_CONSOLE_MAX_LINES);
  console.log(`== e2e-real (portal): Stripe page console: ${lines.length} lines, ${shown.length} shown`);
  for (const line of shown) console.log(`   ${line}`);
  mkdirSync('cypress/.artifacts/real', { recursive: true });
  writeFileSync(STRIPE_CONSOLE_FILE, `${shown.join('\n')}\n`);
}
let seeded: Promise<void> | null = null;

export default defineConfig({
  expose: { E2E_VENDORS: vendorAvailability() },
  e2e: {
    baseUrl: `http://127.0.0.1:${PORT}`,
    specPattern: 'cypress/e2e-real/**/*.cy.ts',
    supportFile: 'cypress/support/e2e-real.ts',
    fixturesFolder: false,
    screenshotsFolder: 'cypress/.artifacts/real/screenshots',
    videosFolder: 'cypress/.artifacts/real/videos',
    downloadsFolder: 'cypress/.artifacts/real/downloads',
    video: false,
    screenshotOnRunFailure: true,
    // Same posture as the PR-time suite: a retry turns a flake into a green.
    retries: 0,
    experimentalRunAllSpecs: false,
    // STRIPE'S HOSTED CHECKOUT ONLY RENDERS WITH THIS ON (#1269). Cypress runs
    // the app inside a frame, and Checkout's own scripts notice that and never
    // paint: the first run against Stripe (run 41227390964, 2026-10-31) sat on
    // Checkout's grey loading skeleton for 60 s and found no `#email`. This
    // flag makes Cypress rewrite the frame-busting checks in third-party
    // scripts too, not only in ours. Measured on a Checkout URL in the
    // runner: off, the page body stays raw script and nothing renders (with
    // `chromeWebSecurity` on or off); on, Stripe's page renders its copy. It
    // also strips Subresource Integrity from rewritten scripts, which matters
    // only to this test run, never to the app.
    //
    // THE BROWSER IS CHROME (#2304), set in package.json's `e2e:real:run`. In
    // Electron 146, with this flag on, Stripe's `/g/pay/` page drew the
    // business and the amount and left its form frame 2 px tall for the whole
    // budget (run 43629608013). The flag is unchanged: the browser is the one
    // thing that moved.
    experimentalModifyObstructiveThirdPartyCode: true,
    // A real callable cold-starts inside the emulator on its first call, which
    // the PR-time stubs never had to wait for.
    defaultCommandTimeout: 15_000,
    setupNodeEvents(on) {
      on('after:run', (results) => {
        writeRunResults(results);
        // Reading the browser log can never change the run's result.
        try {
          reportStripeConsole();
        } catch (error) {
          console.log(`== e2e-real (portal): Stripe page console: could not be read (${String(error)})`);
        }
      });
      // Chrome only: Electron ignores the flags, and no other browser runs here.
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.name === 'chrome') {
          launchOptions.args.push('--enable-logging', `--log-file=${CHROME_LOG}`, '--v=0');
        }
        return launchOptions;
      });
      on('task', {
        /** Seeds the emulator once per run (`cypress/seed.ts`, `E2E_PROJECT_ID` from run.sh). */
        async seedOnce() {
          seeded ??= seed();
          await seeded;
          return null;
        },
        /**
         * Merges a spec-owned fixture into one document. `timestampFields`
         * names the ISO strings to store as Firestore Timestamps, since a task
         * argument crosses as JSON and loses `Date`.
         */
        async upsertDoc({
          path,
          id,
          doc,
          timestampFields,
        }: {
          path: string;
          id: string;
          doc: Record<string, unknown>;
          timestampFields?: string[];
        }) {
          const prepared = { ...doc };
          for (const field of timestampFields ?? []) {
            if (field in prepared) prepared[field] = new Date(String(prepared[field]));
          }
          await upsert(path, id, prepared);
          return null;
        },
        async deleteDoc({ path, id }: { path: string; id: string }) {
          await remove(path, id);
          return null;
        },
        /** Byte offset of the emulator log now, so a test reads only its own lines. */
        serverLogOffset() {
          if (SERVER_LOG === '' || !existsSync(SERVER_LOG)) return 0;
          return statSync(SERVER_LOG).size;
        },
        /** Our functions' structured error lines since [since]. */
        serverErrorsSince({ since }: { since: number }) {
          return structuredErrors(serverLogSince(since));
        },
      });
    },
  },
});
