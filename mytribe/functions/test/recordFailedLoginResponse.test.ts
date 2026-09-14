import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #886: `recordFailedLogin` is unauthenticated, so its answer must not tell a
 * stranger anything about an account.
 *
 * On main it did. An unknown email came back `remainingBeforeLock: 10`, a real
 * account counted down 9, 8, 7, and a locked one returned `lockedUntilMs`, the
 * exact moment it would open again. These tests drive the REAL handler through
 * the REAL dispatcher on one write-through mock, the same harness
 * operatorLockAlert.test.ts uses, and hold four things:
 *
 *  1. the response is `{ ok: true }` for a real account and an unknown email,
 *     on every call, including the ones that warn, lock and fail to alert;
 *  2. the counting still happens: warning at 5, lock at 10, operator alert;
 *  3. an unknown email does the same shape of work (one attempts transaction)
 *     and writes nothing under `clients/`;
 *  4. the per-IP and per-email rate limits still refuse, identically for both.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUserByEmail: vi.fn(),
  enqueueCalls: [] as string[],
  failOnce: new Set<string>(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ getUserByEmail: mocks.getUserByEmail }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
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
  RecordFailedLoginArgs,
  RecordFailedLoginResult,
  recordFailedLoginHandler,
} from '../src/auth/loginSecurity';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const LOCK_MS = 30 * 60 * 1000;
const KIN_EMAIL = 'pat@household.test';
const STRANGER_EMAIL = 'nobody@household.test';
const SECURITY_DOC = 'clients/kin1/security/loginAttempts';
const OPERATOR_KEY = 'security.account.locked.operator';
const WARN_KEY = 'auth.failedLogin.attempts';

type Write = { path: string; data: Record<string, unknown> };

function baseDocs(): Record<string, Record<string, unknown> | null> {
  return {
    'businessSettings/admins': { uids: ['op1'] },
    'staff/op1': { email: 'owner@tribetails.test' },
    'clients/kin1': { email: KIN_EMAIL, displayName: 'Pat', kinfolkIds: ['fam1'] },
    'families/fam1': { displayName: 'The Rivera household' },
  };
}

/** Real account for KIN_EMAIL, no account for anything else. */
function accountsAreJustPat(): void {
  mocks.getUserByEmail.mockImplementation(async (email: string) => {
    if (email === KIN_EMAIL) return { uid: 'kin1' };
    throw Object.assign(new Error('There is no user record'), { code: 'auth/user-not-found' });
  });
}

function report(email: string, atMs: number, ip = '203.0.113.7') {
  vi.setSystemTime(atMs);
  return recordFailedLoginHandler(callableRequest({ email }, { ip }));
}

async function setup() {
  const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

async function stored(ctx: ReturnType<typeof buildDbMock>, path: string): Promise<Record<string, unknown>> {
  return ((await ctx.db.doc(path).get()).data() ?? {}) as Record<string, unknown>;
}

let originalEnv: string | undefined;
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUserByEmail.mockReset();
  mocks.enqueueCalls.length = 0;
  mocks.failOnce.clear();
  mocks.logEvent.mockReset();
  accountsAreJustPat();
  originalEnv = process.env.AUNTIE_OPERATOR_UIDS;
  process.env.AUNTIE_OPERATOR_UIDS = 'op1';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  if (originalEnv === undefined) delete process.env.AUNTIE_OPERATOR_UIDS;
  else process.env.AUNTIE_OPERATOR_UIDS = originalEnv;
});

