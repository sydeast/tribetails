import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
// The stamp is a REAL Timestamp at the (faked) current time, not a sentinel
// string. The duplicate lookup is a `createdAt >=` range query, and a string
// would sort above every Timestamp and match for the wrong reason.
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase-admin/firestore')>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => actual.Timestamp.fromMillis(Date.now()) } };
});

import { createKinfolk, createKinfolkHandler, Args, Result } from '../src/admin/createKinfolk';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const MIN = 60_000;

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

function call(data: unknown, uid = 'op-1') {
  return { data, auth: { uid, token: { admin: true } } } as never;
}

function household(over: Record<string, unknown> = {}) {
  return {
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '(805) 555-0134',
    email: 'jamie@example.com',
    status: 'active',
    serviceAddress: '1 Bark Ave',
    ...over,
  };
}

function stored(id: string, over: Record<string, unknown>) {
  return { id, data: { ...household(), createdByUid: 'op-1', createdAt: Timestamp.fromMillis(NOW - 2 * MIN), ...over } };
}

describe('createKinfolk', () => {
  it('creates the household with the operator and the time stamped on it', async () => {
    const mock = buildDbMock({ queryDocs: { kinfolk: [] } });
    mocks.dbFn.mockReturnValue(mock.db);

    const res = await createKinfolkHandler(call({ kinfolk: household() }));

    expect(res).toEqual({ kinfolkId: 'auto-1', duplicateOf: null });
    expect(mock.writes).toHaveLength(1);
    const w = mock.writes[0];
    expect(w.path).toBe('kinfolk/auto-1');
    expect(w.data).toMatchObject(household());
    expect(w.data.createdByUid).toBe('op-1');
    expect(w.data.createdAtSource).toBe('live');
    expect((w.data.createdAt as Timestamp).toMillis()).toBe(NOW);
  });

  it('never writes an Emergency Contact key, a document id, or a server-owned stamp the client sent', async () => {
    const mock = buildDbMock({ queryDocs: { kinfolk: [] } });
    mocks.dbFn.mockReturnValue(mock.db);

    await createKinfolkHandler(
      call({
        kinfolk: household({
          id: 'x',
          _id: 'x',
          emergencyContacts: [{ name: 'Rae', phone: '8055550199' }],
          emergencyContactName: 'Rae',
          emergencyContactPhone: '8055550199',
          emergencyContactRelation: 'Sister',
          createdAt: '2020-01-01',
          createdAtSource: 'original',
          createdByUid: 'someone-else',
          myTribeLinkedAt: '2020-01-01',
          isTestData: true,
          gateCode: '1234',
          formValues: { petName: 'Biscuit' },
        }),
      }),
    );

    const data = mock.writes[0].data;
    for (const key of ['id', '_id', 'emergencyContacts', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation', 'myTribeLinkedAt', 'isTestData']) {
      expect(data, key).not.toHaveProperty(key);
    }
    expect(data.createdByUid).toBe('op-1');
    expect(data.createdAtSource).toBe('live');
    expect(data.gateCode).toBe('1234');
    expect(data.formValues).toEqual({ petName: 'Biscuit' });
  });

  it('refuses a household with no first name', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ queryDocs: { kinfolk: [] } }).db);
    await expect(createKinfolkHandler(call({ kinfolk: household({ firstName: '  ' }) }))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'A household needs a first name.',
    });
  });

  it('refuses a payload that is not { kinfolk: {...} }', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ queryDocs: { kinfolk: [] } }).db);
    await expect(createKinfolkHandler(call(household()))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(createKinfolkHandler(call({ kinfolk: 'Jamie' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('hands back the household this operator created minutes ago with the same phone, and writes nothing', async () => {
    const mock = buildDbMock({ queryDocs: { kinfolk: [stored('kf-first', { email: 'other@example.com' })] } });
    mocks.dbFn.mockReturnValue(mock.db);

    const res = await createKinfolkHandler(call({ kinfolk: household({ phoneNumber: '805-555-0134' }) }));

    expect(res).toEqual({ kinfolkId: 'kf-first', duplicateOf: 'kf-first' });
    expect(mock.writes).toHaveLength(0);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'kinfolk.create.duplicate', extra: { kinfolkId: 'kf-first', match: 'phone' } }),
    );
    // Never a phone or an email in the log.
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toMatch(/555|example\.com/);
  });

  it('matches on the email alone too', async () => {
    const mock = buildDbMock({ queryDocs: { kinfolk: [stored('kf-first', { phoneNumber: '' })] } });
    mocks.dbFn.mockReturnValue(mock.db);
    const res = await createKinfolkHandler(call({ kinfolk: household({ phoneNumber: '', email: ' JAMIE@example.com' }) }));
    expect(res).toEqual({ kinfolkId: 'kf-first', duplicateOf: 'kf-first' });
  });

  it('creates normally when another operator made the matching household', async () => {
    const mock = buildDbMock({ queryDocs: { kinfolk: [stored('kf-other', { createdByUid: 'op-2' })] } });
    mocks.dbFn.mockReturnValue(mock.db);
    const res = await createKinfolkHandler(call({ kinfolk: household() }));
    expect(res.duplicateOf).toBeNull();
    expect(mock.writes).toHaveLength(1);
  });

  it('creates normally when the matching household is older than ten minutes', async () => {
    const mock = buildDbMock({ queryDocs: { kinfolk: [stored('kf-old', { createdAt: Timestamp.fromMillis(NOW - 11 * MIN) })] } });
    mocks.dbFn.mockReturnValue(mock.db);
    const res = await createKinfolkHandler(call({ kinfolk: household() }));
    expect(res.duplicateOf).toBeNull();
    expect(mock.writes).toHaveLength(1);
  });

  it('creates normally when nothing matches, and never matches two households with no phone and no email', async () => {
    const mock = buildDbMock({
      queryDocs: {
        kinfolk: [
          stored('kf-a', { phoneNumber: '805-555-0199', email: 'someone@example.com' }),
          stored('kf-blank', { phoneNumber: '', email: '' }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(mock.db);
    expect((await createKinfolkHandler(call({ kinfolk: household() }))).duplicateOf).toBeNull();
    expect((await createKinfolkHandler(call({ kinfolk: household({ phoneNumber: '', email: '' }) }))).duplicateOf).toBeNull();
    expect(mock.writes).toHaveLength(2);
  });

  it('a retry straight after a create gets the first household back, not a second one', async () => {
    const mock = buildDbMock({ queryDocs: { kinfolk: [] }, writeThrough: true });
    mocks.dbFn.mockReturnValue(mock.db);

    const first = await createKinfolkHandler(call({ kinfolk: household() }));
    vi.setSystemTime(new Date(NOW + 3 * MIN));
    const second = await createKinfolkHandler(call({ kinfolk: household() }));

    expect(first).toEqual({ kinfolkId: 'auto-1', duplicateOf: null });
    expect(second).toEqual({ kinfolkId: 'auto-1', duplicateOf: 'auto-1' });
    expect(mock.writes).toHaveLength(1);
  });

  // #890 test admins. A sandbox test admin carries `testTribeId` and no `admin`
  // claim. The old direct Add used an auto id, which the rules refuse for a test
  // admin (test/rules/kinfolkProfile.test.ts proves it), so createKinfolk keeps
  // that: staff only, and a test admin is refused before anything is read.
  it('refuses a sandbox test admin through the deployed export, as the auto-id direct create it replaces did', async () => {
    const mock = buildDbMock({ queryDocs: { kinfolk: [] } });
    mocks.dbFn.mockReturnValue(mock.db);
    const req = { data: { kinfolk: household() }, auth: { uid: 'test-admin-uid', token: { testTribeId: 'kin-test' } }, rawRequest: {} };
    const run = (createKinfolk as unknown as { run: (r: unknown) => Promise<unknown> }).run;
    await expect(run(req)).rejects.toMatchObject({ code: 'permission-denied' });
    // The wrapper records the refusal in its own failure log; nothing reaches kinfolk.
    expect(mock.writes.filter((w) => w.path.startsWith('kinfolk/'))).toHaveLength(0);
    expect(mock.adds.filter((a) => a.collection === 'kinfolk')).toHaveLength(0);
  });

  it('exports the request and response shapes the three admin clients mirror', () => {
    expect(Args.safeParse({ kinfolk: household() }).success).toBe(true);
    expect(Args.safeParse({ kinfolk: household(), extra: 1 }).success).toBe(false);
    expect(Result.safeParse({ kinfolkId: 'a', duplicateOf: null }).success).toBe(true);
    expect(Result.safeParse({ kinfolkId: 'a' }).success).toBe(false);
  });
});
