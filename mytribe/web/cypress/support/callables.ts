/**
 * Answers for the callables the portal fires, served by Cypress instead of by a
 * backend.
 *
 * WHY STUBS AND NOT THE FUNCTIONS EMULATOR. Serving `mytribe/functions` loads
 * all 220 definitions, 18 of which are auth or Firestore triggers, and the
 * emulator wires them to the same database `seed.ts` writes. The seed then
 * stops being the state the specs assert on. That trade was measured on
 * 2026-08-01 and is written up in `auntieos-admin/docs/runbooks/e2e.md`, "Why
 * the functions emulator is not started"; the numbers apply here unchanged
 * because it is the same functions codebase.
 *
 * WHY THE STUB SET IS SMALL. Every fixture is a hand-written claim about what a
 * server returns, and a wrong one is worse than no test: it makes a screen look
 * healthy on data the backend would never send. So this file stubs the ACCESS
 * CHAIN, the two callables the router's guard cannot get past, and nothing
 * else. Screens whose own data callable is unstubbed render their error state,
 * which is a true rendering of a real condition, and the specs judge them on
 * routing and chrome rather than on content. `unstubbedCallables()` reports
 * exactly which ones those were, so the gap is visible in every run instead of
 * being folded into a green.
 *
 * EVERY FIXTURE IS TYPED against `src/api/types.ts`, the same interfaces the app
 * consumes, so a server-side shape change that reaches those types fails
 * `npm run e2e:cy:tsc` rather than silently drifting from the backend.
 */

/**
 * Every callable, wherever it is dialled.
 *
 * MATCHED BY PATH RATHER THAN BY FULL URL, and not for convenience. The obvious
 * version imports `E2E_FUNCTIONS_PORT` from `src/lib/firebase.ts` to build an
 * exact origin, which cannot work: Cypress bundles specs with webpack, that
 * module reads `import.meta.env`, and the whole support file dies on
 * "Cannot read properties of undefined (reading 'VITE_E2E_EMULATOR')" before a
 * single test runs. Importing it would also initialize a second Firebase app
 * inside the spec bundle.
 *
 * A path pattern is also STRICTLY SAFER than pinning the port here. If the pin
 * in `firebase.ts` is ever lost, the SDK starts dialling
 * `https://us-central1-auntieos-ttpc.cloudfunctions.net/...`. This pattern
 * still matches it, and the origin check in the handler turns that into a loud
 * failure instead of a real POST at a live backend. A hardcoded localhost
 * origin here would simply stop matching and let the request through.
 */
const CALLABLE_PATH = '**/auntieos-ttpc/us-central1/*';

/**
 * The only origin a callable may be dialled at in a run: the reserved, unserved
 * port `src/lib/firebase.ts` pins the SDK to.
 */
const ALLOWED_CALLABLE_ORIGIN = 'http://127.0.0.1:5499/';

/**
 * A synthesized reply is still subject to CORS: the page is on 5173 and the
 * callable address is a different origin, so without these the browser discards
 * the response and the SDK reports a network error indistinguishable from the
 * dead port it is meant to be replacing. `*` is safe because the callable
 * protocol sends its token in an `Authorization` header rather than a cookie,
 * so the request is never in credentials mode.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-firebase-appcheck',
} as const;

/** Callable names requested during the current test that had no stub. */
let unstubbed: string[] = [];

/**
 * A stub is either a fixed result or a function of the request payload. The
 * value is what the app receives. The `{ data: ... }` envelope the callable
 * wire protocol requires is added below, not by each fixture.
 */
export type CallableStub = unknown | ((payload: unknown) => unknown);

export function stubCallables(stubs: Record<string, CallableStub>): void {
  unstubbed = [];

  // The preflight. The callable POST carries `content-type: application/json`
  // and an `Authorization` header, neither of which is CORS-simple, so the
  // browser sends OPTIONS first and never issues the POST if that goes
  // unanswered.
  cy.intercept('OPTIONS', CALLABLE_PATH, { statusCode: 204, headers: { ...CORS } });

  cy.intercept('POST', CALLABLE_PATH, (req) => {
    const name = req.url.split('/').pop() ?? '';

    // The pin in `src/lib/firebase.ts` is what keeps an e2e run off production,
    // and a comment cannot enforce it. If it is ever removed, bypassed, or some
    // new module builds an absolute callable URL by hand, the request arrives
    // here at a non-loopback origin and this is what refuses it, before the
    // POST leaves the machine, rather than after somebody notices the traffic.
    if (!req.url.startsWith(ALLOWED_CALLABLE_ORIGIN)) {
      throw new Error(
        `e2e callable escaped the emulator pin: ${req.method} ${req.url}. ` +
          'Check E2E_FUNCTIONS_PORT and the connectFunctionsEmulator call in src/lib/firebase.ts.',
      );
    }

    const stub = stubs[name];

    if (stub === undefined) {
      unstubbed.push(name);
      // 501 with the callable protocol's own error envelope, so the app raises
      // a normal `FirebaseError` and renders whatever it renders when a backend
      // call fails. Returning an empty success instead would hand the screen
      // undefined data and produce a crash that belongs to the harness rather
      // than to the app.
      req.reply({
        statusCode: 501,
        headers: { ...CORS },
        body: {
          error: {
            status: 'UNIMPLEMENTED',
            message: `No e2e stub for callable "${name}" (cypress/support/callables.ts)`,
          },
        },
      });
      return;
    }

    const payload = (req.body as { data?: unknown } | undefined)?.data;
    const result = typeof stub === 'function' ? (stub as (p: unknown) => unknown)(payload) : stub;
    req.reply({ statusCode: 200, headers: { ...CORS }, body: { data: result } });
  });
}

/**
 * The callables a screen asked for and did not get, deduped, since the last
 * `stubCallables` call.
 *
 * Reported rather than thrown: in a harness that deliberately stubs only the
 * access chain, an unstubbed callable is the expected state for most screens.
 * What must never happen is it being invisible: a run that quietly answered
 * nothing and passed is the failure this whole suite was added to end.
 */
export function unstubbedCallables(): string[] {
  return [...new Set(unstubbed)].sort();
}
