import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callableRequest } from './_helpers/callableRequest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  sentryOn: vi.fn(() => false),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({
  initSentry: vi.fn(),
  isSentryInitialized: mocks.sentryOn,
  captureFunctionError: vi.fn(),
  captureCritical: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import {
  getIntegrationsHealthHandler,
  Result,
  type IntegrationReport,
  type IntegrationsHealthDeps,
  type IntegrationsHealthResult,
} from '../src/admin/getIntegrationsHealth';
import {
  INTEGRATION_CATALOG,
  INTEGRATION_SECRET_NAMES,
  deriveStatus,
  setSecretCommand,
  type SecretState,
} from '../src/lib/integrationCatalog';
import { collectDeclaredSecrets, loadDeclaredSecrets } from '../src/lib/declaredSecrets';

/**
 * `getIntegrationsHealth` is the one place the operator is told whether the
 * business can take a payment, send a text, or store a photo. Two properties
 * matter more than any individual row, and both are asserted here rather than
 * assumed:
 *
 *   - NO SECRET VALUE, AND NO PREFIX OF ONE, LEAVES THE SERVER. Asserted by
 *     serialising the whole response and searching it for the values the fake
 *     environment holds, plus every 4-character prefix of each. A field added
 *     later that carried a value would turn this red without anyone having to
 *     remember the rule.
 *   - "WE COULD NOT LOOK" NEVER RENDERS AS "NOTHING IS WRONG". A probe that
 *     throws is `unknown`, never `working` and never `missing`.
 */

/**
 * Values long enough that a prefix test is meaningful, and obviously fake.
 * Real-SHAPED on purpose (`AC…` for a Twilio SID, `GOCSPX-` for a Google client
 * secret): the leak test searches for prefixes, and a prefix of a realistic key
 * is exactly what would identify an account.
 *
 * THE STRIPE ONE IS `sk_test_`, NOT `sk_live_`, and that is not fussiness. The
 * repo's pre-commit credential scan matches `sk_live_[A-Za-z0-9]{10,}` and
 * refuses the commit, which it should: a fixture that looks like a live key
 * trains everyone to wave the scanner through. The test-mode prefix has the same
 * structure and length, so it proves the same thing. Do not "make it realistic".
 */
const FAKE = {
  STRIPE_SECRET_KEY: 'sk_test_51FAKEfakeFAKEfakeFAKEfakeFAKEfake',
  STRIPE_WEBHOOK_SECRET: 'whsec_FAKEfakeFAKEfakeFAKEfake',
  TWILIO_ACCOUNT_SID: 'ACfakefakefakefakefakefakefakefake',
  TWILIO_AUTH_TOKEN: 'fakefakefakefakefakefakefakefake',
  TWILIO_FROM_NUMBER: '+15550000000',
  // Required alongside the three above: `mintVoiceAccessToken.ts` throws
  // `failed-precondition` if either is blank, so the catalog marks both
  // required (unlike TWIML_APP_SID and PUSH_CREDENTIAL_SID, which that same
  // callable genuinely treats as optional — see integrationCatalog.ts).
  TWILIO_API_KEY_SID: 'SKfakefakefakefakefakefakefakefake',
  TWILIO_API_KEY_SECRET: 'fakeVoiceApiKeySecretFakeFakeFake',
  SMTP2GO_API_KEY: 'api-FAKEfakeFAKEfakeFAKEfake',
  EMAIL_FROM: 'auntie@tribetails.invalid',
  CLOUDINARY_CLOUD_NAME: 'fake-cloud',
  CLOUDINARY_API_KEY: '123456789012345',
  CLOUDINARY_API_SECRET: 'fakeCloudinarySecretValue123456',
  MAPBOX_ACCESS_TOKEN: 'sk.fakeMapboxTokenValue0123456789',
  GOOGLE_OAUTH_CLIENT_ID: '1234567890-fake.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-fakeGoogleClientSecret',
  SENTRY_DSN: 'https://fakekey@o0.ingest.sentry.io/0',
} as const;

/** Every catalog secret set to its fake value, minus whatever the case drops. */
function envWith(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...FAKE };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** A stand-in functions module whose endpoints declare the given secret names. */
function moduleDeclaring(names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.map((name, i) => [
      `fn${String(i)}`,
      { __endpoint: { secretEnvironmentVariables: [{ key: name }] } },
    ]),
  );
}

