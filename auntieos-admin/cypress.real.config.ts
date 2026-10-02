import { defineConfig } from 'cypress';
import { existsSync, readFileSync, statSync } from 'node:fs';
import seed, { upsert, remove } from './e2e/seed';

/**
 * Cypress config for the REAL-SERVICES run (#1089, operator ruling D3,
 * 2026-10-01). `npm run e2e:real` starts it through `scripts/e2e-real/run.sh`;
 * never start it any other way, because that script is what writes the
 * functions secrets file and refuses an unsafe one.
 *
 * WHAT IS DIFFERENT FROM `cypress.config.ts`. That config is the PR-time suite:
 * auth and Firestore emulators only, callables pinned at a dead port and
 * answered by `cy.intercept`. Here the functions emulator serves the real
 * `mytribe/functions` build, so a callable runs its real handler and its real
 * triggers, and a vendor call (Stripe test mode and the rest) really leaves
 * the machine. Specs live in `cypress/e2e-real/`, so neither suite collects the
 * other's files.
 *
 * TESTS STILL DRIVE AND ASSERT FROM THE UI (2026-09-01 ruling, restated for
 * this run in D3-c). The tasks below set up fixtures, and read the emulator log
 * for the support file's harness condition (our functions' error lines), the
 * server-side twin of the `console.error` signal. No spec asserts on the log.
 */

const PORT = 5174;

/** Written by `run.sh`. Absent when someone ran `cypress open` by hand: every vendor then reads as not configured. */
const REAL_DIR = 'cypress/.real';
const VENDORS_FILE = `${REAL_DIR}/vendors.json`;

/**
 * Which vendors have credentials in this run, as booleans only, never a value.
 * Specs read it synchronously through `Cypress.expose` and skip with a named
 * reason when their vendor is missing.
 */
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

/**
 * Structured error lines our own functions wrote (`lib/logger.ts`'s
 * `logEvent`, which prints one JSON object per line). The D3-e verdict rule
 * counts any of these during a test as OUR integration breaking.
 */
function structuredErrors(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /"severity":"(error|critical)"/.test(line));
}

let seeded: Promise<void> | null = null;

export default defineConfig({
  projectId: '2khvut',
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
    // A real callable cold-starts inside the emulator on its first call, which
    // the PR-time stubs never had to wait for.
    defaultCommandTimeout: 15_000,
    setupNodeEvents(on) {
      on('task', {
        /** Seeds the emulator once per run (`e2e/seed.ts`, `E2E_PROJECT_ID` from run.sh). */
        async seedOnce() {
          seeded ??= seed();
          await seeded;
          return null;
        },
        /** See `cypress.config.ts`'s `upsertDoc`; same contract, same Timestamp handling. */
        async upsertDoc({
          collection,
          id,
          doc,
          timestampFields,
        }: {
          collection: string;
          id: string;
          doc: Record<string, unknown>;
          timestampFields?: string[];
        }) {
          const prepared = { ...doc };
          for (const field of timestampFields ?? []) {
            if (field in prepared) prepared[field] = new Date(String(prepared[field]));
          }
          await upsert(collection, id, prepared);
          return null;
        },
        async deleteDoc({ collection, id }: { collection: string; id: string }) {
          await remove(collection, id);
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
        /**
         * Mints a Stripe TEST-MODE Checkout Session for an invoice, the way
         * `payInvoice` would for a household that opened the pay page and left
         * it open. Fixture setup for the admin-side Stripe path, which has no
         * admin control that mints one. Refuses anything but a test key.
         */
        async stripeTestCheckoutSession({ invoiceId, amountCents }: { invoiceId: string; amountCents: number }) {
          const key = process.env.STRIPE_TEST_SECRET_KEY ?? '';
          if (!/^(sk_test_|rk_test_)/.test(key)) {
            throw new Error('STRIPE_TEST_SECRET_KEY is not a test-mode secret key; refusing to call Stripe');
          }
          const body = new URLSearchParams({
            mode: 'payment',
            success_url: 'http://127.0.0.1:5174/e2e-stripe-success',
            cancel_url: 'http://127.0.0.1:5174/e2e-stripe-cancel',
            'line_items[0][quantity]': '1',
            'line_items[0][price_data][currency]': 'usd',
            'line_items[0][price_data][unit_amount]': String(amountCents),
            'line_items[0][price_data][product_data][name]': `e2e invoice ${invoiceId}`,
            'metadata[invoiceId]': invoiceId,
            'metadata[source]': 'auntieos-admin e2e-real',
          });
          const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          });
          const json = (await res.json()) as { id?: string; error?: { message?: string } };
          if (!res.ok || typeof json.id !== 'string') {
            throw new Error(`Stripe refused the fixture session: ${res.status} ${json.error?.message ?? ''}`);
          }
          return json.id;
        },
      });
    },
  },
});
