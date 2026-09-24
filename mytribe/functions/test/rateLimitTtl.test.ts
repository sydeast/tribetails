import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #908 review: the failed-login and reset rate-limit ledgers get a Firestore TTL.
 *
 * Every write to `ipRateLimits`, `failedLoginEmailRateLimits`,
 * `unknownLoginAttempts` and `passwordResetEmailRateLimits` carries `expiresAt`,
 * the end of the longest window that doc is read over plus one hour, and
 * `firestore.indexes.json` declares a TTL policy on each, next to
 * `notificationDedupe.expiresAt`. Nothing reads `expiresAt` to decide a limit:
 * the windows filter on their own timestamps, so a doc the TTL has not reached
 * yet can never refuse a call it should allow.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), getUserByEmail: vi.fn(), generateLink: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ getUserByEmail: mocks.getUserByEmail, generatePasswordResetLink: mocks.generateLink }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/notifications', () => ({ enqueueNotification: vi.fn(async () => ['n1']) }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: vi.fn(async () => 'email-1') }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn(async () => 'audit-1') }));

import { recordFailedLoginHandler } from '../src/auth/loginSecurity';
import { processPasswordResetRequest } from '../src/auth/requestPasswordReset';

const NOW = Date.UTC(2026, 8, 14, 21, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const TTL_COLLECTIONS = [
  'ipRateLimits',
  'failedLoginEmailRateLimits',
  'unknownLoginAttempts',
  'passwordResetEmailRateLimits',
  'passwordResetRequests',
];

type Write = { path: string; data: Record<string, unknown> };

let ctx: ReturnType<typeof buildDbMock>;
beforeEach(() => {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      'clients/kin1': { email: 'pat@household.test' },
      'businessSettings/admins': { uids: ['op1'] },
      'staff/op1': { email: 'owner@tribetails.test' },
    },
  });
  mocks.dbFn.mockReset();
  mocks.dbFn.mockReturnValue(ctx.db);
  mocks.getUserByEmail.mockReset();
  mocks.getUserByEmail.mockImplementation(async (email: string) => {
    if (email === 'pat@household.test') return { uid: 'kin1', email };
    throw new Error('auth/user-not-found');
  });
  mocks.generateLink.mockReset();
  mocks.generateLink.mockResolvedValue('https://example.test/reset');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

let ipSeq = 0;
const req = (email: string) =>
  callableRequest({ email }, { headers: { 'x-forwarded-for': `203.0.113.${(ipSeq++ % 250) + 1}` } });

function writesTo(collection: string): Write[] {
  return (ctx.writes as Write[]).filter((w) => w.path.startsWith(`${collection}/`));
}

function expiresAtMillis(w: Write): number {
  const v = w.data['expiresAt'];
  expect(v, `${w.path} carries expiresAt`).toBeInstanceOf(Timestamp);
  return (v as Timestamp).toMillis();
}

describe('#908 firestore.indexes.json declares a TTL on every rate-limit ledger', () => {
  const indexes = JSON.parse(readFileSync(resolve(__dirname, '../../firestore.indexes.json'), 'utf8')) as {
    fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; ttl?: boolean; indexes: unknown[] }>;
  };
  for (const collection of [...TTL_COLLECTIONS, 'notificationDedupe']) {
    it(collection, () => {
      const override = indexes.fieldOverrides.find((o) => o.collectionGroup === collection && o.fieldPath === 'expiresAt');
      expect(override).toEqual({ collectionGroup: collection, fieldPath: 'expiresAt', ttl: true, indexes: [] });
    });
  }
});

describe('#908 every rate-limit write sets expiresAt', () => {
  it('recordFailedLogin: ipRateLimits (5 minutes + 1 hour) and failedLoginEmailRateLimits (24 hours + 1 hour)', async () => {
    await recordFailedLoginHandler(req('pat@household.test'));
    expect(writesTo('ipRateLimits').map(expiresAtMillis)).toEqual([NOW + 5 * 60_000 + HOUR]);
    expect(writesTo('failedLoginEmailRateLimits').map(expiresAtMillis)).toEqual([NOW + DAY + HOUR]);
  });

  it('the budget refusal write carries it too', async () => {
    for (let i = 0; i < 15; i += 1) {
      vi.setSystemTime(NOW + i * 3 * 60_000);
      await recordFailedLoginHandler(req('pat@household.test'));
    }
    const refusedAt = NOW + 15 * 3 * 60_000;
    vi.setSystemTime(refusedAt);
    await expect(recordFailedLoginHandler(req('pat@household.test'))).rejects.toMatchObject({ code: 'resource-exhausted' });
    // The refusal's own write, not the pending-marker clear that follows the alert.
    const refusal = writesTo('failedLoginEmailRateLimits').filter((w) => w.data['budgetExhaustedAtMs'] === refusedAt);
    expect(refusal).toHaveLength(1);
    expect(expiresAtMillis(refusal[0]!)).toBe(refusedAt + DAY + HOUR);
  });

  it('an address that is not an account: unknownLoginAttempts (24 hours + 1 hour)', async () => {
    await recordFailedLoginHandler(req('ghost@household.test'));
    expect(writesTo('unknownLoginAttempts').map(expiresAtMillis)).toEqual([NOW + DAY + HOUR]);
  });

  it('requestPasswordReset, unlocked: passwordResetEmailRateLimits (24 hours + 1 hour)', async () => {
    await processPasswordResetRequest({ email: 'pat@household.test', networkKey: '203.0.113.9' });
    expect(writesTo('passwordResetEmailRateLimits').map(expiresAtMillis)).toEqual([NOW + DAY + HOUR]);
  });

  it('requestPasswordReset, locked: the lock-window write keeps the daily timestamps alive as long', async () => {
    await ctx.db
      .doc('clients/kin1/security/loginAttempts')
      .set({ attempts: [], lockStartedAtMs: NOW - 60_000, lockedUntilMs: NOW + 29 * 60_000 });
    await processPasswordResetRequest({ email: 'pat@household.test', networkKey: '203.0.113.9' });
    const w = writesTo('passwordResetEmailRateLimits');
    expect(w.map((x) => x.data['lockWindowCount'])).toEqual([1]);
    expect(w.map(expiresAtMillis)).toEqual([NOW + DAY + HOUR]);
  });
});
