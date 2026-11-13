import { describe, it, expect, vi } from 'vitest';
import { buildDbMock } from '../../functions/test/_helpers/mockDb';
import {
  parseArgs,
  resolveMode,
  classify,
  summarize,
  reportLines,
  buildRows,
  applyRows,
} from '../backfillHouseholdMembers';
import { assertPrimaryLinkAllowed, planPrimaryLink, writePrimaryMember } from '../lib/householdPrimary';
import { linkTesterLogin, planLinkUidWrite, DEMO_FAMILY_IDS } from '../seedDemoKinfolk';
import { run as enableSandboxLogin, TEST_TRIBE_ID, TEST_ADMIN_UID, TEST_ADMIN_EMAIL } from '../qa_enable_sandbox_login';
import { planAllWrites, assertAllScoped, sandboxMemberPath } from '../seed_test_sandbox';

/**
 * #2096: every script that attaches a login to a household writes the member
 * record a real invite acceptance writes, and the after-release backfill
 * writes it for logins linked before the member model. Firestore is the
 * in-memory mock with writes visible to later reads; Auth is a stub.
 */

type Claims = Record<string, unknown>;
function fakeAuth(users: Record<string, { email?: string; customClaims?: Claims } | undefined>) {
  return {
    getUser: vi.fn(async (uid: string) => {
      const u = users[uid];
      if (!u) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
      return u;
    }),
    getUserByEmail: vi.fn(async (email: string) => {
      if (email !== TEST_ADMIN_EMAIL) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
      return { uid: TEST_ADMIN_UID };
    }),
    updateUser: vi.fn(async () => ({})),
  };
}

function db(docs: Record<string, Record<string, unknown>>) {
  return buildDbMock({ writeThrough: true, docs });
}

const KIN = { email: 'catch@hanasamku.com', customClaims: { role: 'kinfolk' } };
const ADMIN = { email: 'e2e-admin@tribetails.com', customClaims: { admin: true } };

describe('lib/householdPrimary', () => {
  it('HAPPY: plans and writes the ACTIVE PRIMARY record, marked with the caller\'s extra field', async () => {
    const ctx = db({ 'families/k1': {} });
    const deps = { db: ctx.db as never, auth: fakeAuth({ u1: KIN }) as never };
    const plan = await planPrimaryLink(deps, 'k1', 'u1');
    expect(await writePrimaryMember(deps.db, 'k1', 'u1', plan, 'NOW', { _demo: true })).toBe(true);
    const w = ctx.writes.find((x) => x.path === 'families/k1/members/u1');
    expect(w?.data).toMatchObject({ role: 'PRIMARY', status: 'ACTIVE', displayName: 'catch@hanasamku.com', _demo: true });
  });

  it('NEGATIVE: a refusal throws plain words and writes nothing', async () => {
    const ctx = db({ 'families/k1': {} });
    const deps = { db: ctx.db as never, auth: fakeAuth({ u1: ADMIN }) as never };
    const plan = await planPrimaryLink(deps, 'k1', 'u1');
    expect(() => assertPrimaryLinkAllowed(plan)).toThrow(/staff login/);
    await expect(writePrimaryMember(deps.db, 'k1', 'u1', plan, 'NOW')).rejects.toThrow(/staff login/);
    expect(ctx.writes).toEqual([]);
  });

  it('ERROR: a record that appeared after the plan is never overwritten', async () => {
    const ctx = db({ 'families/k1': {} });
    const deps = { db: ctx.db as never, auth: fakeAuth({ u1: KIN }) as never };
    const plan = await planPrimaryLink(deps, 'k1', 'u1');
    await ctx.db.doc('families/k1/members/u1').set({ role: 'SECONDARY', status: 'ACTIVE' });
    await expect(writePrimaryMember(deps.db, 'k1', 'u1', plan, 'NOW')).rejects.toBeTruthy();
  });
});

describe('seedDemoKinfolk --link-uid', () => {
  const FAM = DEMO_FAMILY_IDS[0];

  it('HAPPY: lists the household on the login and writes its member record', async () => {
    const ctx = db({ [`families/${FAM}`]: {} });
    const wrote = await linkTesterLogin(
      { db: ctx.db as never, auth: fakeAuth({ t1: KIN }) as never },
      't1',
      planLinkUidWrite('t1'),
      'NOW',
    );
    expect(wrote).toBe(true);
    expect(ctx.writes.map((w) => w.path)).toEqual(['clients/t1', `families/${FAM}/members/t1`]);
  });

  it('HAPPY: re-running repairs a login linked before (#2096) and then is a no-op', async () => {
    const ctx = db({ [`families/${FAM}`]: {}, 'clients/t1': { kinfolkIds: [FAM], _demo: true } });
    const deps = { db: ctx.db as never, auth: fakeAuth({ t1: KIN }) as never };
    expect(await linkTesterLogin(deps, 't1', planLinkUidWrite('t1'), 'NOW')).toBe(true);
    expect(await linkTesterLogin(deps, 't1', planLinkUidWrite('t1'), 'NOW')).toBe(false);
  });

  it('NEGATIVE (#1840): refuses the Admin\'s own login and links nothing', async () => {
    const ctx = db({ [`families/${FAM}`]: {} });
    await expect(
      linkTesterLogin({ db: ctx.db as never, auth: fakeAuth({ a1: ADMIN }) as never }, 'a1', planLinkUidWrite('a1'), 'NOW'),
    ).rejects.toThrow(/staff login/);
    expect(ctx.writes).toEqual([]);
  });

  it('SAD: refuses before the demo household exists', async () => {
    const ctx = db({});
    await expect(
      linkTesterLogin({ db: ctx.db as never, auth: fakeAuth({ t1: KIN }) as never }, 't1', planLinkUidWrite('t1'), 'NOW'),
    ).rejects.toThrow(/no portal record/);
    expect(ctx.writes).toEqual([]);
  });
});

