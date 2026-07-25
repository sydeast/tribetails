import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getToken: vi.fn(),
  calendarListGet: vi.fn(),
  logEventFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        getToken = mocks.getToken;
        revokeToken = vi.fn();
      },
    },
    calendar: () => ({ calendarList: { get: mocks.calendarListGet } }),
  },
}));

import {
  startGoogleCalendarConnectHandler,
  googleOAuthCallbackHandler,
  redeemOAuthState,
  callbackPage,
} from '../src/admin/googleCalendar/googleCalendarConnect';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

const ORIGINAL_ENV = { ...process.env };

function req(data: unknown = {}, uid: string | undefined = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as never) : undefined,
    rawRequest: {} as never,
  } as unknown as CallableRequest<unknown>;
}

/** Minimal express response double: records what the callback page said. */
function res() {
  const sent: { status: number; body: string } = { status: 0, body: '' };
  const r = {
    status(code: number) {
      sent.status = code;
      return r;
    },
    send(body: string) {
      sent.body = body;
      return r;
    },
    headersSent: false,
  };
  return { r: r as never, sent };
}

function httpReq(query: Record<string, string>, method = 'GET') {
  return { method, query, headers: {} } as never;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getToken.mockReset();
  mocks.calendarListGet.mockReset();
  mocks.logEventFn.mockReset();
  (writeAuditEntry as unknown as { mockClear: () => void }).mockClear();
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-for-test';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-for-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('startGoogleCalendarConnect', () => {
  it('mints a one-time state against the admin uid and hands back a consent URL', async () => {
    const { db, writes } = buildDbMock();
    mocks.dbFn.mockReturnValue(db);

    const result = await startGoogleCalendarConnectHandler(req());

    const stateWrite = writes.find((w) => w.path.startsWith('google_oauth_states/'));
    expect(stateWrite).toBeDefined();
    expect(stateWrite?.data.uid).toBe('admin1');
    const state = stateWrite?.path.split('/')[1] ?? '';
    // 32 random bytes as hex. Guessing one inside its 15 minute life is the
    // attack this length exists to price out.
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(new URL(result.authUrl).searchParams.get('state')).toBe(state);
    expect(result.redirectUri).toBe(
      'https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback',
    );
  });

  it('refuses before minting anything when the secrets are not set', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const { db, writes } = buildDbMock();
    mocks.dbFn.mockReturnValue(db);

    await expect(startGoogleCalendarConnectHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'google_oauth_not_configured' },
    });
    // Nothing written: a state nonce for a flow that cannot start is litter.
    expect(writes).toHaveLength(0);
  });
});

describe('redeemOAuthState', () => {
  const future = '2026-07-25T12:00:00.000Z';
  const nowMs = Date.parse('2026-07-25T11:50:00.000Z');

  it('returns the uid once and deletes the nonce', async () => {
    const { db, deletes } = buildDbMock({
      docs: { 'google_oauth_states/abc': { uid: 'admin1', expiresAt: future } },
    });
    expect(await redeemOAuthState(db, 'abc', nowMs)).toBe('admin1');
    expect(deletes).toContain('google_oauth_states/abc');
  });

  it('refuses an unknown nonce', async () => {
    const { db } = buildDbMock({ docs: {} });
    expect(await redeemOAuthState(db, 'nope', nowMs)).toBeNull();
  });

  it('refuses an expired nonce, and still deletes it', async () => {
    const { db, deletes } = buildDbMock({
      docs: { 'google_oauth_states/old': { uid: 'admin1', expiresAt: '2026-07-25T10:00:00.000Z' } },
    });
    expect(await redeemOAuthState(db, 'old', nowMs)).toBeNull();
    expect(deletes).toContain('google_oauth_states/old');
  });
});

