import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #869: when a kinfolk account locks, the operator copy of the alert has to
 * reach the operator AS STAFF.
 *
 * This drives the REAL `recordFailedLoginHandler` through the REAL dispatcher
 * and recipient resolver on one write-through mock. Only the audit chain, the
 * logger and `auth().getUserByEmail` are faked. The previous test for this path
 * (loginSecurityOperatorLoop.test.ts) re-implemented the env loop inline and
 * mocked the dispatcher, so it could not see the defect below.
 *
 * The defect, as it stood on main: the operator copy was enqueued as
 * `auth.account.locked` with `recipientUid: <operator>`, whose `specificUid`
 * resolver tags every recipient `clients`. So the operator's prefs were read
 * from `clients/{operatorUid}` (a doc operators do not have), the copy was
 * gated as the KINFOLK stream, their staff SMS opt-in was ignored, and the
 * template was the household's own "I've locked your account".
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUserByEmail: vi.fn(),
  /** Notification keys whose NEXT enqueue from loginSecurity throws, once each. */
  failOnce: new Set<string>(),
  onInjectedFailure: null as null | (() => Promise<void>),
  /** Every key loginSecurity asked to enqueue, in order, whether or not it was delivered. */
  enqueueCalls: [] as string[],
  /** Runs before loginSecurity's enqueue reaches the dispatcher. */
  beforeEnqueue: null as null | ((key: string) => Promise<void>),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ getUserByEmail: mocks.getUserByEmail }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn(async () => 'audit-1') }));
// loginSecurity imports the dispatcher through the notifications barrel. This
// wraps ONLY that entry point, so a failure can be injected into the handler's
// enqueue while every other call still reaches the real dispatcher.
vi.mock('../src/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/notifications')>();
  return {
    ...actual,
    enqueueNotification: async (args: Parameters<typeof actual.enqueueNotification>[0]) => {
      mocks.enqueueCalls.push(args.key);
      if (mocks.beforeEnqueue) await mocks.beforeEnqueue(args.key);
      if (mocks.failOnce.has(args.key)) {
        mocks.failOnce.delete(args.key);
        if (mocks.onInjectedFailure) await mocks.onInjectedFailure();
        throw new Error(`injected ${args.key} failure`);
      }
      return actual.enqueueNotification(args);
    },
  };
});

import { FieldValue } from 'firebase-admin/firestore';
import {
  recordFailedLoginHandler,
  unlockKinfolkAccountHandler,
  lockAlertDedupeKey,
} from '../src/auth/loginSecurity';
import { enqueueNotification, NOTIFICATION_DEDUPE_WINDOW_MS } from '../src/notifications/dispatcher';

const OPERATOR_KEY = 'security.account.locked.operator';
const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const LOCK_AT = NOW + 9000;
const LOCK_MS = 30 * 60 * 1000;
const KIN_EMAIL = 'pat@household.test';
const SECURITY_DOC = 'clients/kin1/security/loginAttempts';

type Write = { path: string; data: Record<string, unknown> };

function baseDocs(overrides: Record<string, Record<string, unknown> | null> = {}) {
  return {
    'businessSettings/admins': { uids: ['op1'] },
    // The operator: a staff doc with an email and an SMS opt-in for security
    // alerts. No clients/op1 exists, which is true of every operator.
    'staff/op1': {
      email: 'owner@tribetails.test',
      notificationPrefs: { byCategory: { security: { sms: true } } },
    },
    'clients/kin1': { email: KIN_EMAIL, displayName: 'Pat', kinfolkIds: ['fam1'] },
    'families/fam1': { displayName: 'The Rivera household' },
    ...overrides,
  };
}

function fail(atMs: number) {
  vi.setSystemTime(atMs);
  return recordFailedLoginHandler(callableRequest({ email: KIN_EMAIL }, { ip: '203.0.113.7' }));
}

async function lockOut(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await fail(NOW + i * 1000);
}

/** The first nine failures: one short of the lock. */
async function nineFailures(): Promise<void> {
  for (let i = 0; i < 9; i += 1) await fail(NOW + i * 1000);
}

/**
 * Every inbox doc for `uid`, minus the 5th-failure warning. `auth.failedLogin.attempts`
 * already reaches business admins through its secondary resolver, fires on the
 * way to a lock, and is not what this issue is about.
 */
function inboxFor(writes: Write[], uid: string): Write[] {
  return writes.filter(
    (w) =>
      w.path.startsWith('notifications/') &&
      w.data.recipientUid === uid &&
      w.data.key !== 'auth.failedLogin.attempts',
  );
}

function workOrderFor(writes: Write[], notificationPath: string): Write | undefined {
  const id = notificationPath.slice('notifications/'.length);
  return writes.find((w) => w.path === `notificationDispatch/${id}`);
}

