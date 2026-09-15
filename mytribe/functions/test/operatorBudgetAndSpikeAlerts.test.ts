import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #891: two operator signals the failed-login lock could not give on its own.
 *
 * 1. REPORT BUDGET. `recordFailedLogin` accepts 15 reports per email per 24
 *    hours. Fifteen slow reports (under 5 per 10 minutes) spend that budget
 *    without ever warning, and the owner's real failures are then refused for a
 *    day: no warning, no lock. When a real account's budget is spent, the
 *    operator is now told, once per 24 hours per account.
 * 2. LOCK SPIKE. Every lock already alerts the operator, one household at a
 *    time. When 3 or more distinct accounts lock inside 30 minutes, the
 *    operator now also gets one alert for the whole spike.
 *
 * Drives the REAL handler through the REAL dispatcher and business admin
 * resolver on one write-through mock, like operatorFailedLoginWarning.test.ts.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUserByEmail: vi.fn(),
  failOnce: new Set<string>(),
  enqueueCalls: [] as string[],
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ getUserByEmail: mocks.getUserByEmail }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn(async () => 'audit-1') }));
vi.mock('../src/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/notifications')>();
  return {
    ...actual,
    enqueueNotification: async (args: Parameters<typeof actual.enqueueNotification>[0]) => {
      mocks.enqueueCalls.push(args.key);
      if (mocks.failOnce.has(args.key)) {
        mocks.failOnce.delete(args.key);
        throw new Error(`injected ${args.key} failure`);
      }
      return actual.enqueueNotification(args);
    },
  };
});

import {
  recordFailedLoginHandler,
  reportBudgetAlertDedupeKey,
  lockSpikeAlertDedupeKey,
  LOCK_SPIKE_ACCOUNTS,
  LOCK_SPIKE_WINDOW_MS,
} from '../src/auth/loginSecurity';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';

const BUDGET_KEY = 'security.failedLogin.budgetExhausted.operator';
const SPIKE_KEY = 'security.account.locked.spike.operator';
const LOCK_KEY = 'security.account.locked.operator';
const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const KIN_EMAIL = 'pat@household.test';

type Write = { path: string; data: Record<string, unknown> };

const ACCOUNTS: Record<string, string> = {
  'pat@household.test': 'kin1',
  'sam@household.test': 'kin2',
  'lee@household.test': 'kin3',
  'max@household.test': 'kin4',
  'ana@household.test': 'kin5',
  'bo@household.test': 'kin6',
  'cy@household.test': 'kin7',
};

function baseDocs() {
  const docs: Record<string, Record<string, unknown>> = {
    'businessSettings/admins': { uids: ['op1'] },
    'staff/op1': { email: 'owner@tribetails.test' },
  };
  for (const [email, uid] of Object.entries(ACCOUNTS)) {
    docs[`clients/${uid}`] = { email, displayName: uid, kinfolkIds: [`fam-${uid}`] };
    docs[`families/fam-${uid}`] = { displayName: `Household ${uid}` };
  }
  return docs;
}

let ipCounter = 0;
/** One report from a different real client each time, so the per-IP limit never interferes. */
function report(email: string, atMs: number) {
  vi.setSystemTime(atMs);
  ipCounter += 1;
  return recordFailedLoginHandler(
    // Public addresses: since #908 a private entry at the trusted hop is refused
    // as untrusted, and every such call would share one bucket.
    callableRequest({ email }, { headers: { 'x-forwarded-for': `203.0.${113 + ((ipCounter >> 8) & 3)}.${ipCounter & 255}` } }),
  );
}

async function refusal(email: string, atMs: number): Promise<HttpsError> {
  const err = await report(email, atMs).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'this report should be refused').toBeInstanceOf(HttpsError);
  return err as HttpsError;
}

/** 15 reports 3 minutes apart: at most 4 in any 10 minutes, 7 in any 20. Never warns, never locks. */
async function slowReports(email: string, startMs: number): Promise<number> {
  for (let i = 0; i < 15; i += 1) await report(email, startMs + i * 3 * 60_000);
  return startMs + 15 * 3 * 60_000;
}

/** 10 reports a second apart: locks the account. */
async function lock(email: string, startMs: number): Promise<void> {
  for (let i = 0; i < 10; i += 1) await report(email, startMs + i * 1000);
}

function copies(writes: Write[], key: string): Write[] {
  return writes.filter((w) => w.path.startsWith('notifications/') && w.data.key === key && w.data.recipientUid === 'op1');
}

function dataOf(w: Write): Record<string, unknown> {
  return w.data.data as Record<string, unknown>;
}

