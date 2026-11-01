import { defineConfig } from 'cypress';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
const VENDORS_FILE = 'cypress/.real/vendors.json';

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
    experimentalModifyObstructiveThirdPartyCode: true,
    // A real callable cold-starts inside the emulator on its first call, which
    // the PR-time stubs never had to wait for.
    defaultCommandTimeout: 15_000,
    setupNodeEvents(on) {
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
