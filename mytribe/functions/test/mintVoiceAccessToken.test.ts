import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

/**
 * The admin-gated replacement for a PUBLIC token minter.
 *
 * `auntieos-admin/twilio-service/functions/get-token.js` took no arguments and
 * checked nothing, and returned an access token carrying a VoiceGrant with
 * `incomingAllow: true` for the identity `auntie`. Anyone with the URL could
 * mint one and answer the business's inbound calls in place of the operator.
 *
 * So the tests that matter here are the ones about what the token CONTAINS and
 * where the identity COMES FROM, not merely that a string is returned.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
  /** Records every AccessToken construction and grant, so the JWT's contents are assertable. */
  accessTokens: [] as Array<{
    accountSid: string;
    keySid: string;
    keySecret: string;
    opts: Record<string, unknown>;
    grants: Array<Record<string, unknown>>;
  }>,
}));

vi.mock('../src/lib/logger', () => ({ logEvent: (...args: unknown[]) => mocks.logEvent(...args) }));

vi.mock('twilio', () => {
  class VoiceGrant {
    constructor(public opts: Record<string, unknown>) {}
  }
  class AccessToken {
    static VoiceGrant = VoiceGrant;
    grants: Array<Record<string, unknown>> = [];
    record: (typeof mocks.accessTokens)[number];
    constructor(
      accountSid: string,
      keySid: string,
      keySecret: string,
      opts: Record<string, unknown>,
    ) {
      this.record = { accountSid, keySid, keySecret, opts, grants: this.grants };
      mocks.accessTokens.push(this.record);
    }
    addGrant(grant: VoiceGrant): void {
      this.grants.push(grant.opts);
    }
    toJwt(): string {
      return 'jwt-for-' + String(this.record.opts.identity);
    }
  }
  return { jwt: { AccessToken } };
});

const SECRET_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWIML_APP_SID',
  'PUSH_CREDENTIAL_SID',
] as const;

beforeEach(() => {
  mocks.logEvent.mockReset();
  mocks.accessTokens.length = 0;
  for (const name of SECRET_ENV) delete process.env[name];
});

/** All five configured, the state after the operator finishes Twilio setup. */
function configureAll(): void {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_API_KEY_SID = 'SKtest';
  process.env.TWILIO_API_KEY_SECRET = 'keysecret';
  process.env.TWIML_APP_SID = 'APtest';
  process.env.PUSH_CREDENTIAL_SID = 'CRtest';
}

async function loadHandler() {
  const mod = await import('../src/admin/mintVoiceAccessToken');
  return mod.mintVoiceAccessTokenHandler;
}

/** A request as `wrapAdminCallable` would have already validated it. */
function adminReq(data: unknown = {}): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin-uid-1', token: { admin: true } },
  } as unknown as CallableRequest<unknown>;
}