/**
 * True when a merge write deleted the field. The write-through mock stores the
 * `FieldValue.delete()` sentinel verbatim rather than removing the key, which is
 * exactly what Firestore is asked to do, so the sentinel is the assertion.
 */
function isDeleted(v: unknown): boolean {
  return v instanceof FieldValue && v.isEqual(FieldValue.delete());
}

async function storedSecurityDoc(ctx: ReturnType<typeof buildDbMock>): Promise<Record<string, unknown>> {
  return ((await ctx.db.doc(SECURITY_DOC).get()).data() ?? {}) as Record<string, unknown>;
}

function lockCopies(writes: Write[]) {
  return {
    operator: inboxFor(writes, 'op1').filter((w) => w.data.key === OPERATOR_KEY),
    household: inboxFor(writes, 'kin1').filter((w) => w.data.key === 'auth.account.locked'),
  };
}

let originalEnv: string | undefined;
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUserByEmail.mockReset();
  mocks.getUserByEmail.mockResolvedValue({ uid: 'kin1' });
  mocks.failOnce.clear();
  mocks.onInjectedFailure = null;
  mocks.enqueueCalls.length = 0;
  mocks.beforeEnqueue = null;
  originalEnv = process.env.AUNTIE_OPERATOR_UIDS;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  if (originalEnv === undefined) delete process.env.AUNTIE_OPERATOR_UIDS;
  else process.env.AUNTIE_OPERATOR_UIDS = originalEnv;
});

