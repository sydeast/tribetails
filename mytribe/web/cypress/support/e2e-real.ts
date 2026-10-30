import { KINFOLK } from '../fixtures/accounts';

/**
 * Loaded before every spec in the portal's REAL-SERVICES run
 * (`cypress.real.config.ts`, #1194). The PR-time suite's `e2e.ts` stays the
 * support file there. The admin's `support/e2e-real.ts` (#1089) is the model;
 * this one differs from the PR-time file in four ways, each because a functions
 * emulator now answers.
 *
 * 1. NO CALLABLE STUBS. `commands.ts` is not imported: its `signIn` installs
 *    the access-chain stubs, and here the real `getMyAccess`, `getMyHome` and
 *    `setActiveTribe` answer instead. `signInReal` below is the same form fill
 *    without them.
 * 2. A SHORTER console allowlist. `e2e.ts` excuses refused connections to the
 *    dead callable port and `functions/internal`, because there they are the
 *    designed outcome of the pin. Here a refused or internal callable is a real
 *    function failing, so it fails the test like any other console error.
 * 3. GOOGLE CALENDAR DISCONNECT IS BLOCKED. It revokes the grant at Google, and
 *    the test calendar shares the account and OAuth client with production
 *    (D3-d). The preflight refuses a spec that names it; this is the runtime
 *    half, for a request that reaches it some other way.
 * 4. OUR FUNCTIONS' ERRORS ARE A SIGNAL TOO. A structured `severity: error`
 *    line our functions log while a test runs fails that test. A harness
 *    condition, the server-side twin of the `console.error` signal, not a
 *    spec's assertion; specs still assert from the UI only.
 */

let consoleErrors: string[] = [];

/** Harness conditions only, as in `e2e.ts`. See the reasons written there. */
const EXPECTED_CONSOLE_ERRORS = [
  /Could not reach Cloud Firestore backend/,
  /WebChannelConnection RPC .* transport errored/,
] as const;

Cypress.on('window:before:load', (win) => {
  const original = win.console.error.bind(win.console);
  win.console.error = (...args: unknown[]) => {
    original(...args);
    consoleErrors.push(args.map((a) => String(a)).join(' '));
  };
});

/** Byte offset of the emulator log when the current test started. */
let serverLogStart = 0;

beforeEach(() => {
  consoleErrors = [];
  cy.task<number>('serverLogOffset').then((offset) => {
    serverLogStart = offset;
  });
  cy.intercept('POST', '**/us-central1/disconnectGoogleCalendar', (req) => {
    req.destroy();
    throw new Error(
      'A spec reached disconnectGoogleCalendar. It revokes the production Google grant (D3-d); no spec may call it.',
    );
  });
});

afterEach(() => {
  const unexpected = consoleErrors.filter(
    (line) => !EXPECTED_CONSOLE_ERRORS.some((pattern) => pattern.test(line)),
  );
  consoleErrors = [];
  expect(unexpected, 'unexpected console.error lines').to.deep.equal([]);
  cy.task<string[]>('serverErrorsSince', { since: serverLogStart }).then((lines) => {
    expect(lines, 'error lines our functions logged during this test (harness condition)').to.deep.equal([]);
  });
});

before(() => {
  cy.task('seedOnce');
});

/**
 * Signs the seeded kinfolk in through the real form, against the real access
 * chain, unless a session is already live. Same reasoning as `commands.ts`'s
 * `signIn` (the Firebase session lives in IndexedDB, which `cy.session()` does
 * not cache and Cypress does not clear between tests; wait for a rendered
 * screen, not a URL), minus the stubs.
 *
 * `.errshell` before sign-in, or after it, is LaunchError: with the real
 * callables answering, that is the access chain failing on the seeded data,
 * and it fails here rather than as a missing element three steps later.
 */
Cypress.Commands.add('signInReal', () => {
  cy.visit('/home');
  cy.get('.nav, .authcard, .errshell', { timeout: 30_000 }).should('exist');

  cy.get('body').then(($body) => {
    expect($body.find('.errshell').length, 'portal rendered LaunchError before sign-in').to.equal(0);
    if ($body.find('.nav').length > 0) return; // already signed in

    cy.get('#email').type(KINFOLK.email);
    cy.get('#password').type(KINFOLK.password, { log: false });
    cy.get('.authcard button[type="submit"]').click();

    // The route change is the real access chain's verdict.
    cy.location('pathname', { timeout: 30_000 }).should('eq', '/home');
    cy.get('.nav').should('exist');
    cy.get('.errshell').should('not.exist');
  });
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      signInReal(): Chainable<void>;
    }
  }
}

/**
 * True when every credential [vendor] needs was provided to this run. Keys
 * match `VENDOR_SECRETS` in the admin preflight, plus the portal's
 * `stripeWebhook` (`scripts/e2e-real/preflight.mjs`).
 */
export function vendorConfigured(
  vendor: 'stripe' | 'stripeWebhook' | 'twilio' | 'email' | 'cloudinary' | 'googleCalendar',
): boolean {
  const vendors = (Cypress.expose('E2E_VENDORS') ?? {}) as Record<string, boolean>;
  return vendors[vendor] === true;
}
