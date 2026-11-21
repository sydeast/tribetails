import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
});

/**
 * #2350: a visit or KinTale stored under a Kin's household card id is put back
 * on the id the admin screens look the Kin up by.
 *
 * Household 3 has:
 *   Biscuit  card fam-a, admin record flat-a   (two ids)
 *   Gravy    card fam-b, admin record flat-b   (two ids)
 *   Old Boy  card fam-c, admin record flat-c   (two ids, passed)
 *   Pepper   card both-p = admin record both-p (one id: the office made her)
 *   Office Cat admin record flat-f, no card
 */
function homeDocs(): Record<string, Record<string, unknown> | null> {
  return {
    'families/3/kin/fam-a': { name: 'Biscuit', legacyKinId: 'flat-a' },
    'families/3/kin/fam-b': { name: 'Gravy', legacyKinId: 'flat-b' },
    'families/3/kin/fam-c': { name: 'Old Boy', status: 'noLongerWithUs', legacyKinId: 'flat-c' },
    'families/3/kin/both-p': { name: 'Pepper', legacyKinId: 'both-p' },
    'kin/flat-a': { name: 'Biscuit', kinfolkId: '3' },
    'kin/flat-b': { name: 'Gravy', kinfolkId: '3' },
    'kin/flat-c': { name: 'Old Boy', kinfolkId: '3' },
    'kin/both-p': { name: 'Pepper', kinfolkId: '3' },
    'kin/flat-f': { name: 'Office Cat', kinfolkId: '3' },
  };
}

const ALIASES = new Map([
  ['fam-a', 'flat-a'],
  ['fam-b', 'flat-b'],
  ['fam-c', 'flat-c'],
]);

describe('kinIdAliases', () => {
  it('maps each card id to the stored id, memorial Kin included, and leaves one-id Kin out', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: homeDocs(), writeThrough: true }).db);
    const { kinIdAliases, readHouseholdKin } = await import('../src/lib/kinRoster');
    expect(kinIdAliases(await readHouseholdKin('3'))).toEqual(ALIASES);
  });

  it('never maps a card id that is also another Kin stored id', async () => {
    const { kinIdAliases } = await import('../src/lib/kinRoster');
    expect(
      kinIdAliases([
        { id: 'flat-a', householdId: 'x', name: 'A', active: true },
        { id: 'x', householdId: null, name: 'X', active: true },
      ]),
    ).toEqual(new Map());
  });
});

describe('planVisitKinIds (pure)', () => {
  it('replaces each card id in place and keeps the order kinNames is paired by', async () => {
    const { planVisitKinIds } = await import('../src/lib/visitKinIds');
    expect(
      planVisitKinIds({ kinIds: ['fam-b', 'flat-f', 'fam-a'], kinNames: ['Gravy', 'Office Cat', 'Biscuit'] }, ALIASES),
    ).toEqual({ kind: 'rewrite', update: { kinIds: ['flat-b', 'flat-f', 'flat-a'] } });
  });

  it('moves the old single kinId too', async () => {
    const { planVisitKinIds } = await import('../src/lib/visitKinIds');
    expect(planVisitKinIds({ kinId: 'fam-a', kinIds: ['fam-a'] }, ALIASES)).toEqual({
      kind: 'rewrite',
      update: { kinIds: ['flat-a'], kinId: 'flat-a' },
    });
    expect(planVisitKinIds({ kinId: 'fam-a' }, ALIASES)).toEqual({ kind: 'rewrite', update: { kinId: 'flat-a' } });
  });

  it('keeps a Kin named under both of its ids once, and drops its paired name with it', async () => {
    const { planVisitKinIds } = await import('../src/lib/visitKinIds');
    expect(
      planVisitKinIds({ kinIds: ['flat-a', 'fam-a', 'fam-b'], kinNames: ['Biscuit', 'Biscuit', 'Gravy'] }, ALIASES),
    ).toEqual({ kind: 'rewrite', update: { kinIds: ['flat-a', 'flat-b'], kinNames: ['Biscuit', 'Gravy'] } });
  });

  it('leaves kinNames alone when it is not paired one to one', async () => {
    const { planVisitKinIds } = await import('../src/lib/visitKinIds');
    expect(planVisitKinIds({ kinIds: ['flat-a', 'fam-a'], kinNames: ['Biscuit'] }, ALIASES)).toEqual({
      kind: 'rewrite',
      update: { kinIds: ['flat-a'] },
    });
  });

  it('plans nothing for a document that names no card id, or when the household has no aliases', async () => {
    const { planVisitKinIds } = await import('../src/lib/visitKinIds');
    expect(planVisitKinIds({ kinIds: ['flat-a', 'flat-f', 'gone'] }, ALIASES)).toEqual({ kind: 'none' });
    expect(planVisitKinIds({ kinIds: [] }, ALIASES)).toEqual({ kind: 'none' });
    expect(planVisitKinIds({}, ALIASES)).toEqual({ kind: 'none' });
    expect(planVisitKinIds({ kinIds: ['fam-a'] }, new Map())).toEqual({ kind: 'none' });
  });

  it('refuses a KinTale whose per-Kin answers or moods name the card id, so they stay with their Kin', async () => {
    const { planVisitKinIds } = await import('../src/lib/visitKinIds');
    const keyed = { kinIds: ['fam-a'], fieldResponses: { 'fam-a|walk': { fieldKey: 'walk', kinId: 'fam-a', boolValue: true } } };
    expect(planVisitKinIds(keyed, ALIASES)).toEqual({ kind: 'refuse', reason: 'card-id-elsewhere', cardIds: ['fam-a'] });
    expect(planVisitKinIds({ kinIds: ['fam-b'], kinMoods: { 'fam-b': 'happy' } }, ALIASES)).toEqual({
      kind: 'refuse',
      reason: 'card-id-elsewhere',
      cardIds: ['fam-b'],
    });
  });
});