describe('googleOAuthCallback', () => {
  it('exchanges the code, stores the token server-side, and never echoes either', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'google_oauth_states/state1': { uid: 'admin1', expiresAt: '2099-01-01T00:00:00.000Z' } },
    });
    mocks.dbFn.mockReturnValue(db);
    mocks.getToken.mockResolvedValue({
      tokens: { refresh_token: '1//refresh-token-value', scope: 'https://www.googleapis.com/auth/calendar.events' },
    });
    mocks.calendarListGet.mockResolvedValue({ data: { id: 'auntie@tribetails.com' } });

    const { r, sent } = res();
    await googleOAuthCallbackHandler(httpReq({ state: 'state1', code: 'auth-code-abc' }), r);

    expect(sent.status).toBe(200);
    // The page sits in browser history and in any referrer it emits.
    expect(sent.body).not.toContain('auth-code-abc');
    expect(sent.body).not.toContain('refresh-token-value');
    expect(sent.body).not.toContain('state1');

    const connWrite = writes.find((w) => w.path === 'integrations_config/googleCalendar');
    expect(connWrite?.data).toMatchObject({
      connected: true,
      refreshToken: '1//refresh-token-value',
      googleAccountEmail: 'auntie@tribetails.com',
      connectedByUid: 'admin1',
      connectLastStatus: 'ok',
      disconnectedAt: '',
    });
    expect(connWrite?.merge).toBe(true);
  });

  it('never puts the token in the audit entry', async () => {
    const { db } = buildDbMock({
      docs: { 'google_oauth_states/state1': { uid: 'admin1', expiresAt: '2099-01-01T00:00:00.000Z' } },
    });
    mocks.dbFn.mockReturnValue(db);
    mocks.getToken.mockResolvedValue({ tokens: { refresh_token: '1//refresh-token-value', scope: '' } });
    mocks.calendarListGet.mockResolvedValue({ data: { id: 'auntie@tribetails.com' } });

    const { r } = res();
    await googleOAuthCallbackHandler(httpReq({ state: 'state1', code: 'code' }), r);

    // An audit entry is readable by any Auntie, which is exactly who must not be
    // handed a standing credential.
    const entry = JSON.stringify((writeAuditEntry as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]);
    expect(entry).not.toContain('refresh-token-value');
    expect(entry).toContain('auntie@tribetails.com');
  });

  it('refuses an unknown or spent state before exchanging anything', async () => {
    const { db, writes } = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(db);

    const { r, sent } = res();
    await googleOAuthCallbackHandler(httpReq({ state: 'forged', code: 'code' }), r);

    expect(sent.status).toBe(400);
    expect(sent.body).toContain('no longer valid');
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('stamps a receipt when the operator declines on the Google screen', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'google_oauth_states/state1': { uid: 'admin1', expiresAt: '2099-01-01T00:00:00.000Z' } },
    });
    mocks.dbFn.mockReturnValue(db);

    const { r, sent } = res();
    await googleOAuthCallbackHandler(httpReq({ state: 'state1', error: 'access_denied' }), r);

    expect(sent.status).toBe(400);
    // Without the stamp, a declined consent and a callback that never ran look
    // identical from the panel: still not connected, no reason given.
    const stamp = writes.find((w) => w.path === 'integrations_config/googleCalendar');
    expect(stamp?.data).toMatchObject({ connectLastStatus: 'error' });
    expect(String(stamp?.data.connectLastError)).toContain('declined');
    expect(stamp?.merge).toBe(true);
  });

  it('stamps a receipt when Google returns no refresh token', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'google_oauth_states/state1': { uid: 'admin1', expiresAt: '2099-01-01T00:00:00.000Z' } },
    });
    mocks.dbFn.mockReturnValue(db);
    // Google withholds one when the grant already exists. Storing only the
    // access token would leave a connection that works for an hour.
    mocks.getToken.mockResolvedValue({ tokens: { access_token: 'short-lived' } });

    const { r, sent } = res();
    await googleOAuthCallbackHandler(httpReq({ state: 'state1', code: 'code' }), r);

    expect(sent.status).toBe(400);
    expect(sent.body).toContain('myaccount.google.com/permissions');
    const stamp = writes.find((w) => w.path === 'integrations_config/googleCalendar');
    expect(stamp?.data).toMatchObject({ connectLastStatus: 'error' });
    expect(stamp?.data.connected).toBeUndefined();
  });

  it('answers anything other than a GET without touching the flow', async () => {
    const { db } = buildDbMock();
    mocks.dbFn.mockReturnValue(db);
    const { r, sent } = res();
    await googleOAuthCallbackHandler(httpReq({}, 'POST'), r);
    expect(sent.status).toBe(405);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
});

describe('callbackPage', () => {
  it('escapes what it prints, so a Google error string cannot become markup', () => {
    const page = callbackPage('Not connected', '<img src=x onerror="alert(1)">');
    expect(page).not.toContain('<img');
    expect(page).toContain('&lt;img');
  });
});
