import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry, isSentryInitialized } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { loadDeclaredSecrets, type DeclaredSecrets } from '../lib/declaredSecrets';
import { signCloudinaryFolderUpload } from '../lib/cloudinary';
import { readConnection } from '../lib/googleCalendarConnection';
import {
  INTEGRATION_CATALOG,
  INTEGRATION_SECRET_NAMES,
  deriveStatus,
  remediationFor,
  summaryFor,
  type CatalogEntry,
  type LivenessState,
  type SecretState,
} from '../lib/integrationCatalog';

/**
 * The state of every external service this system depends on, from one source.
 *
 * WHY A CALLABLE AND NOT A CLIENT-SIDE CHECK. Android used to decide this on the
 * device from a hard-coded list, which is how it went on showing "n8n Webhooks:
 * CONFIGURED" long after n8n was retired, and the React admin had no
 * integrations surface at all. A device cannot see a Cloud Functions secret, so
 * a client-side answer is a guess by construction; two clients guessing
 * separately is how they end up disagreeing about whether the business can send
 * an invoice. This is the answer, and both render it.
 *
 * THIS FUNCTION BINDS EVERY SECRET IT REPORTS ON, and that binding is the whole
 * mechanism. `process.env` in a Cloud Function holds only what that function
 * declared, so a callable that did not bind STRIPE_SECRET_KEY would report it
 * absent whether or not it existed, which is worse than not reporting: it is a
 * confident wrong answer that sends the operator to reset a working key.
 *
 * NO VALUE AND NO PREFIX OF ONE IS EVER RETURNED. Per secret: does something
 * declare it, did it arrive here, and how many characters long is it. Four
 * characters of a Stripe key name the account mode and four of a Twilio SID name
 * the account, so there is no safe prefix and none is sent.
 *
 * NOTHING PAID IS CALLED JUST TO SAY HELLO. Liveness is claimed for exactly
 * three things, and each is free and local:
 *
 *   - Sentry: whether `initSentry` really initialised a client. No event sent.
 *   - Cloudinary: whether a signed-upload signature can be produced from the
 *     three secrets. Pure sha1, no network. This is the actual failure mode
 *     (an upload dies on a signature mismatch), not a proxy for it.
 *   - Google Calendar: the stored connection document, read through the SAME
 *     `readConnection` the Calendar section uses rather than re-derived here.
 *
 * Stripe, Twilio, SMTP2GO and Mapbox get NO probe, and the row says so in as
 * many words. Every call to those is billed or metered, and an integrations page
 * that spends money each time it is opened is a worse bug than the one it
 * reports. A blank where a probe would be, with no explanation, would read as a
 * failure; the sentence is what stops that.
 *
 * A FAILED CHECK IS NEVER FOLDED INTO A CLEAN ONE. A Google connection read that
 * throws yields `unknown`, never `missing` and never green: the credentials are
 * fine, our ability to look is what broke, and sending an operator to reset a
 * correct secret wastes the one action they had in them.
 */

/**
 * No arguments. Exported anyway so the contract guard can freeze the fact that
 * this callable takes nothing: an added field here would mean a client could
 * ask for a narrowed or widened report, and that is a decision, not a tweak.
 */
export const Args = z.object({}).strict();

const SecretStateSchema = z
  .object({
    name: z.string().min(1),
    required: z.boolean(),
    purpose: z.string(),
    /** Some deployed function binds this name. Meaningless when `declaredKnown` is false. */
    declared: z.boolean(),
    /** The name arrived in this function's environment. */
    resolves: z.boolean(),
    /**
     * Character count after trimming, 0 when absent. THE ONLY NUMBER DERIVED
     * FROM A VALUE, and it earns its place: a key pasted half-copied resolves
     * like a good one and fails every call, and a length of 12 where 107 is
     * expected is the one thing that shows it without printing anything.
     */
    length: z.number().int().min(0),
  })
  .strict();

const LivenessSchema = z
  .object({
    /**
     * `none` when no free check exists, `pass`/`fail` for a check that was made,
     * `error` when the check itself broke. `.min(1)` on `detail` is load-bearing:
     * a blank where a result should be reads as a failure, so every outcome
     * including `none` has to say something.
     */
    outcome: z.enum(['none', 'pass', 'fail', 'error']),
    detail: z.string().min(1),
  })
  .strict();

const IntegrationSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    purpose: z.string().min(1),
    status: z.enum(['working', 'configured', 'missing', 'unknown']),
    summary: z.string().min(1),
    secrets: z.array(SecretStateSchema),
    liveness: LivenessSchema,
    /** The exact operator step, with the command. Empty when nothing is owed. */
    remediation: z.string(),
    /** A console step this repo cannot take for them. Empty when there is none. */
    externalStep: z.string(),
    /** The Settings section owning this integration's own flow. Empty when none. */
    ownedBySection: z.string(),
  })
  .strict();

