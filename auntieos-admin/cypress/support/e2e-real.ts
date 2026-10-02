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
 * 3. OUR FUNCTIONS' ERRORS ARE A SIGNAL TOO. Both suites already treat
 *    `console.error` as a test signal (docs/runbooks/e2e.md): a screen that
 *    logs an error fails the test that visited it, whatever its assertions
 *    said. This is the same HARNESS CONDITION on the server side: a structured
 *    `severity: error` line our functions log while a test runs fails that
 *    test. It is not a spec's assertion and no spec relies on it to make its
 *    claim; specs still assert from the UI only (2026-09-01 ruling). It exists
 *    because a callable or trigger can fail behind a screen that still renders.
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
 * True when every credential [vendor] needs was provided to this run.
 * Vendor keys match `VENDOR_SECRETS` in `scripts/e2e-real/preflight.mjs`.
 */
export function vendorConfigured(vendor: 'stripe' | 'twilio' | 'email' | 'cloudinary' | 'googleCalendar'): boolean {
  const vendors = (Cypress.expose('E2E_VENDORS') ?? {}) as Record<string, boolean>;
  return vendors[vendor] === true;
}