/** The Google Calendar connection document, as `readConnection` reads it. */
function dbWithConnection(data: Record<string, unknown> | undefined) {
  return { doc: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => data })) })) };
}

function deps(overrides: Partial<IntegrationsHealthDeps> = {}): IntegrationsHealthDeps {
  return {
    loadFunctionModule: async () => moduleDeclaring(INTEGRATION_SECRET_NAMES),
    env: envWith(),
    now: () => new Date('2026-07-31T12:00:00.000Z'),
    ...overrides,
  };
}

async function run(overrides: Partial<IntegrationsHealthDeps> = {}): Promise<IntegrationsHealthResult> {
  return getIntegrationsHealthHandler(callableRequest({}, { uid: 'admin1', token: { admin: true } }), deps(overrides));
}

function row(result: IntegrationsHealthResult, key: string): IntegrationReport {
  const found = result.integrations.find((i) => i.key === key);
  if (!found) throw new Error(`no ${key} row in the response`);
  return found;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.dbFn.mockReturnValue(dbWithConnection(undefined));
  mocks.sentryOn.mockReturnValue(false);
});

describe('getIntegrationsHealth, the shape of the answer', () => {
  it('reports every integration in the catalog, and nothing else', async () => {
    const res = await run();
    expect(res.integrations.map((i) => i.key)).toEqual(INTEGRATION_CATALOG.map((c) => c.key));
  });

  it('passes its own response schema', async () => {
    expect(Result.safeParse(await run()).success).toBe(true);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(getIntegrationsHealthHandler(callableRequest({}), deps())).rejects.toThrow(/Sign-in required/);
  });
});

describe('getIntegrationsHealth never returns a secret', () => {
  it('carries no secret value and no prefix of one, anywhere in the response', async () => {
    const serialised = JSON.stringify(await run());
    for (const [name, value] of Object.entries(FAKE)) {
      expect(serialised, `${name}'s value leaked`).not.toContain(value);
      // Four characters of a Stripe key names the account mode and four of a
      // Twilio SID names the account, so a "safe prefix" does not exist and the
      // test refuses any.
      expect(serialised, `${name}'s prefix leaked`).not.toContain(value.slice(0, 4));
    }
  });

  it('reports length instead, so a half-pasted key is still visible', async () => {
    const stripe = row(await run(), 'stripe');
    const key = stripe.secrets.find((s) => s.name === 'STRIPE_SECRET_KEY');
    expect(key?.length).toBe(FAKE.STRIPE_SECRET_KEY.length);
    expect(key?.resolves).toBe(true);
  });

  it('logs statuses only, never a secret name paired with anything about its value', async () => {
    const { logEvent } = await import('../src/lib/logger');
    await run();
    const call = vi.mocked(logEvent).mock.calls.at(-1)?.[0];
    expect(JSON.stringify(call)).not.toContain(FAKE.STRIPE_SECRET_KEY.slice(0, 4));
  });
});

