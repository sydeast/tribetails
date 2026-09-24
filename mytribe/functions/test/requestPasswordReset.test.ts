import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #905: the server sends password reset emails itself.
 *
 * The callable writes one `passwordResetRequests` doc and answers `{ ok: true }`
 * without looking the address up. The trigger body does the lookup, the budget,
 * the link and the send, straight to smtp2go with the `auth.password.reset`
 * template, never through the notifications pipeline.
 *
 * Real handler, real template loader and real `checkIpRateLimit` on one
 * write-through db mock. Only Firebase Auth, the transport, the logger and the
 * audit writer are faked.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUserByEmail: vi.fn(),
  generatePasswordResetLink: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  enqueueNotification: vi.fn(),
  writeAuditEntry: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({
    getUserByEmail: mocks.getUserByEmail,
    generatePasswordResetLink: mocks.generatePasswordResetLink,
  }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/notifications', () => ({ enqueueNotification: mocks.enqueueNotification }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueueNotification }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));

import {
  requestPasswordResetHandler,
  processPasswordResetRequest,
  handlePasswordResetRequestDoc,
  PASSWORD_RESET_REQUESTS,
} from '../src/auth/requestPasswordReset';

const KIN_EMAIL = 'pat@household.test';
const GHOST_EMAIL = 'nobody@household.test';
const LINK = 'https://kinfolk.tribetails.com/account/secure-reset?mode=resetPassword&oobCode=abc';
const NET = '203.0.113.9';

const users: Record<string, Record<string, unknown>> = {
  [KIN_EMAIL]: { uid: 'kin1', email: KIN_EMAIL, displayName: 'Pat Doe' },
  'owner@tribetails.test': { uid: 'op1', email: 'owner@tribetails.test', customClaims: { admin: true } },
  'auntie@tribetails.test': { uid: 'au1', email: 'auntie@tribetails.test', customClaims: { staffRole: 'auntie' } },
};

let ctx: ReturnType<typeof buildDbMock>;
function setup(docs: Record<string, Record<string, unknown>> = {}) {
  ctx = buildDbMock({ writeThrough: true, docs });
  mocks.dbFn.mockReturnValue(ctx.db);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUNTIE_OPERATOR_UIDS', '');
  mocks.getUserByEmail.mockImplementation(async (email: string) => {
    const u = users[email];
    if (!u) throw new Error('auth/user-not-found');
    return u;
  });
  mocks.generatePasswordResetLink.mockResolvedValue(LINK);
  mocks.sendTemplatedEmail.mockResolvedValue('email-1');
  mocks.writeAuditEntry.mockResolvedValue('audit-1');
  setup();
});
afterEach(() => vi.unstubAllEnvs());

function call(email: unknown) {
  return requestPasswordResetHandler(callableRequest({ email }, { headers: { 'x-forwarded-for': NET } }));
}

function requestDocs() {
  return ctx.adds.filter((a) => a.collection === PASSWORD_RESET_REQUESTS);
}

describe('the callable', () => {
  it('writes one request doc and answers { ok: true }, without looking the address up', async () => {
    await expect(call('Pat@Household.test')).resolves.toEqual({ ok: true });
    expect(requestDocs()).toHaveLength(1);
    expect(requestDocs()[0]!.data).toMatchObject({ email: KIN_EMAIL, networkKey: NET, ip: NET });
    expect(mocks.getUserByEmail).not.toHaveBeenCalled();
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it('does the same work for an address that is not an account', async () => {
    await call(KIN_EMAIL);
    await call(GHOST_EMAIL);
    const [a, b] = requestDocs().map((x) => Object.keys(x.data).sort());
    expect(a).toEqual(b);
  });

  it('refuses a missing or malformed email', async () => {
    await expect(call('not-an-email')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(call(undefined)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(requestDocs()).toHaveLength(0);
  });
});

describe('sending', () => {
  it('sends the reset to the account address, with the link, outside the notifications pipeline', async () => {
    await processPasswordResetRequest({ email: KIN_EMAIL, networkKey: NET });
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    const args = mocks.sendTemplatedEmail.mock.calls[0]![0];
    expect(args.to).toBe(KIN_EMAIL);
    expect(args.data).toEqual({ link: LINK, email: KIN_EMAIL, displayName: 'Pat Doe' });
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
    // No notification doc is written, so the link is stored nowhere.
    expect(ctx.writes.some((w: { path: string }) => w.path.startsWith('notification'))).toBe(false);
  });

  it('sends nothing for an address that is not an account', async () => {
    await processPasswordResetRequest({ email: GHOST_EMAIL, networkKey: NET });
    expect(mocks.generatePasswordResetLink).not.toHaveBeenCalled();
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it('points a household at the portal sign-in and staff at the admin sign-in', async () => {
    await processPasswordResetRequest({ email: KIN_EMAIL, networkKey: NET });
    await processPasswordResetRequest({ email: 'owner@tribetails.test', networkKey: NET });
    await processPasswordResetRequest({ email: 'auntie@tribetails.test', networkKey: NET });
    expect(mocks.generatePasswordResetLink.mock.calls.map(([, s]) => s.url)).toEqual([
      'https://kinfolk.tribetails.com/signin',
      'https://auntie.tribetails.com/signin',
      'https://auntie.tribetails.com/signin',
    ]);
  });

  it("uses the operator's stored template when there is one", async () => {
    setup({
      'emailTemplates/auth.password.reset': { subject: 'Mine', body: 'Go: {{link}}', html: '<a href="{{link}}">Go</a>' },
    });
    await processPasswordResetRequest({ email: KIN_EMAIL, networkKey: NET });
    expect(mocks.sendTemplatedEmail.mock.calls[0]![0]).toMatchObject({
      subjectTemplate: 'Mine',
      bodyTemplate: 'Go: {{link}}',
      htmlTemplate: '<a href="{{link}}">Go</a>',
    });
  });

  it('falls back to the repo copy, link included, when none is stored', async () => {
    await processPasswordResetRequest({ email: KIN_EMAIL, networkKey: NET });
    const args = mocks.sendTemplatedEmail.mock.calls[0]![0];
    expect(args.subjectTemplate).toBe('Reset your Tribe Tails password');
    expect(args.bodyTemplate).toContain('{{link}}');
    expect(args.htmlTemplate).toContain('{{link}}');
  });

  it('writes an audit row for a sent reset', async () => {
    await processPasswordResetRequest({ email: KIN_EMAIL, networkKey: NET });
    expect(mocks.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'AUTH_PASSWORD_RESET_REQUESTED', actorUid: 'kin1' }),
    );
  });
});

describe('the trigger body', () => {
  it('deletes the request doc before doing anything else, even for an unknown address', async () => {
    const order: string[] = [];
    mocks.getUserByEmail.mockImplementationOnce(async () => {
      order.push('lookup');
      throw new Error('auth/user-not-found');
    });
    await handlePasswordResetRequestDoc({
      data: () => ({ email: GHOST_EMAIL, networkKey: NET }),
      ref: { delete: async () => void order.push('delete') },
    });
    expect(order).toEqual(['delete', 'lookup']);
  });

  it('ignores a malformed doc after deleting it', async () => {
    const del = vi.fn(async () => undefined);
    await handlePasswordResetRequestDoc({ data: () => ({ email: 42 }), ref: { delete: del } });
    expect(del).toHaveBeenCalled();
    expect(mocks.getUserByEmail).not.toHaveBeenCalled();
  });
});
