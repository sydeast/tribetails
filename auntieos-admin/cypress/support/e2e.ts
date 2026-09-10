import './commands';

/**
 * Loaded before every spec file in this suite.
 *
 * Two jobs: get the emulator seeded (once per run, see `cypress.config.ts`),
 * and make a screen that logs an error fail the test that visited it.
 */

/**
 * Every `console.error` the app under test emitted since the last test started.
 *
 * WHY THIS EXISTS. The complaint this suite was built for is screens that
 * "pass as green" while being visibly broken. A React screen that throws inside
 * a `useEffect`, an unhandled promise rejection in a data hook, a router guard
 * that logs and bails. None of those reject a Cypress command, none of them
 * blank the page, and an assertion on markup that still rendered will happily
 * pass. React itself reports every one of them through `console.error`. So the
 * console is treated as a test signal here rather than as noise.
 */
let consoleErrors: string[] = [];

/**
 * Errors this harness EXPECTS, and why each is not the app being broken.
 *
 * This list is short on purpose and every entry is a property of the harness,
 * not of a screen. Anything added here stops being caught, so an entry that
 * describes an app behaviour rather than a harness one is a bug being
 * allowlisted.
 */
const EXPECTED_CONSOLE_ERRORS = [
  // Every callable is pinned at 127.0.0.1:5399 with nothing listening (see
  // src/lib/firebase.ts). A refused POST is the DESIGNED outcome of that pin
  // (it is what stops an e2e run reaching production), and the Functions SDK
  // reports it through console.error. A screen whose widgets show their error
  // state because of it is behaving correctly.
  /127\.0\.0\.1:5399/,
  /functions\/internal/,
  /net::ERR_CONNECTION_REFUSED/,
  // Fetch failures the browser reports for that same pinned port before the SDK
  // gets to label them.
  /Failed to (load resource|fetch)/i,
  // A Firestore listen stream torn down by a page navigation. Directory and the
  // other live screens hold `onSnapshot` subscriptions over a WebChannel, and a
  // `cy.visit` while one is open aborts it mid-request; the SDK notices on the
  // NEXT page and logs its offline-mode warning there, so the error lands on a
  // screen that had nothing to do with it. Reproduced on 2026-08-16 as an
  // intermittent failure of whichever screen happened to be visited next.
  //
  // ALLOWLISTING IT COSTS NOTHING HERE, which is the only reason it is allowed.
  // If the emulator were genuinely unreachable, this suite would fail on
  // content rather than on a log line: `smoke.cy.ts` asserts the signed-in shell
  // renders at least one seeded household row, and every one of those rows
  // comes out of the same Firestore connection this message is about.
  /Could not reach Cloud Firestore backend/,
  /WebChannelConnection RPC .* transport errored/,
] as const;

Cypress.on('window:before:load', (win) => {
  const original = win.console.error.bind(win.console);
  win.console.error = (...args: unknown[]) => {
    // Still printed. A recorder that swallows the message makes the failure it
    // causes unreadable, which is the opposite of the point.
    original(...args);
    consoleErrors.push(args.map((a) => String(a)).join(' '));
  };
});

beforeEach(() => {
  consoleErrors = [];
});

/**
 * Reads and clears the errors recorded since the current test started.
 *
 * Clearing is what lets a crawl assert per page rather than accumulating one
 * screen's failure onto every screen visited after it.
 */
function takeConsoleErrors(): string[] {
  const unexpected = consoleErrors.filter(
    (line) => !EXPECTED_CONSOLE_ERRORS.some((pattern) => pattern.test(line)),
  );
  consoleErrors = [];
  return unexpected;
}

/**
 * The other half of this file's stated job: a screen that logs an error fails
 * the test that visited it. Global rather than per-spec, so every spec file
 * gets this for free, including smoke.cy.ts, which used to boot the app and
 * sign in without ever reading what the console recorded. Three feature specs
 * each carried this exact line in their own afterEach; one copy here is the
 * one the harness owns, not three that can drift.
 */
afterEach(() => {
  expect(takeConsoleErrors(), 'unexpected console.error lines').to.deep.equal([]);
});

before(() => {
  cy.task('seedOnce');
});