let ctx: ReturnType<typeof buildDbMock>;
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUserByEmail.mockReset();
  mocks.getUserByEmail.mockImplementation(async (email: string) => {
    const uid = ACCOUNTS[email.toLowerCase()];
    if (!uid) throw new Error('auth/user-not-found');
    return { uid };
  });
  mocks.failOnce.clear();
  mocks.enqueueCalls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
  mocks.dbFn.mockReturnValue(ctx.db);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#891 catalog: both new signals are business security rows, shaped like the lock alert', () => {
  for (const key of [BUDGET_KEY, SPIKE_KEY]) {
    it(`${key}`, () => {
      const def = NOTIFICATION_CATALOG[key]!;
      const lockDef = NOTIFICATION_CATALOG[LOCK_KEY]!;
      expect(def).toBeTruthy();
      expect(def.audience).toBe('business');
      expect(def.audiences).toEqual({ business: true });
      expect(def.category).toBe('security');
      expect(def.recipientResolver).toBe('businessAdmins');
      expect(def.secondaryResolver).toBeUndefined();
      expect(def.allowedChannels).toEqual(lockDef.allowedChannels);
      expect(def.required).toEqual(lockDef.required);
      expect(def.alwaysEnabled).toBe(true);
      expect(def.kinfolkFacing).toBe(false);
      expect(def.templates).toEqual({ email: key, sms: key, push: key });
    });
  }
});

describe('#891 report budget: the operator hears when an account can no longer warn or lock', () => {
  it('15 slow reports send no warning; the refused 16th alerts the operator once and keeps its answer', async () => {
    const after = await slowReports(KIN_EMAIL, NOW);
    const writes = ctx.writes as Write[];
    expect(mocks.enqueueCalls, 'slow reports never warn or lock').toEqual([]);

    const err = await refusal(KIN_EMAIL, after);
    expect(err.code).toBe('resource-exhausted');
    expect(err.message).toBe('Too many failed login reports for this account. Try again later.');

    const alerts = copies(writes, BUDGET_KEY);
    expect(alerts).toHaveLength(1);
    expect(dataOf(alerts[0]!)).toEqual({
      kinfolkUid: 'kin1',
      kinfolkId: 'fam-kin1',
      kinfolkName: 'Household kin1',
      kinfolkEmail: KIN_EMAIL,
      reportLimit: 15,
      budgetExhaustedAtMs: after,
    });
  });

  it('later refusals inside the same 24 hours enqueue nothing more', async () => {
    const after = await slowReports(KIN_EMAIL, NOW);
    await refusal(KIN_EMAIL, after);
    mocks.enqueueCalls.length = 0;
    for (let i = 1; i <= 5; i += 1) await refusal(KIN_EMAIL, after + i * 60 * 60_000);
    expect(mocks.enqueueCalls).toEqual([]);
    expect(copies(ctx.writes as Write[], BUDGET_KEY)).toHaveLength(1);
  });

  it('the refused answer is byte-identical with and without an alert, for a real and an unknown email', async () => {
    const realAfter = await slowReports(KIN_EMAIL, NOW);
    const ghostAfter = await slowReports('ghost@household.test', NOW);
    const first = await refusal(KIN_EMAIL, realAfter);
    const second = await refusal(KIN_EMAIL, realAfter + 1000);
    const ghost = await refusal('ghost@household.test', ghostAfter);
    const shape = (e: HttpsError) => JSON.stringify(e.toJSON());
    expect(shape(first)).toBe(shape(second));
    expect(shape(first)).toBe(shape(ghost));
  });

  it('an address that is not an account alerts nobody', async () => {
    const after = await slowReports('ghost@household.test', NOW);
    await refusal('ghost@household.test', after);
    expect(copies(ctx.writes as Write[], BUDGET_KEY)).toEqual([]);
    expect(mocks.enqueueCalls).toEqual([]);
  });

  it('a failed alert is retried by the next refusal, for the same exhaustion, exactly once', async () => {
    const after = await slowReports(KIN_EMAIL, NOW);
    mocks.failOnce.add(BUDGET_KEY);
    await refusal(KIN_EMAIL, after);
    expect(copies(ctx.writes as Write[], BUDGET_KEY)).toHaveLength(0);

    await refusal(KIN_EMAIL, after + 60_000);
    await refusal(KIN_EMAIL, after + 120_000);
    const writes = ctx.writes as Write[];
    const alerts = copies(writes, BUDGET_KEY);
    expect(alerts).toHaveLength(1);
    expect(dataOf(alerts[0]!).budgetExhaustedAtMs).toBe(after);
    const ledger = writes.filter((w) => w.path.startsWith('notificationDedupe/') && w.data.key === BUDGET_KEY);
    expect(ledger.map((w) => w.data.identity)).toEqual([`key:${reportBudgetAlertDedupeKey('kin1', after)}`]);
  });

  it('a new exhaustion the next day alerts again', async () => {
    const after = await slowReports(KIN_EMAIL, NOW);
    await refusal(KIN_EMAIL, after);
    const nextDay = NOW + DAY_MS + 60 * 60_000;
    const after2 = await slowReports(KIN_EMAIL, nextDay);
    await refusal(KIN_EMAIL, after2);
    expect(copies(ctx.writes as Write[], BUDGET_KEY).map((w) => dataOf(w).budgetExhaustedAtMs)).toEqual([after, after2]);
  });

  it('the dedupe key names the account and the exhaustion', () => {
    expect(reportBudgetAlertDedupeKey('kin1', 1)).not.toEqual(reportBudgetAlertDedupeKey('kin2', 1));
    expect(reportBudgetAlertDedupeKey('kin1', 1)).not.toEqual(reportBudgetAlertDedupeKey('kin1', 2));
  });
});

