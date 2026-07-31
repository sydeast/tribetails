import type { CallableRequest } from 'firebase-functions/v2/https';

/**
 * Builds a fully-typed `CallableRequest` for handler unit tests.
 *
 * Handler tests call `someHandler(...)` directly rather than going through the
 * Functions runtime, so they have to synthesise the request. A bare
 * `{ data: {...} }` object literal is not a `CallableRequest` — it is missing
 * `rawRequest` and `acceptsStreaming` — and until `tsconfig.test.json` existed
 * nothing said so, because the test suite was never type-checked at all.
 *
 * The two casts below are deliberately the ONLY ones, and they live here rather
 * than at the ~18 call sites they replace:
 *
 *  - `rawRequest` is an express `Request`, ~200 members of HTTP machinery.
 *    Handlers read `headers` and `ip` off it and nothing else, so those are the
 *    only two this fakes.
 *  - `token` is a `DecodedIdToken` carrying a dozen Firebase-issued claims
 *    (aud, iss, iat, exp, auth_time, firebase.*) that no gate in this codebase
 *    reads. Gates check `uid` and custom claims such as `admin`. Filling in the
 *    issuer claims would assert nothing and would rot the moment Firebase adds
 *    a field.
 *
 * Reach for this instead of `as any` — an `any` here re-opens exactly the hole
 * this file was added to close.
 */
export interface CallableRequestOverrides {
  /**
   * The signed-in caller. OMIT IT for an unauthenticated request: `auth` is
   * then left `undefined`, which is what the runtime hands an anonymous caller
   * and what the auth guards branch on.
   */
  uid?: string;
  /** Custom claims on the caller's token, e.g. `{ admin: true }`. Ignored without `uid`. */
  token?: Record<string, unknown>;
  /** Headers a handler may read off `rawRequest`, e.g. `x-forwarded-for`. */
  headers?: Record<string, string>;
  /** Caller IP, read as `rawRequest.ip`. */
  ip?: string;
}

type RawRequest = CallableRequest['rawRequest'];
type AuthToken = NonNullable<CallableRequest['auth']>['token'];

export function callableRequest<T = unknown>(
  data: T,
  overrides: CallableRequestOverrides = {},
): CallableRequest<T> {
  const { uid, token, headers, ip } = overrides;
  const rawRequest = { headers: headers ?? {}, ip } as unknown as RawRequest;
  return {
    data,
    rawRequest,
    acceptsStreaming: false,
    instanceIdToken: undefined,
    auth:
      uid === undefined
        ? undefined
        : {
            uid,
            token: { uid, sub: uid, ...token } as unknown as AuthToken,
            // The undecoded JWT. Nothing server-side re-verifies it in a unit
            // test, but it is required on AuthData, so it gets an obviously
            // fake value rather than a cast that would hide the field.
            rawToken: 'test-raw-token',
          },
  };
}
