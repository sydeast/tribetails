import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

/**
 * Typed callables client — lifted from MyTribe/web/src/lib/fns.ts (the plan's
 * A1 ruling: share this seam, do not re-derive it). Every AuntieOS admin
 * callable this app will reach is a Firebase onCall in us-central1 (defined and
 * tested in MyTribe/functions); this is the single choke point the api/ layer
 * goes through, so the timeout + error mapping live in exactly one place.
 *
 * O-20: a callable that never responds (cold start, a dropped POST after a
 * successful CORS preflight, a wedged revision) must not read as an infinite
 * spinner. The SDK default is 70s — long enough that the operator gives up
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

export async function call<TReq, TRes>(name: string, payload: TReq): Promise<TRes> {
  const fn = httpsCallable<TReq, TRes>(functions, name, { timeout: CALLABLE_TIMEOUT_MS });
  try {
    const result = await fn(payload);
    return result.data;
  } catch (err) {
    if (err instanceof FirebaseError && err.code === 'functions/deadline-exceeded') {
      throw new CallableTimeoutError(name);
    }
    throw err;
  }
}
