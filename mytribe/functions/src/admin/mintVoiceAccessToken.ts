import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { logEvent } from '../lib/logger';

/**
 * Mints a Twilio Voice SDK access token for the signed-in admin.
 *
 * ── THE ENDPOINT THIS REPLACES WAS PUBLIC ─────────────────────────────────────
 *
 * `auntieos-admin/twilio-service/functions/get-token.js` took no arguments,
 * checked nothing, and returned an access token carrying a `VoiceGrant` with
 * `incomingAllow: true` for the identity `auntie`. Anyone who knew the URL
 * could mint one, register as `client:auntie`, and RECEIVE THE BUSINESS'S
 * INBOUND CALLS. Not read about them: answer them, in place of the operator.
 *
 * It is not being ported. It is being replaced with an admin-gated callable,
 * which is what `auntieos-admin/docs/2026-07-20-comms-spine-design.md:42`
 * specified in the first place.
 *
 * Two rules follow from that, and neither is negotiable:
 *
 *   1. THE IDENTITY IS DERIVED SERVER-SIDE. It is never read from `req.data`.
 *      A caller who could name their own identity could mint a token for
 *      somebody else's client, which is the same hole with an extra step.
 *   2. `AUNTIE_OPERATOR_UIDS` IS DELIBERATELY NOT BOUND. `isStaff` accepts
 *      either the `admin` custom claim or presence on that env allowlist, and
 *      an unbound secret reads as `undefined` with no error, so leaving it out
 *      makes the custom claim the sole gate. For a function that hands out the
 *      ability to answer the business's phone, the narrower gate is the right
 *      one.
 *
 * ── WHY IT IS SAFE TO DEPLOY BEFORE THE SECRETS EXIST ─────────────────────────
 *
 * The four Twilio values below have never existed in this project. The callable
 * is built anyway and throws `failed-precondition` NAMING THE MISSING SECRET,
 * so Android shows a specific, actionable banner rather than the silent `null`
 * `VoiceTokenManager.fetchToken` returns today against the 404ing endpoint.
 *
 * Note `lib/declaredSecrets.ts`: the release preflight REFUSES a deploy when a
 * declared secret was never created in Secret Manager. That is intentional and
 * it applies to this file, so all four must be created before the next release,
 * even if their values are placeholders.
 */

/**
 * A Standard API key pair from Console → Account → API keys & tokens.
 *
 * Deliberately an API KEY rather than the account auth token: a key can be
 * revoked on its own without rotating the credential every other Twilio
 * integration in this repo depends on.
 */
const TWILIO_API_KEY_SID = defineSecret('TWILIO_API_KEY_SID');
const TWILIO_API_KEY_SECRET = defineSecret('TWILIO_API_KEY_SECRET');

/** Console → Voice → TwiML Apps. The app whose Voice URL answers the SDK leg. */
const TWIML_APP_SID = defineSecret('TWIML_APP_SID');

/** Console → Voice → Push Credentials. Lets Twilio wake the app for an incoming call. */
const PUSH_CREDENTIAL_SID = defineSecret('PUSH_CREDENTIAL_SID');

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');

/**
 * The Twilio Client identity the admin registers as.
 *
 * A CONSTANT, not a parameter, and not the caller's uid. The inbound screening
 * leg dials `client:auntie` by name, so both halves have to agree on one
 * literal; deriving it per-uid would mean a second admin's device registering
 * as an identity nothing ever dials, which fails as silence rather than as an
 * error. Matches `CLIENT_IDENTITY=auntie` in the twilio-service env.
 *
 * The consequence, stated plainly: every admin who passes the gate registers as
 * the SAME client, so an incoming call rings all of their devices and the first
 * to answer takes it. That is the intended behaviour for one business line with
 * a small roster. It is not a multi-agent call centre and should not be
 * extended into one without revisiting this constant.
 */
const CLIENT_IDENTITY = 'auntie';

/** One hour, matching the endpoint this replaces. */
const TOKEN_TTL_SECONDS = 3600;

export interface MintVoiceAccessTokenResult {
  token: string;
  identity: string;
  /** Seconds until expiry, so the client can refresh before it lapses rather than after. */
  expiresInSeconds: number;
}

/**
 * Reads a required secret, or throws naming exactly which one is missing.
 *
 * Fail-loud per the project's error policy: a token minted against a blank key
 * would be rejected by Twilio at registration time, surfacing on the phone as
 * "calling does not work" with nothing pointing at the cause.
 */
function requireSecret(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpsError(
      'failed-precondition',
      `Voice calling is not configured yet: the ${name} secret is not set. ` +
        `Set it with: firebase functions:secrets:set ${name}`,
      { code: 'missing_secret', secret: name },
    );
  }
  return trimmed;
}

export async function mintVoiceAccessTokenHandler(
  req: CallableRequest<unknown>,
): Promise<MintVoiceAccessTokenResult> {
  // wrapAdminCallable has already asserted both of these.
  const uid = req.auth!.uid;

  const accountSid = requireSecret(TWILIO_ACCOUNT_SID.value(), 'TWILIO_ACCOUNT_SID');
  const apiKeySid = requireSecret(TWILIO_API_KEY_SID.value(), 'TWILIO_API_KEY_SID');
  const apiKeySecret = requireSecret(TWILIO_API_KEY_SECRET.value(), 'TWILIO_API_KEY_SECRET');
  const twimlAppSid = requireSecret(TWIML_APP_SID.value(), 'TWIML_APP_SID');
  // The push credential is OPTIONAL on purpose: without it the SDK still places
  // and receives calls while the app is in the foreground, and only the
  // wake-from-background push is lost. Refusing the whole token over it would
  // turn a degraded feature into a dead one.
  const pushCredentialSid = PUSH_CREDENTIAL_SID.value().trim();

  // Loaded inside the handler, never at file scope. A file-scope twilio import
  // is charged to the cold start of all ~227 functions in index.js; six SDKs
  // were moved out of that graph on 2026-08-04 after it OOMed at 257MiB against
  // a 256MiB limit. See lib/runtimeOptions.ts.
  const { jwt } = await import('twilio');
  const AccessToken = jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const grant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true,
    ...(pushCredentialSid ? { pushCredentialSid } : {}),
  });

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
    identity: CLIENT_IDENTITY,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant(grant);

  logEvent({
    severity: 'info',
    function: 'mintVoiceAccessToken',
    event: 'mintVoiceAccessToken.minted',
    uid,
    extra: { identity: CLIENT_IDENTITY, hasPushCredential: Boolean(pushCredentialSid) },
  });

  return {
    token: token.toJwt(),
    identity: CLIENT_IDENTITY,
    expiresInSeconds: TOKEN_TTL_SECONDS,
  };
}

export const mintVoiceAccessToken = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    // AUNTIE_OPERATOR_UIDS is deliberately absent; see the file header.
    secrets: [
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      TWIML_APP_SID,
      PUSH_CREDENTIAL_SID,
      'SENTRY_DSN',
    ],
  },
  wrapAdminCallable('mintVoiceAccessToken', mintVoiceAccessTokenHandler),
);
