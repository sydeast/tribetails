import './commands';
import { unstubbedCallables } from './callables';

/**
 * Loaded before every spec file in the portal suite.
 *
 * Two jobs: get the emulator seeded (once per run, see `cypress.config.ts`),
 * and make a screen that logs an error fail the test that visited it.
 */

/**
 * Every `console.error` the app under test emitted since the last test started.
 *
 * WHY THIS EXISTS. The complaint this suite was built for is screens that
 * "pass as green" while being visibly broken. A React screen that throws inside
 * a `useEffect`, an unhandled rejection in a data hook, a router guard that
 * logs and bails. None of those reject a Cypress command, none blank the page,
 * and an assertion on markup that still rendered will happily pass. React
 * reports every one of them through `console.error`, so the console is treated
 * as a test signal here rather than as noise.
 */
let consoleErrors: string[] = [];

/**
 * Errors this harness EXPECTS, and why each is not the app being broken.
 *
 * Short on purpose: anything added here stops being caught, so an entry
 * describing an app behaviour rather than a harness one is a bug being
 * allowlisted.
 */
const EXPECTED_CONSOLE_ERRORS = [
  // A callable with no stub. `cypress/support/callables.ts` answers it with the
  // protocol's UNIMPLEMENTED envelope on purpose, and the screen renders its
  // real error state, which is the true rendering of that condition, not a
  // defect. Which callables those were is reported by `unstubbedCallables()`
  // rather than being lost here.
  /No e2e stub for callable/,
  /functions\/(internal|unimplemented|not-found)/,
  // The pinned, unserved functions port itself, for anything that reaches it
  // before the intercepts are installed.
  /127\.0\.0\.1:5499/,
  /net::ERR_CONNECTION_REFUSED/,
  /Failed to (load resource|fetch)/i,
  // A Firestore listen stream torn down by a page navigation. Messages holds an
  // `onSnapshot` over a WebChannel and a `cy.visit` while one is open aborts it
  // mid-request; the SDK notices on the NEXT page and logs its offline-mode
  // warning there, so the error lands on a screen that had nothing to do with
  // it. Allowlisting costs nothing because a genuinely unreachable emulator
  // would fail this suite on content: sign-in itself goes through the auth
  // emulator and every spec depends on it.
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
 * sign in without ever reading what the console recorded.
 *
 * Also reports which callables went unstubbed this test, per
 * `callables.ts`'s own rule: a gap here is expected (the stub set is
 * deliberately small), so it is logged rather than failing the test.
 */
afterEach(() => {
  expect(takeConsoleErrors(), 'unexpected console.error lines').to.deep.equal([]);
  const gaps = unstubbedCallables();
  if (gaps.length > 0) cy.log(`unstubbed callables this test: ${gaps.join(', ')}`);
});

before(() => {
  cy.task('seedOnce');
});