describe('mintVoiceAccessToken', () => {
  it('mints a token with an incoming VoiceGrant bound to the TwiML app', async () => {
    configureAll();
    const handler = await loadHandler();
    const out = await handler(adminReq());

    expect(out.token).toBe('jwt-for-auntie');
    expect(out.identity).toBe('auntie');
    expect(out.expiresInSeconds).toBe(3600);

    expect(mocks.accessTokens).toHaveLength(1);
    const minted = mocks.accessTokens[0]!;
    expect(minted.accountSid).toBe('ACtest');
    expect(minted.keySid).toBe('SKtest');
    expect(minted.keySecret).toBe('keysecret');
    expect(minted.grants).toEqual([
      { outgoingApplicationSid: 'APtest', incomingAllow: true, pushCredentialSid: 'CRtest' },
    ]);
  });

  it('SIGNS WITH THE API KEY, never the account auth token', async () => {
    // The key is revokable on its own. Signing with TWILIO_AUTH_TOKEN would mean
    // cutting off voice required rotating the credential every other Twilio
    // integration in this repo depends on.
    configureAll();
    process.env.TWILIO_AUTH_TOKEN = 'account-auth-token';
    const handler = await loadHandler();
    await handler(adminReq());
    const minted = mocks.accessTokens[0]!;
    expect(minted.keySecret).not.toBe('account-auth-token');
    expect(minted.keySid).toMatch(/^SK/);
  });

  it('DERIVES the identity server-side and ignores a caller-supplied one', async () => {
    // The whole point. A caller who could name their own identity could mint a
    // token for somebody else's client, which is the original hole with a step.
    configureAll();
    const handler = await loadHandler();
    const out = await handler(adminReq({ identity: 'attacker', uid: 'someone-else' }));
    expect(out.identity).toBe('auntie');
    expect(mocks.accessTokens[0]!.opts.identity).toBe('auntie');
  });

  it.each([
    ['TWILIO_ACCOUNT_SID'],
    ['TWILIO_API_KEY_SID'],
    ['TWILIO_API_KEY_SECRET'],
    ['TWIML_APP_SID'],
  ])('REFUSES with failed-precondition naming %s when it is unset', async (missing) => {
    configureAll();
    delete process.env[missing];
    const handler = await loadHandler();
    await expect(handler(adminReq())).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining(missing),
      details: { code: 'missing_secret', secret: missing },
    });
    expect(mocks.accessTokens).toHaveLength(0);
  });

  it('treats a blank secret as unset rather than minting against an empty key', async () => {
    configureAll();
    process.env.TWIML_APP_SID = '   ';
    const handler = await loadHandler();
    await expect(handler(adminReq())).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('still mints WITHOUT the push credential, degrading rather than dying', async () => {
    // No push credential means no wake-from-background, but calling still works
    // while the app is open. Refusing the token would turn a degraded feature
    // into a dead one.
    configureAll();
    delete process.env.PUSH_CREDENTIAL_SID;
    const handler = await loadHandler();
    const out = await handler(adminReq());
    expect(out.token).toBe('jwt-for-auntie');
    expect(mocks.accessTokens[0]!.grants[0]).toEqual({
      outgoingApplicationSid: 'APtest',
      incomingAllow: true,
    });
    expect(mocks.accessTokens[0]!.grants[0]).not.toHaveProperty('pushCredentialSid');
  });

  it('records the mint against the calling uid', async () => {
    configureAll();
    const handler = await loadHandler();
    await handler(adminReq());
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'info',
        function: 'mintVoiceAccessToken',
        event: 'mintVoiceAccessToken.minted',
        uid: 'admin-uid-1',
        extra: expect.objectContaining({ identity: 'auntie', hasPushCredential: true }),
      }),
    );
  });

  it('reports hasPushCredential false when it is absent, so a log line explains a silent phone', async () => {
    configureAll();
    delete process.env.PUSH_CREDENTIAL_SID;
    const handler = await loadHandler();
    await handler(adminReq());
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ hasPushCredential: false }) }),
    );
  });
});

describe('mintVoiceAccessToken — deployment wiring', () => {
  it('declares every secret it reads, so the release preflight can catch an unset one', async () => {
    configureAll();
    const mod = await import('../src/admin/mintVoiceAccessToken');
    const declared = (
      mod.mintVoiceAccessToken as unknown as {
        __endpoint?: { secretEnvironmentVariables?: Array<{ key: string }> };
      }
    ).__endpoint?.secretEnvironmentVariables?.map((s) => s.key);
    for (const name of SECRET_ENV) {
      expect(declared).toContain(name);
    }
  });

  it('does NOT bind AUNTIE_OPERATOR_UIDS, keeping the admin claim the sole gate', async () => {
    // isStaff accepts the claim OR the env allowlist, and an unbound secret
    // reads as undefined with no error. Leaving it out narrows the gate on the
    // one function that hands out the ability to answer the business phone.
    configureAll();
    const mod = await import('../src/admin/mintVoiceAccessToken');
    const declared = (
      mod.mintVoiceAccessToken as unknown as {
        __endpoint?: { secretEnvironmentVariables?: Array<{ key: string }> };
      }
    ).__endpoint?.secretEnvironmentVariables?.map((s) => s.key);
    expect(declared).not.toContain('AUNTIE_OPERATOR_UIDS');
  });
});
