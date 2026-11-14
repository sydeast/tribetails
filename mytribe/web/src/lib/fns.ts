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
export const CALLABLE_TIMEOUT_MS = 20_000;

/**
 * #1567: the budget for a callable that does slow work while the household
 * waits: an email sent inline, a Stripe call, a PDF, the writing helper. 70s
 * is the Functions SDK's own default, which the Android apps run with.
 *
 * A cold start on this project has been measured at 20.8s before a handler
 * ran at all (`reviewAndSendDraftInvoice`, 2026-11-05). At 20s a call like
 * that is cut off and reported while the server goes on to finish it, so a
 * card is saved or an invite sent while the screen says otherwise. 70s is
 * longer than the server's own 60s function timeout, so when it runs out the
 * server has finished or stopped.
 *
 * Twin of `auntieos-admin/src/lib/fns.ts`'s list; `fns.test.ts` checks every
 * name is a real server export.
 */
export const LONG_CALLABLE_TIMEOUT_MS = 70_000;

export const LONG_RUNNING_CALLABLES: ReadonlySet<string> = new Set([
  // Email sent inline.
  'requestPasswordReset',
  'acceptInvite',
  'addSecondaryContact',
  // The AI writing helper.
  'generate',
  // A PDF rendered and uploaded inline.
  'getMyInvoicePdf',
  // Stripe, inline.
  'payInvoice',
  'createBillingSetupSession',
  'syncMyPaymentMethod',
  'removeMyPaymentMethod',
]);

/** The client budget for [name], in milliseconds. */
export function callableTimeoutMs(name: string): number {
  return LONG_RUNNING_CALLABLES.has(name) ? LONG_CALLABLE_TIMEOUT_MS : CALLABLE_TIMEOUT_MS;
}

/**
 * The call got no answer inside its budget. #1567: not a failure, so the
 * sentence never says it is; the server may have finished after the client
 * stopped listening.
 */
export class CallableTimeoutError extends Error {
  readonly callableName: string;
  readonly seconds: number;
  constructor(name: string, timeoutMs: number = callableTimeoutMs(name)) {
    const seconds = Math.round(timeoutMs / 1000);
    // #1919: plain words. The call's name stays on `callableName` for logs and
    // never reaches the screen, and no business name is guessed at here.
    super(`No answer came back within ${seconds} seconds, so it may still have gone through. Check before trying again.`);
    this.name = 'CallableTimeoutError';
    this.callableName = name;
    this.seconds = seconds;
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
   * alone deliberately: the timeout exists so a hang becomes a visible,
   * operator-driven decision, and quietly doubling the wait would undo it.
   */
  idempotent?: boolean;
  /**
   * #1282: a read nobody is looking at. The portal warm-up (`lib/portalWarmup.ts`)
   * fires a screen's reads the moment the portal opens so the first open of
   * that screen lands on a warm instance. Those calls must stay invisible: a
   * refusal is swallowed by the caller, and it must NOT be the thing that
   * signs the household out. `reactToCallableError` is skipped for a
   * background call; the error is still rethrown so the caller sees it, and a
   * success still re-arms the revocation guard like any other. The screen's
   * own foreground call, which runs the full reaction, is what ends a
   * genuinely revoked session.
   */
  background?: boolean;
}

export async function call<TReq, TRes>(
  name: string,
  payload: TReq,
  options: CallOptions = {},
): Promise<TRes> {
  const timeoutMs = callableTimeoutMs(name);
  const fn = httpsCallable<TReq, TRes>(functions, name, { timeout: timeoutMs });
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
        throw new CallableTimeoutError(name, timeoutMs);
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
      if (!options.background) await reactToCallableError(err);
      throw err;
    }
  }
}
