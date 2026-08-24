import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { reactToCallableError } from './revokedSession';

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
export async function call<TReq, TRes>(name: string, payload: TReq): Promise<TRes> {
  const fn = httpsCallable<TReq, TRes>(functions, name, { timeout: CALLABLE_TIMEOUT_MS });
  try {
    const result = await fn(payload);
    return result.data;
  } catch (err) {
    if (err instanceof FirebaseError && err.code === 'functions/deadline-exceeded') {
      throw new CallableTimeoutError(name);
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