describe('#869 operator account-lock alert', () => {
  it('delivers the operator copy under its own key, as staff, on the channels their staff prefs allow', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await lockOut();

    const opCopies = inboxFor(ctx.writes as Write[], 'op1');
    expect(
      opCopies.map((w) => ({ key: w.data.key, category: w.data.category })),
      'the operator copy must be the operator key in the security category',
    ).toEqual([{ key: OPERATOR_KEY, category: 'security' }]);

    const order = workOrderFor(ctx.writes as Write[], opCopies[0]!.path);
    expect(
      order?.data.channels,
      'staff/op1 opted into SMS for security; required email + push stay on',
    ).toEqual(['email', 'sms', 'push']);

    expect(opCopies[0]!.data.data).toMatchObject({
      kinfolkUid: 'kin1',
      kinfolkId: 'fam1',
      kinfolkName: 'The Rivera household',
      kinfolkEmail: KIN_EMAIL,
      lockStartedAtMs: LOCK_AT,
    });
    // A household deep link on the operator's card.
    expect(opCopies[0]!.data.targetType).toBe('kinfolk');
    expect(opCopies[0]!.data.targetId).toBe('fam1');
  });

  it('never sends the household template to an operator, and leaves the kinfolk copy unchanged', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await lockOut();

    const writes = ctx.writes as Write[];
    expect(inboxFor(writes, 'op1').filter((w) => w.data.key === 'auth.account.locked')).toEqual([]);

    const kinCopies = lockCopies(writes).household;
    expect(kinCopies).toHaveLength(1);
    expect(kinCopies[0]!.data.data).toEqual({ email: KIN_EMAIL, lockStartedAtMs: LOCK_AT });
  });

  it('resolves operators from the business admin roster, not from AUNTIE_OPERATOR_UIDS', async () => {
    // The env names someone the roster does not. The roster wins (lib/businessAdmins.ts).
    process.env.AUNTIE_OPERATOR_UIDS = 'revokedOp';
    const ctx = buildDbMock({
      writeThrough: true,
      docs: baseDocs({
        'businessSettings/admins': { uids: ['op1', 'op2'] },
        'staff/op2': { email: 'second@tribetails.test' },
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await lockOut();

    const writes = ctx.writes as Write[];
    expect(inboxFor(writes, 'op1').map((w) => w.data.key)).toEqual([OPERATOR_KEY]);
    expect(inboxFor(writes, 'op2').map((w) => w.data.key)).toEqual([OPERATOR_KEY]);
    expect(inboxFor(writes, 'revokedOp')).toEqual([]);
  });

  it('falls back to AUNTIE_OPERATOR_UIDS only while the roster is empty', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({
      writeThrough: true,
      docs: baseDocs({ 'businessSettings/admins': null }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await lockOut();

    expect(inboxFor(ctx.writes as Write[], 'op1').map((w) => w.data.key)).toEqual([OPERATOR_KEY]);
  });

  it('still locks the account and alerts the household when no operator can be resolved', async () => {
    delete process.env.AUNTIE_OPERATOR_UIDS;
    const ctx = buildDbMock({
      writeThrough: true,
      docs: baseDocs({ 'businessSettings/admins': null }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await nineFailures();
    const last = await fail(LOCK_AT);

    expect(last.locked).toBe(true);
    expect(lockCopies(ctx.writes as Write[]).household).toHaveLength(1);
  });

  it('omits kinfolkId rather than guessing when the account holds several households', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({
      writeThrough: true,
      docs: baseDocs({ 'clients/kin1': { email: KIN_EMAIL, displayName: 'Pat', kinfolkIds: ['fam1', 'fam2'] } }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await lockOut();

    const data = inboxFor(ctx.writes as Write[], 'op1')[0]!.data.data as Record<string, unknown>;
    expect(data.kinfolkId).toBeUndefined();
    expect(data.kinfolkName).toBe('Pat');
    expect(data.kinfolkEmail).toBe(KIN_EMAIL);
  });
});

/**
 * #869 review, LOW: the subject is "Account locked: {{kinfolkName}} ({{kinfolkEmail}})".
 * An emitter-supplied `kinfolkName` always wins over the enricher, so the
 * handler has to send a name that is never blank.
 */
describe('#869 operator lock alert always names the household', () => {
  async function nameSent(docs: Record<string, Record<string, unknown> | null>): Promise<unknown> {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs(docs) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await lockOut();
    return (lockCopies(ctx.writes as Write[]).operator[0]!.data.data as Record<string, unknown>).kinfolkName;
  }

  it('uses the account name when the one household has no name fields', async () => {
    expect(await nameSent({ 'families/fam1': { primaryUid: 'kin1' } })).toBe('Pat');
  });

  it('uses the email local part when neither the household nor the account has a name', async () => {
    expect(
      await nameSent({
        'clients/kin1': { email: KIN_EMAIL, kinfolkIds: ['fam1'] },
        'families/fam1': { displayName: '   ' },
      }),
    ).toBe('pat');
  });
});

/**
 * #869 review, MEDIUM: the lock is saved before any alert, and an alert that
 * did not go out is re-sent for THAT lock (same lockStartedAtMs, same dedupe
 * key) by the next failed login, exactly once.
 */
describe('#869 lock alerts survive a failed enqueue', () => {
  it('a household enqueue that throws leaves the lock saved; the next failed login sends each alert exactly once, for the same lock', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await nineFailures();

    let lockDocWhenAlertFailed: Record<string, unknown> | undefined;
    mocks.failOnce.add('auth.account.locked');
    mocks.onInjectedFailure = async () => {
      lockDocWhenAlertFailed = (await ctx.db.doc(SECURITY_DOC).get()).data();
    };
    await expect(fail(LOCK_AT)).rejects.toThrow(/injected auth\.account\.locked failure/);

    // The lock was already saved when the alert failed, with the pending marker.
    expect(lockDocWhenAlertFailed).toMatchObject({
      lockStartedAtMs: LOCK_AT,
      lockedUntilMs: LOCK_AT + LOCK_MS,
      lockAlertsPendingForMs: LOCK_AT,
    });
    expect(lockCopies(ctx.writes as Write[]).operator).toHaveLength(0);

    const retry = await fail(LOCK_AT + 60_000);
    expect(retry).toEqual({ remainingBeforeLock: 0, locked: true, lockedUntilMs: LOCK_AT + LOCK_MS });
    await fail(LOCK_AT + 120_000);
    await fail(LOCK_AT + 180_000);

    const writes = ctx.writes as Write[];
    const { operator, household } = lockCopies(writes);
    expect(operator, 'exactly one operator alert').toHaveLength(1);
    expect(household, 'exactly one household alert').toHaveLength(1);
    expect((operator[0]!.data.data as Record<string, unknown>).lockStartedAtMs).toBe(LOCK_AT);
    expect((household[0]!.data.data as Record<string, unknown>).lockStartedAtMs).toBe(LOCK_AT);

    // Same dedupe key as the lock it belongs to, not a key minted by the retry.
    const ledger = writes.filter((w) => w.path.startsWith('notificationDedupe/') && w.data.key === OPERATOR_KEY);
    expect(ledger.map((w) => w.data.identity)).toEqual([`key:${lockAlertDedupeKey('kin1', LOCK_AT)}`]);
  });

  it('an operator enqueue that fails is retried by the next failed login without a second household alert', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await nineFailures();
    mocks.failOnce.add(OPERATOR_KEY);
    // The operator copy is caught, so the lock call itself still succeeds.
    expect((await fail(LOCK_AT)).locked).toBe(true);
    expect(lockCopies(ctx.writes as Write[]).operator).toHaveLength(0);

    // Past the default 5-minute dedupe window, still inside the 30-minute lock.
    await fail(LOCK_AT + 10 * 60_000);
    await fail(LOCK_AT + 11 * 60_000);
    expect(10 * 60_000).toBeGreaterThan(NOTIFICATION_DEDUPE_WINDOW_MS);

    const { operator, household } = lockCopies(ctx.writes as Write[]);
    expect(operator).toHaveLength(1);
    expect((operator[0]!.data.data as Record<string, unknown>).lockStartedAtMs).toBe(LOCK_AT);
    expect(household).toHaveLength(1);
  });

  it('clears the pending marker once both alerts go out, so a later failed login during the lock enqueues nothing', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await lockOut();

    const stored = await storedSecurityDoc(ctx);
    expect(stored.lockStartedAtMs).toBe(LOCK_AT);
    expect(isDeleted(stored.lockAlertsPendingForMs), 'marker deleted after both alerts went out').toBe(true);

    // Not "no new notifications": a retry would be swallowed by the dedupe
    // ledger and look identical. Zero enqueue CALLS is what proves no retry ran.
    mocks.enqueueCalls.length = 0;
    expect((await fail(LOCK_AT + 60_000)).locked).toBe(true);
    expect((await fail(LOCK_AT + 10 * 60_000)).locked).toBe(true);
    expect(mocks.enqueueCalls).toEqual([]);
  });

  it("does not clear a newer lock's marker that replaced this one while its alerts were sending", async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await nineFailures();

    // While lock A's operator alert is on its way, the account is unlocked and
    // locked again (lock B), which saves B's own pending marker.
    const NEWER = LOCK_AT + 5000;
    mocks.beforeEnqueue = async (key) => {
      if (key !== OPERATOR_KEY) return;
      mocks.beforeEnqueue = null;
      await ctx.db
        .doc(SECURITY_DOC)
        .set(
          { lockStartedAtMs: NEWER, lockedUntilMs: NEWER + LOCK_MS, lockAlertsPendingForMs: NEWER },
          { merge: true },
        );
    };
    expect((await fail(LOCK_AT)).locked).toBe(true);

    // Lock A's alerts finished; lock B's retry marker must survive A's clear.
    expect((await storedSecurityDoc(ctx)).lockAlertsPendingForMs).toBe(NEWER);
  });

  it('a lock saved before this change (no pending marker) is never re-alerted', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({
      writeThrough: true,
      docs: baseDocs({
        [SECURITY_DOC]: { attempts: [], lockStartedAtMs: NOW - 60_000, lockedUntilMs: NOW + LOCK_MS },
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    expect((await fail(NOW)).locked).toBe(true);
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/'))).toEqual([]);
  });
});

describe('#869 unlockKinfolkAccount', () => {
  it('deletes the pending marker along with the other lock fields', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    // A lock whose operator alert failed, so its marker is still pending.
    await nineFailures();
    mocks.failOnce.add(OPERATOR_KEY);
    await fail(LOCK_AT);
    expect((await storedSecurityDoc(ctx)).lockAlertsPendingForMs).toBe(LOCK_AT);

    await expect(
      unlockKinfolkAccountHandler(callableRequest({ uid: 'kin1' }, { uid: 'op1', token: { admin: true } })),
    ).resolves.toEqual({ ok: true });

    const stored = await storedSecurityDoc(ctx);
    expect(isDeleted(stored.lockAlertsPendingForMs), 'unlock deletes the pending marker').toBe(true);
    expect(isDeleted(stored.lockStartedAtMs)).toBe(true);
    expect(isDeleted(stored.lockedUntilMs)).toBe(true);
  });
});

describe('#869 operator lock alert identity (#832 dedupe)', () => {
  function send(kinfolkUid: string, lockStartedAtMs: number) {
    return enqueueNotification({
      key: OPERATOR_KEY,
      data: { kinfolkUid, kinfolkEmail: KIN_EMAIL, lockStartedAtMs },
      dedupeKey: lockAlertDedupeKey(kinfolkUid, lockStartedAtMs),
    });
  }

  it('two distinct lockouts inside the window are two alerts; a retry of one is not', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await send('kin1', NOW);
    vi.setSystemTime(NOW + 30_000);
    await send('kin2', NOW + 30_000); // a different household locks
    vi.setSystemTime(NOW + 60_000);
    await send('kin1', NOW + 60_000); // the same household locks again (a new lock event)
    vi.setSystemTime(NOW + 90_000);
    await send('kin1', NOW); // exact retry of the first
    expect(90_000).toBeLessThan(NOTIFICATION_DEDUPE_WINDOW_MS);

    expect(inboxFor(ctx.writes as Write[], 'op1')).toHaveLength(3);
  });

  it('the dedupe key names both the household and the lock start', () => {
    expect(lockAlertDedupeKey('kin1', 1)).not.toEqual(lockAlertDedupeKey('kin2', 1));
    expect(lockAlertDedupeKey('kin1', 1)).not.toEqual(lockAlertDedupeKey('kin1', 2));
    expect(lockAlertDedupeKey('kin1', 1)).toEqual(lockAlertDedupeKey('kin1', 1));
  });
});