describe('#886 recordFailedLogin answers the same for every caller', () => {
  it('a real account and an unknown email get byte-identical responses', async () => {
    await setup();
    const known = await report(KIN_EMAIL, NOW);
    const unknown = await report(STRANGER_EMAIL, NOW + 1000);

    expect(known).toEqual({ ok: true });
    expect(unknown).toEqual({ ok: true });
    expect(JSON.stringify(known)).toBe(JSON.stringify(unknown));
    // The published schema is strict: an added field is a contract change.
    expect(RecordFailedLoginResult.safeParse(known).success).toBe(true);
    expect(RecordFailedLoginResult.safeParse({ ok: true, remainingBeforeLock: 9 }).success).toBe(false);
  });

  it('every call on the way to a lock, and after it, answers { ok: true } with no count or lock time', async () => {
    const ctx = await setup();
    const answers: unknown[] = [];
    for (let i = 0; i < 12; i += 1) answers.push(await report(KIN_EMAIL, NOW + i * 1000));

    expect(answers).toEqual(Array.from({ length: 12 }, () => ({ ok: true })));
    // The lock really did happen; it just is not in the response.
    expect((await stored(ctx, SECURITY_DOC)).lockedUntilMs).toBe(NOW + 9000 + LOCK_MS);
  });

  it('the same sequence against an unknown email reads exactly like the real one', async () => {
    await setup();
    const real: unknown[] = [];
    const stranger: unknown[] = [];
    for (let i = 0; i < 11; i += 1) {
      real.push(await report(KIN_EMAIL, NOW + i * 1000));
      stranger.push(await report(STRANGER_EMAIL, NOW + i * 1000 + 500));
    }
    expect(stranger).toEqual(real);
  });

  it('a household alert that fails still answers { ok: true }, keeps the lock and logs the failure', async () => {
    const ctx = await setup();
    for (let i = 0; i < 9; i += 1) await report(KIN_EMAIL, NOW + i * 1000);

    mocks.failOnce.add('auth.account.locked');
    await expect(report(KIN_EMAIL, NOW + 9000)).resolves.toEqual({ ok: true });

    const lock = await stored(ctx, SECURITY_DOC);
    expect(lock.lockedUntilMs).toBe(NOW + 9000 + LOCK_MS);
    expect(lock.lockAlertsPendingForMs, 'retry marker kept for the next failed login').toBe(NOW + 9000);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', event: 'recordFailedLogin.failed' }),
    );
  });
});

describe('#886 the counting behind the constant answer is unchanged', () => {
  it('warns the household on the 5th failure and not before', async () => {
    await setup();
    for (let i = 0; i < 4; i += 1) await report(KIN_EMAIL, NOW + i * 1000);
    expect(mocks.enqueueCalls).not.toContain(WARN_KEY);

    await report(KIN_EMAIL, NOW + 4000);
    expect(mocks.enqueueCalls.filter((k) => k === WARN_KEY)).toHaveLength(1);
  });

  it('locks on the 10th failure in 20 minutes and not on the 9th', async () => {
    const ctx = await setup();
    for (let i = 0; i < 9; i += 1) await report(KIN_EMAIL, NOW + i * 1000);
    expect((await stored(ctx, SECURITY_DOC)).lockedUntilMs).toBeUndefined();

    await report(KIN_EMAIL, NOW + 9000);
    const lock = await stored(ctx, SECURITY_DOC);
    expect(lock.lockStartedAtMs).toBe(NOW + 9000);
    expect(lock.lockedUntilMs).toBe(NOW + 9000 + LOCK_MS);
  });

  it('fires the household lock alert and the operator alert on the lock', async () => {
    const ctx = await setup();
    for (let i = 0; i < 10; i += 1) await report(KIN_EMAIL, NOW + i * 1000);

    expect(mocks.enqueueCalls).toContain('auth.account.locked');
    expect(mocks.enqueueCalls).toContain(OPERATOR_KEY);
    const operatorInbox = (ctx.writes as Write[]).filter(
      (w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'op1' && w.data.key === OPERATOR_KEY,
    );
    expect(operatorInbox).toHaveLength(1);
  });
});

/** Paths inside `value` that hold `undefined`, which real Firestore refuses outright. */
function undefinedPaths(value: unknown, at = ''): string[] {
  if (value === undefined) return [at || '(root)'];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => undefinedPaths(v, at ? `${at}.${k}` : k));
}

