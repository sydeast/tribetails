import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { E2E_EMULATOR_HOST, E2E_FUNCTIONS_PORT, functions } from './firebase';
import { noteSessionAlive, reactToCallableError } from './revokedSession';

/**
 * Typed callables client, lifted from MyTribe/web/src/lib/fns.ts (the plan's
 * A1 ruling: share this seam, do not re-derive it). Every AuntieOS admin
 * callable this app will reach is a Firebase onCall in us-central1 (defined and
 * tested in MyTribe/functions); this is the single choke point the api/ layer
 * goes through, so the timeout + error mapping live in exactly one place.
 *
 * O-20: a callable that never responds (cold start, a dropped POST after a
 * successful CORS preflight, a wedged revision) must not read as an infinite
 * spinner. The SDK default is 70s, long enough that the operator gives up
 * before any error surfaces. 20s is generous for a Firestore-backed callable
 * and short enough that a hang becomes a visible, retryable error.
 */
const CALLABLE_TIMEOUT_MS = 20_000;

export class CallableTimeoutError extends Error {
  constructor(name: string) {
    super(`${name} took too long to respond. Check your connection and try again.`);
    this.name = 'CallableTimeoutError';
  }
}

/**
 * Thrown in e2e emulator mode, and only there, when a callable was invoked that
 * the spec did not stub.
 *
 * `lib/firebase.ts` pins the Functions SDK at `127.0.0.1:5399` during an e2e
 * run, and nothing listens there. That is what makes reaching production
 * impossible; this class is what makes the resulting failure legible. Without it
 * the operator sees `FirebaseError: internal`, which is exactly what a genuine
 * production outage looks like, and the harness would be lying about which side
 * of the wire broke.
 *
 * If you hit this, the spec is driving a screen whose first paint calls a
 * callable. Stub it before navigating:
 *
 *   await page.route('**\/127.0.0.1:5399/**', (route) =>
 *     route.fulfill({ json: { result: { supplies: [] } } }));
 *
 * `page.route` works precisely BECAUSE the SDK now dials localhost: Playwright
 * intercepts the request the SDK actually makes. A stub is a decision recorded
 * in the spec. Silently reaching a real backend was not.
 */
export class CallableNotStubbedError extends Error {
  constructor(name: string) {
    super(
      `${name} was called in e2e emulator mode, but no functions emulator or route stub is serving ` +
        `127.0.0.1:${E2E_FUNCTIONS_PORT}. e2e runs never reach production callables; stub this one ` +
        `in the spec with page.route, or drive a screen that does not need it. See docs/runbooks/e2e.md.`,
    );
    this.name = 'CallableNotStubbedError';
  }
}

/**
 * #644 / #630: what a caller has to prove before `call` may retry it.
 *
 * `functions/internal` is reported for ANY transport failure (see the comment
 * in the catch below), which means the client cannot tell "the request never
 * arrived" from "the write committed and the reply was lost". Retrying repairs
 * the first and duplicates the second. So the retry is OPT-IN, per call site,
 * and the opt-in is a claim about the SERVER: this callable either changes
 * nothing, or dedupes the second attempt itself.
 *
 * `createMultiDateBookingRequest` and `requestBooking` earn it by carrying an
 * `idempotencyKey` (see `functions/src/lib/bookingIdempotency.ts`). The other
 * ~174 callables do not opt in, and must not be swept in as a batch: each one
 * is its own claim, and a wrong one double-writes silently.
 */
export interface CallOptions {
  /**
   * Retry ONCE on `functions/internal`, and only that code. A deadline is left
   * alone deliberately: the 20s timeout exists so a hang becomes a visible,
   * operator-driven retry, and quietly doubling the wait would undo it.
   */
  idempotent?: boolean;
}

export async function call<TReq, TRes>(
  name: string,
  payload: TReq,
  options: CallOptions = {},
): Promise<TRes> {
  const fn = httpsCallable<TReq, TRes>(functions, name, { timeout: CALLABLE_TIMEOUT_MS });
  let retriedInternal = false;
  for (;;) {
    try {
      const result = await fn(payload);
      // #573: a call that succeeded proves the current session works, which
      // re-arms the teardown guard. See noteSessionAlive's header for why a guard
      // that never re-arms goes deaf to the SECOND revocation.
      noteSessionAlive();
      return result.data;
    } catch (err) {
      if (err instanceof FirebaseError && err.code === 'functions/deadline-exceeded') {
        // Deliberately BEFORE the revocation check and returning early: a
        // deadline is a network fact, never a statement about the session, and
        // the relabelled error carries none of the server's tags anyway.
        throw new CallableTimeoutError(name);
      }
      // `functions/internal` is what the SDK reports for ANY transport failure:
      // `postJSON` swallows the fetch rejection and returns `status: 0`, which
      // `_errorForResponse` maps to `internal` (@firebase/functions
      // index.esm.js:546-577). In production that is ambiguous. In emulator mode
      // it is not: the URL is localhost, so a transport failure can only be the
      // refused connection to the unserved functions port.
      if (
        E2E_EMULATOR_HOST !== '' &&
        err instanceof FirebaseError &&
        err.code === 'functions/internal'
      ) {
        throw new CallableNotStubbedError(name);
      }
      // #644: the retry, and it sits HERE on purpose -- after the emulator branch
      // above, which must keep reporting an unstubbed callable rather than
      // dialling a dead port twice, and before `reactToCallableError` below,
      // because a session that is merely being retried has not been revoked.
      if (options.idempotent && !retriedInternal && err instanceof FirebaseError && err.code === 'functions/internal') {
        retriedInternal = true;
        continue;
      }
      // #573: the backend refuses any call made with a revoked session's ID token
      // (`functions/src/lib/sessionRevocation.ts`). This is the one place every
      // admin callable passes through, so it is the one place that has to notice
      // — otherwise the screen retries into a refusal that can never succeed, and
      // the operator just sees the app stop working. Awaited so the sign-out is
      // under way before the caller's own error handling paints anything, and it
      // rethrows regardless: this reacts to the error, it does not consume it.
      await reactToCallableError(err);
      throw err;
    }
  }
}