describe('qa_enable_sandbox_login run()', () => {
  const sandbox = { email: TEST_ADMIN_EMAIL, customClaims: { testTribeId: TEST_TRIBE_ID } };

  it('HAPPY: links, writes the member record, then sets the password', async () => {
    const ctx = db({ [`families/${TEST_TRIBE_ID}`]: {} });
    const auth = fakeAuth({ [TEST_ADMIN_UID]: sandbox });
    await enableSandboxLogin({ db: ctx.db as never, auth: auth as never }, { writePasswordFile: () => '/dev/null' });
    expect(ctx.writes.map((w) => w.path)).toEqual([
      `clients/${TEST_ADMIN_UID}`,
      `families/${TEST_TRIBE_ID}/members/${TEST_ADMIN_UID}`,
    ]);
    expect(ctx.writes[1]!.data).toMatchObject({ role: 'PRIMARY', status: 'ACTIVE', isTestData: true });
    expect(auth.updateUser).toHaveBeenCalled();
  });

  it('NEGATIVE: a sandbox login that has become staff is refused before any write or password change', async () => {
    const ctx = db({ [`families/${TEST_TRIBE_ID}`]: {} });
    const auth = fakeAuth({ [TEST_ADMIN_UID]: { customClaims: { staffRole: 'auntie' } } });
    await expect(
      enableSandboxLogin({ db: ctx.db as never, auth: auth as never }, { writePasswordFile: () => '/dev/null' }),
    ).rejects.toThrow(/staff login/);
    expect(ctx.writes).toEqual([]);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

describe('seed_test_sandbox plan', () => {
  it('HAPPY: plans the sandbox login\'s ACTIVE PRIMARY record, scoped and flagged as test data', () => {
    const writes = planAllWrites(new Date('2026-07-09T12:00:00Z'));
    const m = writes.find((w) => w.path === sandboxMemberPath(TEST_ADMIN_UID));
    expect(m?.data).toMatchObject({
      uid: TEST_ADMIN_UID,
      role: 'PRIMARY',
      status: 'ACTIVE',
      displayName: TEST_ADMIN_EMAIL,
      isTestData: true,
    });
    expect(() => assertAllScoped(writes)).not.toThrow();
  });

  it('NEGATIVE: the member path follows the actual uid, and a stray member path is refused', () => {
    const alt = planAllWrites(new Date('2026-07-09T12:00:00Z'), 'otherUid');
    expect(alt.some((w) => w.path === sandboxMemberPath('otherUid'))).toBe(true);
    expect(() => assertAllScoped(alt, TEST_ADMIN_UID)).toThrow();
  });
});

describe('backfillHouseholdMembers', () => {
  describe('args and mode', () => {
    it('defaults to a dry run that still needs --allow-prod for a real project', () => {
      const a = parseArgs([]);
      expect(a).toEqual({ apply: false, allowProd: false, projectId: null });
      expect(() => resolveMode(a, { emulator: false })).toThrow(/--allow-prod/);
      expect(resolveMode(a, { emulator: true })).toBe('dry-run');
    });

    it('writes only with --allow-prod AND --apply', () => {
      expect(resolveMode(parseArgs(['--allow-prod']), { emulator: false })).toBe('dry-run');
      expect(() => resolveMode(parseArgs(['--apply']), { emulator: false })).toThrow(/--allow-prod/);
      expect(resolveMode(parseArgs(['--apply', '--allow-prod']), { emulator: false })).toBe('apply');
    });

    it('takes a project, and refuses an unknown flag or a valueless project', () => {
      expect(parseArgs(['--project', 'p1']).projectId).toBe('p1');
      expect(parseArgs(['--project=p2']).projectId).toBe('p2');
      expect(() => parseArgs(['--project', '--apply'])).toThrow(/requires a value/);
      expect(() => parseArgs(['--yes'])).toThrow(/unknown arg/);
    });
  });

  function seedHouseholds() {
    return db({
      // A legacy primary: stored login, listed by its own client record, no member record.
      'kinfolk/h-legacy': { uid: 'u-legacy' },
      'families/h-legacy': {},
      'clients/u-legacy': { kinfolkIds: ['h-legacy'] },
      // Already a member.
      'kinfolk/h-member': { uid: 'u-member' },
      'families/h-member': {},
      'families/h-member/members/u-member': { role: 'PRIMARY', status: 'ACTIVE' },
      'clients/u-member': { kinfolkIds: ['h-member'] },
      // The #1840 shape: the Admin's login on a demo household.
      'kinfolk/h-demo': { uid: 'u-admin' },
      'families/h-demo': {},
      'clients/u-admin': { kinfolkIds: ['h-demo'] },
      // A stored login whose client record does not list the household.
      'kinfolk/h-stale': { uid: 'u-stale' },
      'families/h-stale': {},
      // A removed member.
      'kinfolk/h-removed': { uid: 'u-removed' },
      'families/h-removed': {},
      'families/h-removed/members/u-removed': { role: 'PRIMARY', status: 'SUSPENDED' },
      'clients/u-removed': { kinfolkIds: ['h-removed'] },
      // No login at all.
      'kinfolk/h-none': { uid: '' },
    });
  }
  const users = {
    'u-legacy': KIN,
    'u-member': KIN,
    'u-admin': ADMIN,
    'u-stale': KIN,
    'u-removed': KIN,
  };

  it('HAPPY: dry run classifies every household and writes nothing', async () => {
    const ctx = seedHouseholds();
    const { scanned, rows } = await buildRows({ db: ctx.db as never, auth: fakeAuth(users) as never });
    expect(scanned).toBe(6);
    const by = Object.fromEntries(rows.map((r) => [r.familyId, r.outcome]));
    expect(by).toEqual({
      'h-legacy': { kind: 'write' },
      'h-member': { kind: 'already_member' },
      'h-demo': { kind: 'refused', why: 'staff_login' },
      'h-stale': { kind: 'not_listed' },
      'h-removed': { kind: 'refused', why: 'member_record_not_active' },
    });
    expect(summarize(scanned, rows)).toEqual({
      scanned: 6,
      withLogin: 5,
      write: 1,
      alreadyMember: 1,
      notListed: 1,
      refused: { staff_login: 1, member_record_not_active: 1 },
    });
    expect(ctx.writes).toEqual([]);
  });

  it('NEGATIVE: the report names households and reasons, never a login id, email or name', async () => {
    const ctx = seedHouseholds();
    const { scanned, rows } = await buildRows({ db: ctx.db as never, auth: fakeAuth(users) as never });
    const text = reportLines(summarize(scanned, rows), rows, 'dry-run').join('\n');
    expect(text).toContain('h-legacy');
    expect(text).toContain('h-demo  staff_login');
    expect(text).not.toMatch(/u-legacy|u-admin|u-removed|@/);
  });

  it('HAPPY: apply writes only the legacy primary, and a second run has nothing to write', async () => {
    const ctx = seedHouseholds();
    const deps = { db: ctx.db as never, auth: fakeAuth(users) as never };
    const first = await buildRows(deps);
    expect(await applyRows(deps.db, first.rows, 'NOW')).toEqual({ written: 1, alreadyThere: 0 });
    expect(ctx.writes.map((w) => w.path)).toEqual(['families/h-legacy/members/u-legacy']);
    expect(ctx.writes[0]!.data).toMatchObject({
      role: 'PRIMARY',
      status: 'ACTIVE',
      createdBy: 'backfillHouseholdMembers',
    });

    const second = await buildRows(deps);
    expect(summarize(second.scanned, second.rows).write).toBe(0);
    expect(await applyRows(deps.db, second.rows, 'NOW')).toEqual({ written: 0, alreadyThere: 0 });
  });

  it('ERROR: a record that appeared between scan and write is counted, not overwritten', async () => {
    const ctx = seedHouseholds();
    const deps = { db: ctx.db as never, auth: fakeAuth(users) as never };
    const { rows } = await buildRows(deps);
    await ctx.db.doc('families/h-legacy/members/u-legacy').set({ role: 'SECONDARY', status: 'ACTIVE' });
    expect(await applyRows(deps.db, rows, 'NOW')).toEqual({ written: 0, alreadyThere: 1 });
    expect((await ctx.db.doc('families/h-legacy/members/u-legacy').get()).data()).toMatchObject({ role: 'SECONDARY' });
  });

  it('ERROR: a failed read stops the run', async () => {
    const ctx = seedHouseholds();
    const auth = { getUser: vi.fn(async () => Promise.reject(Object.assign(new Error('auth down'), { code: 'x' }))) };
    await expect(buildRows({ db: ctx.db as never, auth: auth as never })).rejects.toThrow('auth down');
  });

  it('classify: a create decision on an unlisted login is left alone', () => {
    expect(
      classify({
        decision: { action: 'create_primary' },
        facts: {
          householdExists: true,
          loginExists: true,
          email: null,
          memberStatus: null,
          activePrimaryUids: [],
          isStaff: false,
          listedOnHousehold: false,
          otherHouseholds: [],
        },
      }),
    ).toEqual({ kind: 'not_listed' });
  });
});