describe('getIntegrationsHealth, a missing secret', () => {
  it('is `missing`, names the secret, and prints the exact command', async () => {
    const res = await run({ env: envWith({ TWILIO_AUTH_TOKEN: undefined }) });
    const twilio = row(res, 'twilio');
    expect(twilio.status).toBe('missing');
    expect(twilio.summary).toContain('TWILIO_AUTH_TOKEN');
    expect(twilio.remediation).toContain(setSecretCommand('TWILIO_AUTH_TOKEN'));
    expect(twilio.remediation).toContain('firebase functions:secrets:set TWILIO_AUTH_TOKEN');
  });

  it('treats a whitespace-only value as absent, not as a working credential', async () => {
    const res = await run({ env: envWith({ MAPBOX_ACCESS_TOKEN: '   \n' }) });
    const mapbox = row(res, 'mapbox');
    expect(mapbox.status).toBe('missing');
    expect(mapbox.secrets[0]?.resolves).toBe(false);
    expect(mapbox.secrets[0]?.length).toBe(0);
  });

  it('does not drag an unrelated integration down with it', async () => {
    const res = await run({ env: envWith({ TWILIO_AUTH_TOKEN: undefined }) });
    expect(row(res, 'smtp2go').status).not.toBe('missing');
  });

  it('names every missing secret at once rather than one at a time', async () => {
    const res = await run({ env: envWith({ SMTP2GO_API_KEY: undefined, EMAIL_FROM: undefined }) });
    const smtp = row(res, 'smtp2go');
    expect(smtp.remediation).toContain('SMTP2GO_API_KEY');
    expect(smtp.remediation).toContain('EMAIL_FROM');
  });

  // Regression coverage for #580: the Voice SDK secrets used to be marked
  // `required: false` across the board, which hid a broken voice feature
  // behind a green "configured" status. `mintVoiceAccessToken.ts` throws
  // without TWILIO_API_KEY_SID/SECRET, so those two must fail this integration
  // red; TWIML_APP_SID and PUSH_CREDENTIAL_SID are genuinely optional there
  // (see integrationCatalog.ts) and must NOT.
  it.each(['TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET'])(
    'is `missing` without %s, the pair mintVoiceAccessToken cannot mint a token without',
    async (name) => {
      const res = await run({ env: envWith({ [name]: undefined }) });
      const twilio = row(res, 'twilio');
      expect(twilio.status).toBe('missing');
      expect(twilio.remediation).toContain(name);
    },
  );

  it.each(['TWIML_APP_SID', 'PUSH_CREDENTIAL_SID'])(
    'stays `configured` without %s, which mintVoiceAccessToken treats as optional',
    async (name) => {
      const res = await run({ env: envWith({ [name]: undefined }) });
      const twilio = row(res, 'twilio');
      expect(twilio.status).toBe('configured');
      expect(twilio.remediation).toBe('');
    },
  );
});

describe('getIntegrationsHealth, the metered vendors', () => {
  it.each(['stripe', 'twilio', 'smtp2go', 'mapbox'])(
    'does not probe %s, and says why rather than leaving a blank',
    async (key) => {
      const integration = row(await run(), key);
      expect(integration.liveness.outcome).toBe('none');
      expect(integration.liveness.detail).not.toBe('');
      expect(integration.status).toBe('configured');
    },
  );

  it('leaves no remediation line under an integration that owes nothing', async () => {
    expect(row(await run(), 'twilio').remediation).toBe('');
  });

  it('names the Stripe Connect external stop even while card payments work', async () => {
    const stripe = row(await run(), 'stripe');
    expect(stripe.status).toBe('configured');
    expect(stripe.externalStep).toContain('Connect client ID');
  });
});

describe('getIntegrationsHealth, the free probes', () => {
  it('proves Cloudinary can sign an upload, without a network call', async () => {
    const cloudinary = row(await run(), 'cloudinary');
    expect(cloudinary.liveness.outcome).toBe('pass');
    expect(cloudinary.status).toBe('working');
  });

  it('reports Sentry as working only when it actually initialised', async () => {
    expect(row(await run(), 'sentry').status).toBe('configured');
    mocks.sentryOn.mockReturnValue(true);
    expect(row(await run(), 'sentry').status).toBe('working');
  });

  it('reads Google Calendar from the stored connection, not from a second guess', async () => {
    mocks.dbFn.mockReturnValue(
      dbWithConnection({
        connected: true,
        refreshToken: 'stored-server-side-only',
        googleAccountEmail: 'auntie@tribetails.invalid',
        writeCalendarId: 'work@group.calendar.google.com',
      }),
    );
    const gcal = row(await run(), 'googleCalendar');
    expect(gcal.status).toBe('working');
    expect(gcal.summary).toContain('auntie@tribetails.invalid');
    expect(JSON.stringify(gcal)).not.toContain('stored-server-side-only');
  });

  it('points at the Calendar section rather than rebuilding the connect flow', async () => {
    const gcal = row(await run(), 'googleCalendar');
    // 'calendar' is the merged Settings tab (#145 folded the googleCalendar tab
    // into it). The web client still aliases the retired 'googleCalendar' id so
    // an older deployed server stays routable; the server itself sends the
    // current id.
    expect(gcal.ownedBySection).toBe('calendar');
    expect(gcal.status).toBe('configured');
    expect(gcal.summary).toContain('No Google account has been connected');
  });

  it('surfaces the stored reason a connect attempt failed instead of a bare "not connected"', async () => {
    mocks.dbFn.mockReturnValue(
      dbWithConnection({ connected: false, connectLastError: 'Consent was declined.' }),
    );
    expect(row(await run(), 'googleCalendar').summary).toContain('Consent was declined.');
  });

  it('is `unknown`, never green and never `missing`, when the check itself throws', async () => {
    mocks.dbFn.mockReturnValue({
      doc: vi.fn(() => ({
        get: vi.fn(async () => {
          throw new Error('Firestore is unreachable');
        }),
      })),
    });
    const gcal = row(await run(), 'googleCalendar');
    expect(gcal.status).toBe('unknown');
    expect(gcal.summary).toContain('Firestore is unreachable');
  });
});

