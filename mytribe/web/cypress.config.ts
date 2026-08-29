import { defineConfig } from 'cypress';
import seed from './cypress/seed';

/**
 * Cypress config for the MyTribe portal.
 *
 * WHY THIS EXISTS. The portal had no browser-level test of any kind: 3000-odd
 * vitest cases, all of them in jsdom, where the router never runs, no chunk is
 * ever fetched and no screen is ever mounted end to end. Every broken link and
 * dead workflow an operator has reported was invisible to all of them. This is
 * the first harness that opens the app.
 *
 * ITS EMULATORS ARE THE PORTAL'S OWN, on ports nothing else in the repo uses
 * (`mytribe/e2e.firebase.json`), so it can run beside the admin's Playwright and
 * Cypress suites without either seeing the other's database. `npm run e2e:cy`
 * wraps this in `firebase emulators:exec`.
 *
 * CALLABLES ARE NOT SERVED. They are pinned to a dead port by
 * `src/lib/firebase.ts` and answered by `cypress/support/callables.ts`; the
 * reasoning, and the measurements behind not running the functions emulator,
 * are in that file.
 */

const PORT = 5173; // matches vite's default for this package; 5174 is the admin

/**
 * Seeding is a TASK, not a `before:run` hook, and it is idempotent per node
 * process.
 *
 * `before:run` does not fire under `cypress open`, so a hook-seeded harness
 * works in CI and leaves anyone debugging interactively staring at an empty
 * database. A task called from a global `before()` fires in both modes, and the
 * latch below gives it the semantics a Playwright `globalSetup` has: seeded once
 * for the whole run rather than once per spec file. The plugin process outlives
 * every spec in a run, which is what makes a module-level flag the right place
 * to hold that.
 */
let seeded: Promise<void> | null = null;

export default defineConfig({
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
    // A retry turns a flake into a green, and this suite exists because greens
    // were not believed.
    retries: 0,
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
