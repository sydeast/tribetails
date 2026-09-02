import { defineConfig } from 'cypress';
import seed from './e2e/seed';

/**
 * Cypress config for the AuntieOS admin.
 *
 * WHY A SECOND E2E RUNNER, given `e2e/` already holds a Playwright suite. The
 * operator's standing complaint is that the Playwright run reports green while
 * links, workflows and whole screens are broken in the app they actually use.
 * That is a coverage claim, not a runner claim: the Playwright specs are narrow
 * and deep (typography, cascade, one deeplink, one gate), and nothing in the
 * repo has ever walked the app the way a person does. This suite is aimed at
 * exactly that gap: every route reachable from the rail, every internal link
 * on every screen it lands on. The two suites are not redundant and neither
 * replaces the other. See `docs/runbooks/e2e.md`.
 *
 * IT REUSES THE PLAYWRIGHT HARNESS'S EMULATORS AND SEED RATHER THAN FORKING
 * THEM. `e2e.firebase.json` already declares the non-default ports (9399 auth,
 * 8385 firestore) and `e2e/seed.ts` already writes the fixture database over
 * plain REST. A second copy of either would drift, and a drifted seed is how a
 * spec comes to assert against rows nobody maintains. `npm run e2e:cy` wraps
 * this in the same `firebase emulators:exec` the Playwright script uses.
 */

const PORT = 5174; // matches vite.config.ts's dev port and playwright.config.ts

/**
 * Seeding is a TASK, not a `before:run` hook, and it is idempotent per node
 * process.
 *
 * `before:run` does not fire under `cypress open`, so a hook-seeded harness
 * works in CI and leaves anyone debugging interactively staring at an empty
 * database. A task called from a global `before()` fires in both modes. The
 * module-level latch below then gives it the semantics Playwright's
 * `globalSetup` has: seeded once for the whole run, not once per spec file,
 * so the exact-count assertions the fixtures were written for stay meaningful.
 *
 * The plugin process outlives every spec in a run, which is what makes a
 * module-level flag the right place to hold that state.
 */
let seeded: Promise<void> | null = null;

export default defineConfig({
  projectId: '2khvut',
  e2e: {
    baseUrl: `http://127.0.0.1:${PORT}`,
    specPattern: 'cypress/e2e/**/*.cy.ts',
    supportFile: 'cypress/support/e2e.ts',
    fixturesFolder: false,
    screenshotsFolder: 'cypress/.artifacts/screenshots',
    videosFolder: 'cypress/.artifacts/videos',
    downloadsFolder: 'cypress/.artifacts/downloads',
    // Off. Video costs ~20s of encoding per run and this suite's failures are
    // route-level, which a screenshot plus the command log already localises.
    video: false,
    screenshotOnRunFailure: true,
    // Matches playwright.config.ts. A retry turns a flake into a green and this
    // suite exists because greens were not believed.
    retries: 0,
    // The emulator is one shared database with one seed, so the reasoning in
    // playwright.config.ts applies unchanged: parallel specs would race each
    // other's reads and writes.
    experimentalRunAllSpecs: false,
    setupNodeEvents(on) {
      on('task', {
        /** Seeds the emulator once per run. Returns null: Cypress tasks may not resolve undefined. */
        async seedOnce() {
          seeded ??= seed();
          await seeded;
          return null;
        },
      });
    },
  },
});
