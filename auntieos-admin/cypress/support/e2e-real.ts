import './commands';

/**
 * Loaded before every spec in the REAL-SERVICES run (`cypress.real.config.ts`,
 * #1089). The PR-time suite's `e2e.ts` stays the support file there; this one
 * differs in three ways, each because a functions emulator now answers.
 *
 * 1. A SHORTER console allowlist. `e2e.ts` excuses refused connections to the
 *    dead callable port and `functions/internal`, because there they are the
 *    designed outcome of the pin. Here a refused or internal callable is a real
 *    function failing, so it fails the test like any other console error.
 * 2. GOOGLE CALENDAR DISCONNECT IS BLOCKED. `disconnectGoogleCalendar` revokes
 *    the grant at Google, and the "AuntieOS test" calendar shares the account
 *    and OAuth client with production (D3-d), so one call would cut the
 *    production connection. The preflight refuses a spec that names it; this is
 *    the runtime half, for a click that reaches it some other way.
 * 3. OUR FUNCTIONS' ERRORS FAIL THE TEST. Every structured `severity: error`
 *    line our functions log during a test fails it after the console check.
 *    A trigger that runs after the screen has its answer (the Stripe checkout
 *    sweep is one) cannot show a failure on screen at all, and the D3-e rule
 *    is that our integration breaking stops the release.
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
    expect(lines, 'error lines our functions logged during this test').to.deep.equal([]);
  });
});

before(() => {
  cy.task('seedOnce');
});

/** The emulator log offset this test started at, for `serverLogWaitFor`. */
export function serverLogStartOffset(): number {
  return serverLogStart;
}

/**
 * True when every credential [vendor] needs was provided to this run.
 * Vendor keys match `VENDOR_SECRETS` in `scripts/e2e-real/preflight.mjs`.
 */
export function vendorConfigured(vendor: 'stripe' | 'twilio' | 'email' | 'cloudinary' | 'googleCalendar'): boolean {
  const vendors = (Cypress.expose('E2E_VENDORS') ?? {}) as Record<string, boolean>;
  return vendors[vendor] === true;
}