describe('#891 lock spike: one alert when several accounts lock close together', () => {
  const emails = Object.keys(ACCOUNTS);

  it('uses the operator thresholds: 3 distinct accounts in 30 minutes', () => {
    expect(LOCK_SPIKE_ACCOUNTS).toBe(3);
    expect(LOCK_SPIKE_WINDOW_MS).toBe(30 * 60_000);
  });

  it('two locks send the usual lock alerts and no spike alert', async () => {
    await lock(emails[0]!, NOW);
    await lock(emails[1]!, NOW + 60_000);
    const writes = ctx.writes as Write[];
    expect(copies(writes, LOCK_KEY)).toHaveLength(2);
    expect(copies(writes, SPIKE_KEY)).toEqual([]);
  });

  it('the third distinct lock inside 30 minutes alerts once; a fourth does not alert again', async () => {
    await lock(emails[0]!, NOW);
    await lock(emails[1]!, NOW + 5 * 60_000);
    await lock(emails[2]!, NOW + 10 * 60_000);
    const third = NOW + 10 * 60_000 + 9000;
    await lock(emails[3]!, NOW + 15 * 60_000);

    const writes = ctx.writes as Write[];
    const spikes = copies(writes, SPIKE_KEY);
    expect(spikes).toHaveLength(1);
    expect(dataOf(spikes[0]!)).toEqual({ lockedAccounts: 3, windowMinutes: 30, spikeStartedAtMs: third });
    expect(copies(writes, LOCK_KEY), 'every lock still alerts on its own').toHaveLength(4);
  });

  it('locks spread wider than 30 minutes never add up to a spike', async () => {
    await lock(emails[0]!, NOW);
    await lock(emails[1]!, NOW + 20 * 60_000);
    await lock(emails[2]!, NOW + 41 * 60_000);
    expect(copies(ctx.writes as Write[], SPIKE_KEY)).toEqual([]);
  });

  it('a second spike after the window closes is a new alert', async () => {
    for (let i = 0; i < 3; i += 1) await lock(emails[i]!, NOW + i * 60_000);
    const later = NOW + 40 * 60_000;
    for (let i = 3; i < 6; i += 1) await lock(emails[i]!, later + (i - 3) * 60_000);
    expect(copies(ctx.writes as Write[], SPIKE_KEY)).toHaveLength(2);
  });

  it('a spike alert that fails is retried by the next lock in the window, exactly once', async () => {
    for (let i = 0; i < 2; i += 1) await lock(emails[i]!, NOW + i * 60_000);
    mocks.failOnce.add(SPIKE_KEY);
    await lock(emails[2]!, NOW + 2 * 60_000);
    expect(copies(ctx.writes as Write[], SPIKE_KEY)).toHaveLength(0);
    await lock(emails[3]!, NOW + 3 * 60_000);
    await lock(emails[4]!, NOW + 4 * 60_000);
    const writes = ctx.writes as Write[];
    const spikes = copies(writes, SPIKE_KEY);
    expect(spikes).toHaveLength(1);
    expect(dataOf(spikes[0]!).spikeStartedAtMs).toBe(NOW + 2 * 60_000 + 9000);
    const ledger = writes.filter((w) => w.path.startsWith('notificationDedupe/') && w.data.key === SPIKE_KEY);
    expect(ledger.map((w) => w.data.identity)).toEqual([`key:${lockSpikeAlertDedupeKey(NOW + 2 * 60_000 + 9000)}`]);
  });

  it('writes no undefined field to the spike record', async () => {
    for (let i = 0; i < 3; i += 1) await lock(emails[i]!, NOW + i * 60_000);
    const hasUndefined = (v: unknown): boolean =>
      v === undefined ||
      (Array.isArray(v) ? v.some(hasUndefined) : v !== null && typeof v === 'object' && Object.values(v).some(hasUndefined));
    const spikeWrites = (ctx.writes as Write[]).filter((w) => w.path.startsWith('securitySignals/'));
    expect(spikeWrites.length).toBeGreaterThan(0);
    expect(spikeWrites.filter((w) => hasUndefined(w.data)).map((w) => w.path)).toEqual([]);
  });

  it('every call on the way answers { ok: true }', async () => {
    const bodies = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 10; j += 1) bodies.add(JSON.stringify(await report(emails[i]!, NOW + i * 60_000 + j * 1000)));
    }
    expect([...bodies]).toEqual(['{"ok":true}']);
  });
});
