import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #877: the 5-failure warning has a household copy and an operator copy, and
 * they are two different notifications.
 *
 * On main, `auth.failedLogin.attempts` reached business admins through its
 * `secondaryResolver: 'businessAdmins'`, with the household's own template
 * ("failed attempts to sign in to your Tribe Tails account"). An operator read a
 * warning that looked like their own account was under attack, with no
 * household named.
 *
 * This drives the REAL `recordFailedLoginHandler` through the REAL dispatcher
 * and recipient resolver on one write-through mock, the same harness as
 * operatorLockAlert.test.ts (#869). Only the audit chain, the logger and
 * `auth().getUserByEmail` are faked.
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
  failedLoginWarningDedupeKey,
} from '../src/auth/loginSecurity';
import { NOTIFICATION_DEDUPE_WINDOW_MS } from '../src/notifications/dispatcher';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';

const OPERATOR_KEY = 'security.failedLogin.attempts.operator';
const HOUSEHOLD_KEY = 'auth.failedLogin.attempts';
const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
/** The 5th failure, which starts the warning burst. */
const WARN_AT = NOW + 4000;
const WARN_WINDOW_MS = 10 * 60 * 1000;
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

/** Failures at NOW, NOW+1s, ... The 5th one (at WARN_AT) crosses the warning threshold. */
async function failures(count: number, startMs = NOW): Promise<void> {
  for (let i = 0; i < count; i += 1) await fail(startMs + i * 1000);
}

function notificationsWithKey(writes: Write[], key: string): Write[] {
  return writes.filter((w) => w.path.startsWith('notifications/') && w.data.key === key);
}

function inboxFor(writes: Write[], uid: string): Write[] {
  return writes.filter((w) => w.path.startsWith('notifications/') && w.data.recipientUid === uid);
}

function warningCopies(writes: Write[]) {
  return {
    operator: inboxFor(writes, 'op1').filter((w) => w.data.key === OPERATOR_KEY),
    household: inboxFor(writes, 'kin1').filter((w) => w.data.key === HOUSEHOLD_KEY),
  };
}

function dataOf(w: Write): Record<string, unknown> {
  return w.data.data as Record<string, unknown>;
}

function workOrderFor(writes: Write[], notificationPath: string): Write | undefined {
  const id = notificationPath.slice('notifications/'.length);
  return writes.find((w) => w.path === `notificationDispatch/${id}`);
}

function isDeleted(v: unknown): boolean {
  return v instanceof FieldValue && v.isEqual(FieldValue.delete());
}