describe('#886 a report carrying only { email } is storable by real Firestore', () => {
  // Found by the emulator run, not by this harness: every client sends `email`
  // alone, and the attempt entry was built as `{ ts, ip: args.ip, userAgent:
  // args.userAgent }`. The write-through mock stores `undefined` happily; real
  // Firestore throws "Cannot use undefined as a Firestore value", so no attempt
  // was ever counted and no account could ever lock.
  it('writes no undefined field for a real account, all the way through a lock', async () => {
    const ctx = await setup();
    for (let i = 0; i < 10; i += 1) await report(KIN_EMAIL, NOW + i * 1000);

    const offenders = (ctx.writes as Write[]).flatMap((w) => undefinedPaths(w.data).map((p) => `${w.path}: ${p}`));
    expect(offenders).toEqual([]);
    expect((await stored(ctx, SECURITY_DOC)).attempts).toHaveLength(10);
  });

  it('keeps ip and userAgent on the attempt when a caller does send them', async () => {
    const ctx = await setup();
    vi.setSystemTime(NOW);
    await recordFailedLoginHandler(
      callableRequest({ email: KIN_EMAIL, ip: '10.0.0.1', userAgent: 'TestAgent/1' }, { ip: '203.0.113.7' }),
    );
    expect((await stored(ctx, SECURITY_DOC)).attempts).toEqual([{ ts: NOW, ip: '10.0.0.1', userAgent: 'TestAgent/1' }]);
  });

  it('hands the audit writer no undefined field either', async () => {
    await setup();
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    await report(KIN_EMAIL, NOW);
    await report(STRANGER_EMAIL, NOW + 1000);
    const payloads = vi.mocked(writeAuditEntry).mock.calls.map((c) => c[0]);
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads.flatMap((p) => undefinedPaths(p))).toEqual([]);
  });
});

describe('#886 an unknown email does the same shape of work and touches no account', () => {
  it('writes one attempts row under a hashed id, and nothing under clients/', async () => {
    const ctx = await setup();
    await report(STRANGER_EMAIL, NOW);
    await report(STRANGER_EMAIL, NOW + 1000);

    const writes = ctx.writes as Write[];
    expect(writes.filter((w) => w.path.startsWith('clients/'))).toEqual([]);
    expect(mocks.enqueueCalls).toEqual([]);

    const rows = writes.filter((w) => w.path.startsWith('unknownLoginAttempts/'));
    expect(rows.length).toBeGreaterThan(0);
    const path = rows[rows.length - 1]!.path;
    expect(path, 'the address is never the document id').not.toContain('nobody');
    const row = await stored(ctx, path);
    expect(row.attempts).toEqual([{ ts: NOW }, { ts: NOW + 1000 }]);
    expect(JSON.stringify(row)).not.toContain(STRANGER_EMAIL);
  });
});

describe('#886 rate limits still hold, and refuse both kinds of email the same way', () => {
  async function sixteenthRefusal(email: string): Promise<HttpsError> {
    await setup();
    // Fifteen reports a day per address, from rotating IPs so the IP limit is not what trips.
    for (let i = 0; i < 15; i += 1) await report(email, NOW + i * 60_000, `198.51.100.${i}`);
    const err = await report(email, NOW + 16 * 60_000, '198.51.100.200').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpsError);
    return err as HttpsError;
  }

  it('the 16th report for one address in 24 hours is refused, real or unknown alike', async () => {
    const real = await sixteenthRefusal(KIN_EMAIL);
    const unknown = await sixteenthRefusal(STRANGER_EMAIL);
    expect(real.code).toBe('resource-exhausted');
    expect({ code: unknown.code, message: unknown.message }).toEqual({ code: real.code, message: real.message });
  });

  it('the 31st report from one IP in 5 minutes is refused', async () => {
    await setup();
    for (let i = 0; i < 30; i += 1) await report(`person${i}@household.test`, NOW + i * 1000, '192.0.2.9');
    const err = await report('person30@household.test', NOW + 31_000, '192.0.2.9').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe('resource-exhausted');
  });

  it('a malformed email is refused before any account lookup', async () => {
    await setup();
    await expect(recordFailedLoginHandler(callableRequest({ email: 'not-an-email' }))).rejects.toThrow();
    expect(mocks.getUserByEmail).not.toHaveBeenCalled();
    expect(RecordFailedLoginArgs.safeParse({ email: KIN_EMAIL }).success).toBe(true);
  });
});