export const Result = z
  .object({
    checkedAt: z.string().min(1),
    /**
     * False when the declared-secret walk could not run. Every `declared` above
     * is then unfounded and both clients say so, because "nothing declares it"
     * and "we could not find out" send the operator to different places.
     */
    declaredKnown: z.boolean(),
    /** Empty when `declaredKnown`. Otherwise why not, in the operator's words. */
    declaredError: z.string(),
    integrations: z.array(IntegrationSchema),
  })
  .strict();

export type IntegrationSecretState = z.infer<typeof SecretStateSchema>;
export type IntegrationReport = z.infer<typeof IntegrationSchema>;
export type IntegrationsHealthResult = z.infer<typeof Result>;

/**
 * The seams a unit test replaces. `loadFunctionModule` is the important one: in
 * a deployed function it hands back the already-loaded functions index, so the
 * declared set comes from the same artifact the Firebase CLI validates against;
 * importing that index inside a test would drag in two hundred modules to answer
 * one question.
 */
export interface IntegrationsHealthDeps {
  loadFunctionModule: () => Promise<unknown>;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

export const defaultDeps: IntegrationsHealthDeps = {
  // Imported at CALL time, never at module load. `../index` re-exports this very
  // file, so a top-level import would be a cycle; by the time a request lands,
  // Firebase has fully evaluated that module and this is a cache hit.
  //
  // Deferred `require`, not `import()`. Under `module: nodenext` tsc preserves
  // `import('../index')` as a real ESM import, and Node's ESM resolver rejects
  // an extensionless relative specifier — this exact call throws
  // ERR_MODULE_NOT_FOUND at run time, which is a cold-start failure no type
  // check would have caught. The require is what the commonjs emit already
  // produced, and it keeps the module-cache hit this comment relies on.
  //
  // The other deferred loads in src/ stay `await import()` because a bare
  // require escapes Vitest's module graph and walks past their `vi.mock`
  // (see src/lib/googleOAuth.ts). This one is exempt: it is a dependency-
  // injection seam, replaced wholesale by test/getIntegrationsHealth.ts rather
  // than mocked by specifier, so nothing here relies on Vitest intercepting it.
  //
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a real ESM import() of this extensionless relative path throws ERR_MODULE_NOT_FOUND; see above.
  loadFunctionModule: async () => require('../index') as unknown,
  env: process.env,
  now: () => new Date(),
};

/** One secret, answered from the declared set and this function's own environment. */
function readSecret(
  secret: CatalogEntry['secrets'][number],
  declared: DeclaredSecrets,
  env: NodeJS.ProcessEnv,
): SecretState {
  const raw = env[secret.name];
  // Whitespace is not a value. A secret pasted with a trailing newline is the
  // classic way a key "is set" and every call still fails, so it is treated as
  // absent here rather than reported as a working credential.
  const value = typeof raw === 'string' ? raw.trim() : '';
  return {
    name: secret.name,
    required: secret.required,
    purpose: secret.purpose,
    declared: declared.known && declared.names.includes(secret.name),
    resolves: value !== '',
    length: value.length,
  };
}

/** The stated absence of a probe. Never silent: the sentence is the point. */
function noProbe(detail: string): LivenessState {
  return { outcome: 'none', detail };
}

/**
 * Cloudinary's real failure mode, checked without a network call: can a signed
 * upload actually be signed. The signature is computed and DISCARDED, never
 * returned, and it is computed over a throwaway folder name so it could not be
 * replayed even if it did escape.
 */
export function probeCloudinary(
  secrets: readonly SecretState[],
  env: NodeJS.ProcessEnv,
): LivenessState {
  const byName = new Map(secrets.map((s) => [s.name, s]));
  if (!byName.get('CLOUDINARY_API_SECRET')?.resolves || !byName.get('CLOUDINARY_API_KEY')?.resolves) {
    return noProbe('Signing cannot be checked until the key and secret are set.');
  }
  try {
    const signed = signCloudinaryFolderUpload({
      cloudName: 'health-check',
      apiKey: 'health-check',
      apiSecret: env['CLOUDINARY_API_SECRET'] ?? '',
      folder: 'health-check',
    });
    const ok = /^[0-9a-f]{40}$/.test(signed.signature);
    return {
      outcome: ok ? 'pass' : 'fail',
      detail: ok
        ? 'A signed upload can be signed, so photo uploads have working credentials. No network call was made.'
        : 'The upload signature came out malformed, so Cloudinary would refuse every upload.',
    };
  } catch (err) {
    return {
      outcome: 'error',
      detail: `The upload signature could not be computed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/**
 * Google Calendar, read from the stored connection rather than re-derived. Same
 * document, same reader (`readConnection`) as the Calendar section, so the two
 * surfaces cannot disagree about whether an account is connected.
 */
export async function probeGoogleCalendar(secrets: readonly SecretState[]): Promise<LivenessState> {
  if (secrets.some((s) => s.required && !s.resolves)) {
    return noProbe('The connection cannot be checked until the OAuth client ID and secret are set.');
  }
  try {
    const connection = await readConnection(db());
    if (connection.connected) {
      const target =
        connection.writeCalendarId.trim() === ''
          ? 'No calendar is picked yet, so nothing is written until one is.'
          : `Visits are written to ${connection.writeCalendarId}.`;
      return {
        outcome: 'pass',
        detail: `Connected as ${connection.googleAccountEmail || 'a Google account'}. ${target}`,
      };
    }
    const because =
      connection.connectLastError.trim() !== ''
        ? ` The last attempt failed: ${connection.connectLastError}`
        : '';
    // `fail`, not `error`: nothing broke. No account has been connected yet, and
    // the operator finishes that in the Google Calendar section rather than here.
    return {
      outcome: 'fail',
      detail: `No Google account has been connected yet, so no visit is written to a calendar.${because}`,
    };
  } catch (err) {
    return {
      outcome: 'error',
      detail: `The stored connection could not be read: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/** Whether error reporting is genuinely on, not merely configured. No event is sent. */
function probeSentry(secrets: readonly SecretState[]): LivenessState {
  if (secrets.some((s) => s.required && !s.resolves)) {
    return noProbe('Error reporting cannot be checked until the DSN is set.');
  }
  const on = isSentryInitialized();
  return {
    outcome: on ? 'pass' : 'fail',
    detail: on
      ? 'Error reporting is initialised and running in this function. No test event was sent.'
      : 'The DSN is set but Sentry did not initialise in this function, so errors raised here are going nowhere.',
  };
}

/**
 * The stated reason a metered vendor is not pinged. Named per integration rather
 * than shared, because "we do not check" is only acceptable when the operator
 * can see WHY, and the why differs.
 */
const NO_PROBE_REASON: Record<string, string> = {
  stripe:
    'Not verified here: every Stripe call is a live call against the payments account, so nothing pings it just to check. A real payment is the proof.',
  twilio:
    'Not verified here: Twilio meters requests, so nothing calls it just to check. The first send after a change is the proof.',
  smtp2go:
    'Not verified here: SMTP2GO counts every API call against the send allowance, so nothing calls it just to check.',
  mapbox:
    'Not verified here: Mapbox bills per geocoding request, so nothing looks up an address just to check.',
};

async function livenessFor(
  entry: CatalogEntry,
  secrets: readonly SecretState[],
  env: NodeJS.ProcessEnv,
): Promise<LivenessState> {
  switch (entry.key) {
    case 'cloudinary':
      return probeCloudinary(secrets, env);
    case 'googleCalendar':
      return probeGoogleCalendar(secrets);
    case 'sentry':
      return probeSentry(secrets);
    default:
      return noProbe(
        NO_PROBE_REASON[entry.key] ?? 'Not verified here: no check exists for this one that costs nothing.',
      );
  }
}

export async function getIntegrationsHealthHandler(
  req: CallableRequest<unknown>,
  deps: IntegrationsHealthDeps = defaultDeps,
): Promise<IntegrationsHealthResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  // No `Args.parse`: an empty strict object would reject the `{}` some clients
  // send and the `undefined` others send for the same no-arg call, and refusing
  // a read over the shape of nothing helps nobody.
  const declared = await loadDeclaredSecrets(deps.loadFunctionModule);

  const integrations: IntegrationReport[] = [];
  for (const entry of INTEGRATION_CATALOG) {
    const secrets = entry.secrets.map((secret) => readSecret(secret, declared, deps.env));
    const liveness = await livenessFor(entry, secrets, deps.env);
    const status = deriveStatus(secrets, liveness);
    integrations.push({
      key: entry.key,
      name: entry.name,
      purpose: entry.purpose,
      status,
      summary: summaryFor(entry, status, secrets, liveness),
      secrets,
      liveness,
      remediation: remediationFor(entry, secrets, declared.known),
      externalStep: entry.externalStep,
      ownedBySection: entry.ownedBySection,
    });
  }

  logEvent({
    severity: 'info',
    function: 'getIntegrationsHealth',
    event: 'admin.integrations.health.read',
    uid,
    extra: {
      declaredKnown: declared.known,
      // Counts and statuses only. No secret name is paired with a value or a
      // length in the log, and no value is logged anywhere.
      statuses: Object.fromEntries(integrations.map((i) => [i.key, i.status])),
    },
  });

  return validateResponse('getIntegrationsHealth', Result, {
    checkedAt: deps.now().toISOString(),
    declaredKnown: declared.known,
    declaredError: declared.reason,
    integrations,
  });
}

export const getIntegrationsHealth = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    // EVERY REPORTED SECRET IS BOUND HERE, and that is the mechanism, not
    // housekeeping: `process.env` carries only what this function declared, so
    // an unbound name would be reported absent whether or not it exists.
    // AUNTIE_OPERATOR_UIDS is bound because `wrapAdminCallable` goes through
    // `isStaff`, which reads it; without it the allowlist fallback silently
    // stops matching and a legitimate operator is refused.
    secrets: [...INTEGRATION_SECRET_NAMES, 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('getIntegrationsHealth', getIntegrationsHealthHandler),
);
