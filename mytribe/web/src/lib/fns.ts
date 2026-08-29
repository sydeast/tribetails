import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { noteSessionAlive, reactToCallableError } from './revokedSession';

/**
 * O-20: a callable that never gets a response (cold-start pathology, a
 * dropped POST after a successful CORS preflight, a wedged revision — the
 * exact cause varies and won't always be knowable) must not read as an
 * infinite spinner. The Functions SDK's own default timeout is 70s, long
 * enough that a kinfolk gives up and assumes the app is broken before any
 * error ever surfaces. 20s is generous for a Firestore-backed callable and
 * short enough that a hang becomes a visible, retryable error.
 */
const CALLABLE_TIMEOUT_MS = 20_000;

export class CallableTimeoutError extends Error {
  constructor(name: string) {
    super(`${name} took too long to respond. Check your connection and try again.`);
    this.name = 'CallableTimeoutError';
  }
}

/**
 * Typed callables client. Every MyTribe backend function is a Firebase
 * onCall in us-central1 (see functions/src); this is the single choke
 * point the api/ layer goes through.
 */
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
      // #557: a call that succeeded proves the current session works, which
      // re-arms the teardown guard. See noteSessionAlive's header for why a guard
      // that never re-arms goes deaf to the SECOND revocation.
      noteSessionAlive();
      return result.data;
    } catch (err) {
      if (err instanceof FirebaseError && err.code === 'functions/deadline-exceeded') {
        throw new CallableTimeoutError(name);
      }
      // #644: the retry, placed before `reactToCallableError` below, because a
      // session that is merely being retried has not been revoked.
      if (options.idempotent && !retriedInternal && err instanceof FirebaseError && err.code === 'functions/internal') {
        retriedInternal = true;
        continue;
      }
      // #557: the backend now refuses a call made with a revoked session's ID
      // token. This is the one place every callable passes through, so it is the
      // one place that has to notice — otherwise the screen retries into a
      // refusal that cannot ever succeed. Awaited so the sign-out is under way
      // before the caller's own error handling paints anything, and it rethrows
      // regardless: this reacts to the error, it does not consume it.
      await reactToCallableError(err);
      throw err;
    }
  }
}