describe('getIntegrationsHealth, the declared-secret half', () => {
  it('marks a secret declared when a deployed function binds it', async () => {
    const res = await run();
    expect(res.declaredKnown).toBe(true);
    expect(row(res, 'mapbox').secrets[0]?.declared).toBe(true);
  });

  it('says a resolved-but-undeclared secret will not reach the code that needs it', async () => {
    const res = await run({
      loadFunctionModule: async () =>
        moduleDeclaring(INTEGRATION_SECRET_NAMES.filter((n) => n !== 'MAPBOX_ACCESS_TOKEN')),
    });
    const mapbox = row(res, 'mapbox');
    expect(mapbox.secrets[0]?.declared).toBe(false);
    expect(mapbox.remediation).toContain('MAPBOX_ACCESS_TOKEN');
    expect(mapbox.remediation).toContain('secrets array');
  });

  it('says it could not look, rather than that nothing is declared, when the walk fails', async () => {
    const res = await run({
      loadFunctionModule: async () => {
        throw new Error('the functions index would not load');
      },
    });
    expect(res.declaredKnown).toBe(false);
    expect(res.declaredError).toContain('would not load');
    // A false `declared` under an unknown walk must not become a remediation
    // line: telling an operator to bind a secret that is already bound is worse
    // than saying nothing.
    expect(row(res, 'mapbox').remediation).toBe('');
  });
});

describe('collectDeclaredSecrets', () => {
  it('de-duplicates and sorts across every export', () => {
    expect(
      collectDeclaredSecrets({
        a: { __endpoint: { secretEnvironmentVariables: [{ key: 'B' }, { key: 'A' }] } },
        b: { __endpoint: { secretEnvironmentVariables: [{ key: 'A' }] } },
      }),
    ).toEqual(['A', 'B']);
  });

  it('skips an export whose __endpoint getter throws instead of reporting nothing', () => {
    const hostile = {
      get __endpoint(): never {
        throw new Error('GCLOUD_PROJECT is unset');
      },
    };
    const mod = { hostile, fine: { __endpoint: { secretEnvironmentVariables: [{ key: 'SENTRY_DSN' }] } } };
    expect(collectDeclaredSecrets(mod)).toEqual(['SENTRY_DSN']);
  });

  it('treats an empty walk as a failed read, not as an honest empty answer', async () => {
    const result = await loadDeclaredSecrets(async () => ({}));
    expect(result.known).toBe(false);
    expect(result.reason).not.toBe('');
  });
});

describe('deriveStatus', () => {
  const secret = (over: Partial<SecretState> = {}): SecretState => ({
    name: 'X',
    required: true,
    purpose: '',
    declared: true,
    resolves: true,
    length: 8,
    ...over,
  });

  it('lets a missing required secret win over a failed probe', () => {
    expect(deriveStatus([secret({ resolves: false })], { outcome: 'error', detail: 'x' })).toBe('missing');
  });

  it('ignores an optional secret that never resolved', () => {
    expect(deriveStatus([secret({ required: false, resolves: false })], { outcome: 'none', detail: 'x' })).toBe(
      'configured',
    );
  });

  it('separates a check that failed from a check that could not be made', () => {
    expect(deriveStatus([secret()], { outcome: 'fail', detail: 'x' })).toBe('configured');
    expect(deriveStatus([secret()], { outcome: 'error', detail: 'x' })).toBe('unknown');
  });
});
