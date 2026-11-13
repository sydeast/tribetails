import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1839, lead decision: one line per LOOK, not per read. Opening a household
 * profile fires several reads at once; the walk counted four lines for one
 * look. These run the real handlers through the real `writeAuditEntry` (its
 * transaction, its fixed-id existence check and its `create` backstop) over
 * the in-memory store, and count the lines that land in `activity_log`.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveStaffIdentities: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/staffIdentity', () => ({ resolveStaffIdentities: mocks.resolveStaffIdentities }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' } };
});

const OWNER = { uid: 'owner-uid', token: { admin: true } };
const AUNTIE = { uid: 'aunt-uid', token: { staffRole: 'auntie' } };
const T0 = Date.UTC(2026, 10, 13, 15, 2, 0);

function store() {
  return buildDbMock({
    writeThrough: true,
    docs: {
      'clients/owner-uid': null,
      'clients/aunt-uid': null,
      'kinfolk/fam1': { firstName: 'Dre', lastName: 'East' },
      'families/fam1': { displayName: 'Dre East' },
    },
    queryDocs: { 'families/fam1/members': [], 'families/fam1/secondaryKinfolk': [] },
  });
}

/** The look lines that landed, whatever id they were stored under. */
const lookLines = (ctx: ReturnType<typeof store>) =>
  ctx.writes.filter(
    (w) => w.path.startsWith('activity_log/') && (w.data as Record<string, unknown>)['actionType'] === 'OPERATOR_CROSSTENANT_ACCESS',
  );

async function openProfile(auth: typeof AUNTIE | typeof OWNER): Promise<void> {
  const [{ listMembersHandler }, { listSecondaryKinfolkHandler }, { listEmergencyContactsHandler }] = await Promise.all([
    import('../src/portal/listMembers'),
    import('../src/portal/secondaryKinfolk'),
    import('../src/portal/emergencyContacts'),
  ]);
  const req = { data: { kinfolkId: 'fam1' }, auth } as never;
  // One screen open: three reads at once. Each may fail later on the thin
  // fixture; the household is resolved, and the line decided, before that.
  await Promise.all([
    listMembersHandler(req).catch(() => undefined),
    listSecondaryKinfolkHandler(req).catch(() => undefined),
    listEmergencyContactsHandler(req).catch(() => undefined),
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.dbFn.mockReset();
  mocks.resolveStaffIdentities.mockReset();
  mocks.resolveStaffIdentities.mockResolvedValue([
    { uid: 'aunt-uid', displayName: 'Jane Rivers', email: null, hasStaffRecord: true },
  ]);
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('#1839 one line per look', () => {
  it('three concurrent reads on one screen open write ONE line, in plain words', async () => {
    const ctx = store();
    mocks.dbFn.mockReturnValue(ctx.db);
    await openProfile(AUNTIE);
    const lines = lookLines(ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toMatchObject({
      description: 'Jane Rivers looked at Kinfolk Dre East',
      actorId: 'aunt-uid',
      targetId: 'fam1',
      familyId: 'fam1',
      payload: expect.objectContaining({ kinfolkId: 'fam1', admin: false, staffRole: 'auntie' }),
    });
  });

  it('opening the profile again inside the window adds nothing', async () => {
    const ctx = store();
    mocks.dbFn.mockReturnValue(ctx.db);
    await openProfile(AUNTIE);
    vi.setSystemTime(T0 + 5 * 60 * 1000);
    await openProfile(AUNTIE);
    expect(lookLines(ctx)).toHaveLength(1);
  });

  it('a read after the window writes a second line', async () => {
    const ctx = store();
    mocks.dbFn.mockReturnValue(ctx.db);
    await openProfile(AUNTIE);
    vi.setSystemTime(T0 + 10 * 60 * 1000);
    await openProfile(AUNTIE);
    const lines = lookLines(ctx);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.path)).size).toBe(2);
  });

  it("the owner's screen open still writes no line", async () => {
    const ctx = store();
    mocks.dbFn.mockReturnValue(ctx.db);
    await openProfile(OWNER);
    vi.setSystemTime(T0 + 30 * 60 * 1000);
    await openProfile(OWNER);
    expect(lookLines(ctx)).toEqual([]);
  });
});