async function storedSecurityDoc(ctx: ReturnType<typeof buildDbMock>): Promise<Record<string, unknown>> {
  return ((await ctx.db.doc(SECURITY_DOC).get()).data() ?? {}) as Record<string, unknown>;
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

describe('#877 catalog: the warning is two rows', () => {
  it('the household row reaches the kinfolk only', () => {
    const def = NOTIFICATION_CATALOG[HOUSEHOLD_KEY]!;
    expect(def.secondaryResolver).toBeUndefined();
    expect(def.recipientResolver).toBe('specificUid');
    expect(def.audience).toBe('kinfolk');
    expect(def.audiences).toEqual({ kinfolk: true });
  });

  it('the operator row is a business security alert, shaped like the lock alert', () => {
    const def = NOTIFICATION_CATALOG[OPERATOR_KEY]!;
    const lock = NOTIFICATION_CATALOG['security.account.locked.operator']!;
    expect(def).toBeTruthy();
    expect(def.audience).toBe('business');
    expect(def.audiences).toEqual({ business: true });
    expect(def.category).toBe('security');
    expect(def.recipientResolver).toBe('businessAdmins');
    expect(def.secondaryResolver).toBeUndefined();
    expect(def.allowedChannels).toEqual(lock.allowedChannels);
    expect(def.required).toEqual(lock.required);
    expect(def.alwaysEnabled).toBe(lock.alwaysEnabled);
    expect(def.kinfolkFacing).toBe(false);
    expect(def.templates).toEqual({ email: OPERATOR_KEY, sms: OPERATOR_KEY, push: OPERATOR_KEY });
  });
});

describe('#877 operator failed-login warning', () => {
  it('delivers the operator copy under its own key, as staff, on the channels their staff prefs allow', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(5);

    const opCopies = inboxFor(ctx.writes as Write[], 'op1');
    expect(
      opCopies.map((w) => ({ key: w.data.key, category: w.data.category })),
      'the operator copy must be the operator key in the security category',
    ).toEqual([{ key: OPERATOR_KEY, category: 'security' }]);

    expect(
      workOrderFor(ctx.writes as Write[], opCopies[0]!.path)?.data.channels,
      'staff/op1 opted into SMS for security; required email + push stay on',
    ).toEqual(['email', 'sms', 'push']);

    expect(dataOf(opCopies[0]!)).toEqual({
      kinfolkUid: 'kin1',
      kinfolkId: 'fam1',
      kinfolkName: 'The Rivera household',
      kinfolkEmail: KIN_EMAIL,
      attemptsInWindow: 5,
      warnStartedAtMs: WARN_AT,
    });
    expect(opCopies[0]!.data.targetType).toBe('kinfolk');
    expect(opCopies[0]!.data.targetId).toBe('fam1');
  });

  it('sends nothing to anyone before the 5th failure', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(4);

    expect(mocks.enqueueCalls).toEqual([]);
  });

  it('never sends the household template to an operator, and leaves the kinfolk copy unchanged', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(5);

    const writes = ctx.writes as Write[];
    const household = notificationsWithKey(writes, HOUSEHOLD_KEY);
    expect(household.map((w) => w.data.recipientUid), 'the household copy reaches the kinfolk only').toEqual([
      'kin1',
    ]);
    expect(dataOf(household[0]!)).toEqual({ email: KIN_EMAIL, attemptsInWindow: 5 });
    expect(inboxFor(writes, 'op1').filter((w) => w.data.key === HOUSEHOLD_KEY)).toEqual([]);
    expect(inboxFor(writes, 'kin1').filter((w) => w.data.key === OPERATOR_KEY)).toEqual([]);
  });

  it('resolves operators from the business admin roster, not from AUNTIE_OPERATOR_UIDS', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'revokedOp';
    const ctx = buildDbMock({
      writeThrough: true,
      docs: baseDocs({
        'businessSettings/admins': { uids: ['op1', 'op2'] },
        'staff/op2': { email: 'second@tribetails.test' },
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(5);

    const writes = ctx.writes as Write[];
    expect(inboxFor(writes, 'op1').map((w) => w.data.key)).toEqual([OPERATOR_KEY]);
    expect(inboxFor(writes, 'op2').map((w) => w.data.key)).toEqual([OPERATOR_KEY]);
    expect(inboxFor(writes, 'revokedOp')).toEqual([]);
  });

  it('still warns the household when no operator can be resolved', async () => {
    delete process.env.AUNTIE_OPERATOR_UIDS;
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs({ 'businessSettings/admins': null }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(5);

    expect(warningCopies(ctx.writes as Write[]).household).toHaveLength(1);
  });

  it('omits kinfolkId rather than guessing when the account holds several households', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: baseDocs({ 'clients/kin1': { email: KIN_EMAIL, displayName: 'Pat', kinfolkIds: ['fam1', 'fam2'] } }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(5);

    const data = dataOf(warningCopies(ctx.writes as Write[]).operator[0]!);
    expect(data.kinfolkId).toBeUndefined();
    expect(data.kinfolkName).toBe('Pat');
    expect(data.kinfolkEmail).toBe(KIN_EMAIL);
  });
});

describe('#877 operator warning always names the household (same chain as the lock alert)', () => {
  async function nameSent(docs: Record<string, Record<string, unknown> | null>): Promise<unknown> {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs(docs) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await failures(5);
    return dataOf(warningCopies(ctx.writes as Write[]).operator[0]!).kinfolkName;
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

describe('#877 warning bursts: one alert per burst, retried until it goes out', () => {
  it('a household enqueue that throws leaves the burst saved; the next failed login sends each copy exactly once, for the same burst', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(4);

    let docWhenWarningFailed: Record<string, unknown> | undefined;
    mocks.failOnce.add(HOUSEHOLD_KEY);
    mocks.onInjectedFailure = async () => {
      docWhenWarningFailed = (await ctx.db.doc(SECURITY_DOC).get()).data();
    };
    await expect(fail(WARN_AT)).rejects.toThrow(/injected auth\.failedLogin\.attempts failure/);

    // The burst was already saved when the warning failed, with the pending marker.
    expect(docWhenWarningFailed).toMatchObject({ warnSentAtMs: WARN_AT, warnAlertsPendingForMs: WARN_AT });
    expect(warningCopies(ctx.writes as Write[]).operator).toHaveLength(0);

    await fail(WARN_AT + 60_000);
    await fail(WARN_AT + 120_000);

    const writes = ctx.writes as Write[];
    const { operator, household } = warningCopies(writes);
    expect(operator, 'exactly one operator warning').toHaveLength(1);
    expect(household, 'exactly one household warning').toHaveLength(1);
    expect(dataOf(operator[0]!).warnStartedAtMs).toBe(WARN_AT);

    // Same dedupe key as the burst it belongs to, not a key minted by the retry.
    const ledger = writes.filter((w) => w.path.startsWith('notificationDedupe/') && w.data.key === OPERATOR_KEY);
    expect(ledger.map((w) => w.data.identity)).toEqual([`key:${failedLoginWarningDedupeKey('kin1', WARN_AT)}`]);
  });

  it('an operator enqueue that fails is retried by the next failed login without a second household warning', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(4);
    mocks.failOnce.add(OPERATOR_KEY);
    // The operator copy is caught, so the call itself still succeeds.
    await expect(fail(WARN_AT)).resolves.toBeTruthy();
    expect(warningCopies(ctx.writes as Write[]).operator).toHaveLength(0);
    expect((await storedSecurityDoc(ctx)).warnAlertsPendingForMs).toBe(WARN_AT);

    // Past the default 5-minute dedupe window, still inside the 10-minute burst.
    const retryAt = WARN_AT + 6 * 60_000;
    expect(retryAt - WARN_AT).toBeGreaterThan(NOTIFICATION_DEDUPE_WINDOW_MS);
    await fail(retryAt);
    await fail(retryAt + 1000);

    const { operator, household } = warningCopies(ctx.writes as Write[]);
    expect(operator).toHaveLength(1);
    expect(dataOf(operator[0]!).warnStartedAtMs).toBe(WARN_AT);
    expect(household).toHaveLength(1);
  });

  it('clears the pending marker once both copies go out, so later failures in the burst enqueue nothing', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(5);

    const stored = await storedSecurityDoc(ctx);
    expect(stored.warnSentAtMs).toBe(WARN_AT);
    expect(isDeleted(stored.warnAlertsPendingForMs), 'marker deleted after both copies went out').toBe(true);

    // Zero enqueue CALLS, not zero new notifications: a retry swallowed by the
    // dedupe ledger would look the same in the inbox.
    mocks.enqueueCalls.length = 0;
    await fail(WARN_AT + 60_000);
    await fail(WARN_AT + 6 * 60_000);
    expect(mocks.enqueueCalls).toEqual([]);
  });

  it("does not clear a newer burst's marker that replaced this one while its copies were sending", async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(4);

    const NEWER = WARN_AT + 5000;
    mocks.beforeEnqueue = async (key) => {
      if (key !== OPERATOR_KEY) return;
      mocks.beforeEnqueue = null;
      await ctx.db.doc(SECURITY_DOC).set({ warnSentAtMs: NEWER, warnAlertsPendingForMs: NEWER }, { merge: true });
    };
    await fail(WARN_AT);

    expect((await storedSecurityDoc(ctx)).warnAlertsPendingForMs).toBe(NEWER);
  });

  it('a later burst, after the 10-minute window, is a new alert to both', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(5);
    // Past the 20-minute lock window too, so the first burst's failures do not
    // add up to a lock.
    const SECOND = NOW + 21 * 60_000;
    await failures(5, SECOND);

    const { operator, household } = warningCopies(ctx.writes as Write[]);
    expect(operator.map((w) => dataOf(w).warnStartedAtMs)).toEqual([WARN_AT, SECOND + 4000]);
    expect(household).toHaveLength(2);
  });

  it('a pending burst is not retried once its 10-minute window has passed', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(4);
    mocks.failOnce.add(OPERATOR_KEY);
    await fail(WARN_AT);
    expect((await storedSecurityDoc(ctx)).warnAlertsPendingForMs).toBe(WARN_AT);

    // Outside the burst, and with too few recent failures for a new one. A send
    // here would fall outside the dedupe window and could double the household copy.
    mocks.enqueueCalls.length = 0;
    await fail(WARN_AT + WARN_WINDOW_MS + 1000);
    expect(mocks.enqueueCalls).toEqual([]);
  });

  it('a warning stamped before this change (no pending marker) is never re-sent', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: baseDocs({
        [SECURITY_DOC]: {
          attempts: [0, 1, 2, 3, 4].map((i) => ({ ts: NOW - 60_000 + i })),
          warnSentAtMs: NOW - 60_000,
        },
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await fail(NOW);
    expect(mocks.enqueueCalls).toEqual([]);
  });

  it('unlockKinfolkAccount deletes the pending marker with the rest of the burst state', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: baseDocs() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await failures(4);
    mocks.failOnce.add(OPERATOR_KEY);
    await fail(WARN_AT);
    expect((await storedSecurityDoc(ctx)).warnAlertsPendingForMs).toBe(WARN_AT);

    await unlockKinfolkAccountHandler(callableRequest({ uid: 'kin1' }, { uid: 'op1', token: { admin: true } }));

    const stored = await storedSecurityDoc(ctx);
    expect(isDeleted(stored.warnAlertsPendingForMs)).toBe(true);
    expect(isDeleted(stored.warnSentAtMs)).toBe(true);
  });

  it('the dedupe key names both the household and the burst start', () => {
    expect(failedLoginWarningDedupeKey('kin1', 1)).not.toEqual(failedLoginWarningDedupeKey('kin2', 1));
    expect(failedLoginWarningDedupeKey('kin1', 1)).not.toEqual(failedLoginWarningDedupeKey('kin1', 2));
    expect(failedLoginWarningDedupeKey('kin1', 1)).toEqual(failedLoginWarningDedupeKey('kin1', 1));
  });
});
