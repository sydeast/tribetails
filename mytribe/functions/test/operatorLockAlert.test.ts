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
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ getUserByEmail: mocks.getUserByEmail }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn(async () => 'audit-1') }));

import { recordFailedLoginHandler, operatorLockDedupeKey } from '../src/auth/loginSecurity';
import { enqueueNotification, NOTIFICATION_DEDUPE_WINDOW_MS } from '../src/notifications/dispatcher';

const OPERATOR_KEY = 'security.account.locked.operator';
const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const KIN_EMAIL = 'pat@household.test';

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

async function lockOut(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    vi.setSystemTime(NOW + i * 1000);
    await recordFailedLoginHandler(callableRequest({ email: KIN_EMAIL }, { ip: '203.0.113.7' }));
  }
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

let originalEnv: string | undefined;
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUserByEmail.mockReset();
  mocks.getUserByEmail.mockResolvedValue({ uid: 'kin1' });
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
      kinfolkEmail: KIN_EMAIL,
      lockStartedAtMs: NOW + 9000,
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

    const kinCopies = inboxFor(writes, 'kin1').filter((w) => w.data.key === 'auth.account.locked');
    expect(kinCopies).toHaveLength(1);
    expect(kinCopies[0]!.data.data).toEqual({ email: KIN_EMAIL, lockStartedAtMs: NOW + 9000 });
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

    vi.setSystemTime(NOW);
    let last = { locked: false } as Awaited<ReturnType<typeof recordFailedLoginHandler>>;
    for (let i = 0; i < 10; i += 1) {
      vi.setSystemTime(NOW + i * 1000);
      last = await recordFailedLoginHandler(callableRequest({ email: KIN_EMAIL }, { ip: '203.0.113.7' }));
    }

    expect(last.locked).toBe(true);
    expect(inboxFor(ctx.writes as Write[], 'kin1').map((w) => w.data.key)).toContain('auth.account.locked');
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

describe('#869 operator lock alert identity (#832 dedupe)', () => {
  function send(kinfolkUid: string, lockStartedAtMs: number) {
    return enqueueNotification({
      key: OPERATOR_KEY,
      data: { kinfolkUid, kinfolkEmail: KIN_EMAIL, email: KIN_EMAIL, lockStartedAtMs },
      dedupeKey: operatorLockDedupeKey(kinfolkUid, lockStartedAtMs),
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
    expect(operatorLockDedupeKey('kin1', 1)).not.toEqual(operatorLockDedupeKey('kin2', 1));
    expect(operatorLockDedupeKey('kin1', 1)).not.toEqual(operatorLockDedupeKey('kin1', 2));
    expect(operatorLockDedupeKey('kin1', 1)).toEqual(operatorLockDedupeKey('kin1', 1));
  });
});