describe('planHouseholdVisitKinIds + applyHouseholdVisitKinIds (the script\'s write)', () => {
  function world() {
    const docs = homeDocs();
    docs['kin_care_sessions/old'] = { kinfolkId: '3', kinIds: ['fam-a', 'fam-b'], kinNames: ['Biscuit', 'Gravy'], status: 'SCHEDULED' };
    docs['kin_care_sessions/new'] = { kinfolkId: '3', kinIds: ['flat-a', 'flat-b'], kinNames: ['Biscuit', 'Gravy'] };
    docs['kin_care_sessions/passed'] = { kinfolkId: '3', kinIds: ['fam-c'], kinNames: ['Old Boy'], status: 'COMPLETED' };
    docs['kin_care_sessions/other-home'] = { kinfolkId: '9', kinIds: ['fam-a'] };
    docs['kin_care_reports/tale'] = { kinfolkId: '3', kinIds: ['fam-a'], status: 'SENT', bodyCopy: 'A good walk.' };
    docs['kin_care_reports/answered'] = {
      kinfolkId: '3',
      kinIds: ['fam-b'],
      fieldResponses: { 'fam-b|walk': { fieldKey: 'walk', kinId: 'fam-b', boolValue: true } },
    };
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    return { ctx, docs };
  }

  /** What the script does for one household: plan, then apply. */
  async function rewriteHousehold(kinfolkId: string) {
    const { planHouseholdVisitKinIds, applyHouseholdVisitKinIds } = await import('../src/lib/visitKinIds');
    const plan = await planHouseholdVisitKinIds(kinfolkId);
    return { ...plan, ...(await applyHouseholdVisitKinIds(plan)) };
  }

  it('rewrites the household visits and KinTales, touches nothing else, and lists the one it cannot move', async () => {
    const { ctx, docs } = world();

    const done = await rewriteHousehold('3');

    expect(done.written).toBe(3);
    expect(done.refusals).toEqual([{ collection: 'kin_care_reports', docId: 'answered', cardIds: ['fam-b'], reason: 'card-id-elsewhere' }]);
    expect(docs['kin_care_sessions/old']).toEqual({
      kinfolkId: '3',
      kinIds: ['flat-a', 'flat-b'],
      kinNames: ['Biscuit', 'Gravy'],
      status: 'SCHEDULED',
    });
    // A Kin who has since passed is still found on the visit she was on.
    expect(docs['kin_care_sessions/passed']?.['kinIds']).toEqual(['flat-c']);
    expect(docs['kin_care_reports/tale']).toEqual({ kinfolkId: '3', kinIds: ['flat-a'], status: 'SENT', bodyCopy: 'A good walk.' });
    // Another household's visit, the one already right, and the refused tale are untouched.
    expect(docs['kin_care_sessions/other-home']?.['kinIds']).toEqual(['fam-a']);
    expect(docs['kin_care_reports/answered']?.['kinIds']).toEqual(['fam-b']);
    const written = ctx.writes.map((w) => w.path).sort();
    expect(written).toEqual(['kin_care_reports/tale', 'kin_care_sessions/old', 'kin_care_sessions/passed']);
    // Each write is kinIds (and kinId) only: no status, no calendar field, nothing a trigger answers.
    for (const w of ctx.writes) expect(Object.keys(w.data).sort()).toEqual(['kinIds']);
  });

  it('is idempotent: a second pass plans and writes nothing new', async () => {
    const { ctx } = world();
    await rewriteHousehold('3');
    const after = ctx.writes.length;

    const again = await rewriteHousehold('3');

    expect(again.writes).toEqual([]);
    expect(again.written).toBe(0);
    expect(ctx.writes.length).toBe(after);
  });

  it('reads nothing past the Kin when the household has no Kin with two ids', async () => {
    const ctx = buildDbMock({
      docs: { 'kin/flat-f': { name: 'Office Cat', kinfolkId: '3' }, 'kin_care_sessions/s': { kinfolkId: '3', kinIds: ['flat-f'] } },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const done = await rewriteHousehold('3');

    expect(done).toMatchObject({ scanned: 0, written: 0, writes: [], refusals: [] });
    expect(ctx.writes).toEqual([]);
  });

  it('never moves a visit while two cards claim one record: lists it and leaves it', async () => {
    // A crossed pair. Rex's card came first and owns rec-1 (`lib/kinLink.ts`:
    // the card created first keeps the record). Rover's card was later tied to
    // the same record. Rover's card id sorts first, so the roster reader hands
    // Rover the record and lists Rex under his card id. Moving Rover's old
    // visit onto rec-1 would put it on Rex.
    const ctx = buildDbMock({
      docs: {
        'families/5/kin/aa-rover': { name: 'Rover', legacyKinId: 'rec-1', createdAt: new Date('2026-10-02T00:00:00Z') },
        'families/5/kin/zz-rex': { name: 'Rex', legacyKinId: 'rec-1', createdAt: new Date('2026-09-01T00:00:00Z') },
        'families/5/kin/fam-tib': { name: 'Tibbs', legacyKinId: 'rec-tib' },
        'kin/rec-1': { name: 'Rover', kinfolkId: '5', familyKinPath: 'families/5/kin/aa-rover' },
        'kin/rec-tib': { name: 'Tibbs', kinfolkId: '5' },
        'kin_care_sessions/rover-old': { kinfolkId: '5', kinIds: ['aa-rover'], kinNames: ['Rover'] },
        'kin_care_sessions/rex-old': { kinfolkId: '5', kinIds: ['zz-rex'], kinNames: ['Rex'] },
        'kin_care_sessions/tibbs-old': { kinfolkId: '5', kinIds: ['fam-tib'], kinNames: ['Tibbs'] },
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { planHouseholdVisitKinIds } = await import('../src/lib/visitKinIds');

    const plan = await planHouseholdVisitKinIds('5');

    // The Kin no other card contests still moves.
    expect(plan.writes).toEqual([{ collection: 'kin_care_sessions', docId: 'tibbs-old', update: { kinIds: ['rec-tib'] } }]);
    expect(plan.aliases).toEqual(new Map([['fam-tib', 'rec-tib']]));
    expect(plan.refusals).toEqual([
      { collection: 'kin_care_sessions', docId: 'rover-old', cardIds: ['aa-rover'], reason: 'crossed-link' },
      { collection: 'kin_care_sessions', docId: 'rex-old', cardIds: ['zz-rex'], reason: 'crossed-link' },
    ]);
  });

  it('re-plans inside the write, so a visit put right meanwhile is left alone', async () => {
    const { docs } = world();
    const { planHouseholdVisitKinIds, applyHouseholdVisitKinIds } = await import('../src/lib/visitKinIds');
    const plan = await planHouseholdVisitKinIds('3');
    docs['kin_care_sessions/old'] = { kinfolkId: '3', kinIds: ['flat-a', 'flat-b'] };

    const outcome = await applyHouseholdVisitKinIds(plan);

    expect(outcome).toEqual({ written: 2, skippedOnRecheck: 1 });
  });

  it('writes nothing for the household when its links changed since the plan', async () => {
    const { ctx, docs } = world();
    const { planHouseholdVisitKinIds, applyHouseholdVisitKinIds } = await import('../src/lib/visitKinIds');
    const plan = await planHouseholdVisitKinIds('3');
    // Gravy's card is tied to another record between the plan and the write.
    docs['kin/flat-b2'] = { name: 'Gravy', kinfolkId: '3' };
    docs['families/3/kin/fam-b'] = { name: 'Gravy', legacyKinId: 'flat-b2' };

    expect(await applyHouseholdVisitKinIds(plan)).toEqual({ written: 0, skippedOnRecheck: 3 });
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_'))).toEqual([]);
  });

  it('after a link, logs what the script would change and writes nothing', async () => {
    const { ctx, docs } = world();
    const before = JSON.parse(JSON.stringify(docs));
    const { recordVisitKinIdsAfterLink } = await import('../src/lib/visitKinIds');

    await recordVisitKinIdsAfterLink('3', 'onFamilyKinWrite');

    expect(ctx.writes).toEqual([]);
    expect(JSON.parse(JSON.stringify(docs))).toEqual(before);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'kin.visitIds.planned',
        extra: expect.objectContaining({
          kinfolkId: '3',
          toWrite: 3,
          refusedCount: 1,
          docs: ['kin_care_sessions/old', 'kin_care_sessions/passed', 'kin_care_reports/tale'],
          refused: ['kin_care_reports/answered card-id-elsewhere'],
          aliases: { 'fam-a': 'flat-a', 'fam-b': 'flat-b', 'fam-c': 'flat-c' },
        }),
      }),
    );
  });

  it('after a link, never throws when the household cannot be read', async () => {
    mocks.dbFn.mockImplementation(() => {
      throw new Error('firestore down');
    });
    const { recordVisitKinIdsAfterLink } = await import('../src/lib/visitKinIds');
    await expect(recordVisitKinIdsAfterLink('3', 'onFamilyKinWrite')).resolves.toBeUndefined();
    expect(mocks.logEvent).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'kin.visitIds.plan_failed' }));
  });
});
