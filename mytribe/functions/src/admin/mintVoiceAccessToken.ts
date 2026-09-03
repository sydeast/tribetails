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
 * Every Twilio resource id is a two-letter prefix followed by 32 hex digits.
 * Exactly 34 characters, always.
 */
const SID_PATTERN = /^[A-Z]{2}[0-9a-f]{32}$/;

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

/**
 * The same, plus the shape.
 *
 * ── WHY PRESENCE IS NOT ENOUGH, LEARNED THE HARD WAY ──────────────────────────
 *
 * On 2026-08-11 all four of these secrets were set and every existing check
 * passed. `lib/declaredSecrets.ts`'s release preflight was satisfied, because it
 * asks whether a secret EXISTS. `requireSecret` above was satisfied, because it
 * asks whether a secret is NON-BLANK. Both answered yes. And yet:
 *
 *   TWIML_APP_SID          33 characters. Twilio 404s it. The application had
 *                          never been created; the value was a stand-in.
 *   TWILIO_API_KEY_SID +
 *   TWILIO_API_KEY_SECRET  401 as credentials.
 *
 * `functions:secrets:set` echoes nothing as you type, so a paste that drops a
 * character is invisible at the moment it happens and stays invisible until a
 * caller cannot be answered. Checking presence and calling that "configured" is
 * the identical mistake to a Studio widget logging `success` on a 200 that
 * carried the wrong answer.
 *
 * A shape check is cheap, runs on every mint, and turns "the phone mysteriously
 * cannot register" into a message naming the secret and what is wrong with it.
 * It cannot prove the id refers to a resource that exists — only Twilio can
 * answer that, and not on this hot path — so `scripts/checkVoiceSecrets.ts`
 * does the live check as an operator step.
 */
function requireSid(value: string, name: string, prefix: string): string {
  const sid = requireSecret(value, name);
  if (!SID_PATTERN.test(sid) || !sid.startsWith(prefix)) {
    throw new HttpsError(
      'failed-precondition',
      `Voice calling is misconfigured: ${name} is not a valid Twilio ${prefix} id. ` +
        `Expected ${prefix} followed by 32 hex characters (34 total), got ${sid.length} ` +
        `character${sid.length === 1 ? '' : 's'} starting "${sid.slice(0, 2)}". ` +
        `A short value is usually a truncated paste; re-copy it from the Twilio console.`,
      { code: 'malformed_secret', secret: name, expectedPrefix: prefix, actualLength: sid.length },
    );
  }
  return sid;
}

export async function mintVoiceAccessTokenHandler(
  req: CallableRequest<unknown>,
): Promise<MintVoiceAccessTokenResult> {
  // wrapAdminCallable has already asserted both of these.
  const uid = req.auth!.uid;

  const accountSid = requireSid(TWILIO_ACCOUNT_SID.value(), 'TWILIO_ACCOUNT_SID', 'AC');
  const apiKeySid = requireSid(TWILIO_API_KEY_SID.value(), 'TWILIO_API_KEY_SID', 'SK');
  const apiKeySecret = requireSecret(TWILIO_API_KEY_SECRET.value(), 'TWILIO_API_KEY_SECRET');

  // ── TWO OPTIONAL SIDS, AND WHY OPTIONAL IS THE HONEST ANSWER ───────────────
  //
  // `outgoingApplicationSid` governs what happens when this device PLACES a
  // call. `incomingAllow` governs whether it can RECEIVE one. Twilio treats
  // them as independent, and a grant carrying only `incomingAllow` is valid.
  //
  // This function used to demand a TwiML Application before it would mint
  // anything. The admin app has no outbound calling at all (`Voice.connect`
  // appears nowhere in it), so that requirement blocked the entire feature on a
  // resource nothing would ever use, and sent the operator into the Twilio
  // console to create one for no reason.
  //
  // Failing loud on missing configuration is right. Inventing a requirement the
  // provider does not have is not, and the two are easy to confuse while
  // writing the first one. Absent now means "no outbound calling", which is the
  // truth about this app.
  //
  // The push credential is optional for the same shape of reason: without it
  // the SDK still places and receives calls while the app is open, and only the
  // wake-from-background push is lost.
  //
  // A MALFORMED value is NOT waved through in either case. A grant carrying a
  // bad SID is rejected by Twilio at registration, which fails harder and later
  // than simply omitting the field.
  const twimlAppRaw = TWIML_APP_SID.value().trim();
  const twimlAppSid = twimlAppRaw ? requireSid(twimlAppRaw, 'TWIML_APP_SID', 'AP') : '';

  const pushCredentialRaw = PUSH_CREDENTIAL_SID.value().trim();
  const pushCredentialSid = pushCredentialRaw
    ? requireSid(pushCredentialRaw, 'PUSH_CREDENTIAL_SID', 'CR')
    : '';

  // Loaded inside the handler, never at file scope. A file-scope twilio import
  // is charged to the cold start of all ~227 functions in index.js; six SDKs
  // were moved out of that graph on 2026-08-04 after it OOMed at 257MiB against
  // a 256MiB limit. See lib/runtimeOptions.ts.
  // `{ default: twilio }`, NOT `{ jwt }`. twilio 6.x is CommonJS, so Node's
  // cjs-module-lexer synthesises exactly two named exports for it, `default`
  // and `module.exports`; every other property, `jwt` included, is reachable
  // only through the default. Destructuring `jwt` directly yields undefined
  // and the next line throws "Cannot read properties of undefined (reading
  // 'AccessToken')" (MYTRIBE-FUNCTIONS-F). tsconfig sets module=nodenext, so
  // this stays a real dynamic import rather than being lowered to require(),
  // which is why the mistake survives compilation. The other two dynamic
  // twilio imports in this codebase, engagementWebhooks.ts and
  // twilioSignature.ts, already take the default.
  const { default: twilio } = await import('twilio');
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const grant = new VoiceGrant({
    ...(twimlAppSid ? { outgoingApplicationSid: twimlAppSid } : {}),
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
