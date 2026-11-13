import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from '../../functions/test/_helpers/mockDb';

// #1912: the repair for household Kin the old mirror tied to another Kin's
// admin record. The plan is read with the mirror's own check; the apply is a
// touch that the deployed mirror turns into the repair, so the last tests run
// that mirror on the touched doc the way the trigger would.

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../../functions/src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../../functions/src/lib/logger', () => ({ logEvent: vi.fn() }));

import { parseArgs, buildPlan, applyPlan } from '../repairCrossedKinLinks';
import { mirrorFamilyKinToFlat } from '../../functions/src/triggers/onFamilyKinWrite';

type Docs = Record<string, Record<string, unknown>>;

const HOUSEHOLD = '3';
const OLD_PATH = `families/${HOUSEHOLD}/kin/old`;
const NEW_PATH = `families/${HOUSEHOLD}/kin/new`;
const day = (n: number) => new Date(Date.UTC(2026, 9, n));

const OLD_FAMILY = { name: 'Max', species: 'Dog', status: 'archived', legacyKinId: 'flatOld', familyKinPath: OLD_PATH, createdAt: day(1), createdByUid: 'u1' };
const OLD_FLAT = { name: 'Max', species: 'Dog', kinfolkId: HOUSEHOLD, status: 'archived', familyKinPath: OLD_PATH, legacyKinId: 'flatOld', officeNotes: 'older dog', createdAt: day(1) };
const NEW_FAMILY = { name: 'Max', species: 'Bird', status: 'active', createdAt: day(10), createdByUid: 'u1' };

/** The state the defect left: the new Kin on the archived Kin's record, which now points at it. */
function crossed(): Docs {
  return {
    [OLD_PATH]: { ...OLD_FAMILY },
    [NEW_PATH]: { ...NEW_FAMILY, legacyKinId: 'flatOld', familyKinPath: NEW_PATH },
    'kin/flatOld': { ...OLD_FLAT, species: 'Bird', familyKinPath: NEW_PATH },
  };
}

/** A household where nothing is wrong: two Kin, each on its own record. */
function healthy(): Docs {
  return {
    'families/7/kin/a': { name: 'Kai', status: 'active', legacyKinId: 'flatA', familyKinPath: 'families/7/kin/a', createdAt: day(2) },
    'kin/flatA': { name: 'Kai', kinfolkId: '7', status: 'active', familyKinPath: 'families/7/kin/a', legacyKinId: 'flatA', createdAt: day(2) },
    'families/7/kin/b': { name: 'Lulu', status: 'active', createdAt: day(3) },
  };
}

/** A mock whose collectionGroup('kin') lists every kin doc in `docs`, flat and family. */
function world(docs: Docs) {
  const rows = Object.entries(docs)
    .filter(([p]) => /^(kin\/[^/]+|families\/[^/]+\/kin\/[^/]+)$/.test(p))
    .map(([p, data]) => ({ id: p.split('/').pop()!, path: p, data }));
  const ctx = buildDbMock({ writeThrough: true, docs, collectionGroupDocs: { kin: rows } });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

beforeEach(() => mocks.dbFn.mockReset());

describe('repairCrossedKinLinks: parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });
  it('--allow-prod applies, and --dry-run beats it in either order', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  it('--project takes a value and refuses a flag as one; an unknown arg is refused', () => {
    expect(parseArgs(['--project', 'p1']).projectId).toBe('p1');
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow('--project requires a value');
    expect(() => parseArgs(['--apply'])).toThrow('unknown arg');
  });
});

describe('repairCrossedKinLinks: the plan (#1912)', () => {
  it('lists the new Kin tied to the archived Kin\'s record, once, and nothing else', async () => {
    const ctx = world({ ...crossed(), ...healthy() });
    const { summary, crossed: plan } = await buildPlan(ctx.db as any);
    expect(plan).toEqual([{ path: NEW_PATH, kinfolkId: HOUSEHOLD, kinId: 'new', flatId: 'flatOld', ownerKinId: 'old' }]);
    expect(summary).toEqual({ scanned: 6, flatSkipped: 2, linked: 2, noRecord: 1, foreign: 0, crossed: 1 });
  });

  it('a record only the office held: the new Kin is planned, kept by no household Kin', async () => {
    const ctx = world({
      [NEW_PATH]: { ...NEW_FAMILY, legacyKinId: 'flatOld', familyKinPath: NEW_PATH },
      'kin/flatOld': { name: 'Max', species: 'Bird', kinfolkId: HOUSEHOLD, status: 'archived', familyKinPath: NEW_PATH, legacyKinId: 'flatOld', createdAt: day(1) },
    });
    const { crossed: plan } = await buildPlan(ctx.db as any);
    expect(plan).toEqual([{ path: NEW_PATH, kinfolkId: HOUSEHOLD, kinId: 'new', flatId: 'flatOld', ownerKinId: null }]);
  });

  it('two Kin on one record are one entry: one repair moves both', async () => {
    const docs = crossed();
    docs['families/3/kin/third'] = { ...NEW_FAMILY, createdAt: day(11), legacyKinId: 'flatOld' };
    const ctx = world(docs);
    const { summary, crossed: plan } = await buildPlan(ctx.db as any);
    expect(summary.crossed).toBe(2);
    expect(plan).toHaveLength(1);
  });

  it('a link into another household is counted and never planned', async () => {
    const ctx = world({
      'families/3/kin/x': { name: 'Rex', status: 'active', legacyKinId: 'flatOther', createdAt: day(2) },
      'kin/flatOther': { name: 'Rex', kinfolkId: '9', status: 'active', familyKinPath: 'families/9/kin/y', createdAt: day(1) },
    });
    const { summary, crossed: plan } = await buildPlan(ctx.db as any);
    expect(plan).toEqual([]);
    expect(summary.foreign).toBe(1);
  });

  it('the dry run writes nothing', async () => {
    const ctx = world({ ...crossed(), ...healthy() });
    await buildPlan(ctx.db as any);
    expect(ctx.writes).toEqual([]);
    expect(ctx.deletes).toEqual([]);
  });
});

describe('repairCrossedKinLinks: the apply and the mirror it fires (#1912)', () => {
  it('touches only updatedAt on the planned family doc, never a flat doc', async () => {
    const docs = { ...crossed(), ...healthy() };
    const ctx = world(docs);
    const { crossed: plan } = await buildPlan(ctx.db as any);
    const before = structuredClone(docs);
    expect(await applyPlan(ctx.db as any, plan)).toBe(1);

    expect(ctx.writes.map((w: { path: string }) => w.path)).toEqual([NEW_PATH]);
    expect(Object.keys(ctx.writes[0].data)).toEqual(['updatedAt']);
    expect(docs['kin/flatOld']).toEqual(before['kin/flatOld']);
    expect(docs[OLD_PATH]).toEqual(before[OLD_PATH]);
  });

  it('the mirror run on the touched doc gives the new Kin its own record and hands the archived one back', async () => {
    const docs = crossed();
    const ctx = world(docs);
    const { crossed: plan } = await buildPlan(ctx.db as any);
    const before = { ...docs[NEW_PATH] };
    await applyPlan(ctx.db as any, plan);
    const res = await mirrorFamilyKinToFlat(HOUSEHOLD, 'new', before as any, docs[NEW_PATH] as any);

    expect(res.action).toBe('created');
    expect(res.flatDocId).not.toBe('flatOld');
    expect(docs[`kin/${res.flatDocId}`]).toMatchObject({ name: 'Max', species: 'Bird', status: 'active', kinfolkId: HOUSEHOLD, familyKinPath: NEW_PATH });
    expect(docs[NEW_PATH]).toMatchObject({ legacyKinId: res.flatDocId });
    expect(docs['kin/flatOld']).toMatchObject({ familyKinPath: OLD_PATH, species: 'Dog', status: 'archived', officeNotes: 'older dog' });

    // A second run over the repaired data plans nothing.
    const again = world(docs);
    const second = await buildPlan(again.db as any);
    expect(second.crossed).toEqual([]);
    expect(second.summary.linked).toBe(2);
  });

  it('a Kin deleted after the plan was read is skipped, and the others are still touched', async () => {
    const docs = crossed();
    docs['families/5/kin/o'] = { ...OLD_FAMILY, legacyKinId: 'flat5', familyKinPath: 'families/5/kin/o' };
    docs['families/5/kin/n'] = { ...NEW_FAMILY, legacyKinId: 'flat5', familyKinPath: 'families/5/kin/n' };
    docs['kin/flat5'] = { ...OLD_FLAT, kinfolkId: '5', legacyKinId: 'flat5', familyKinPath: 'families/5/kin/n' };
    const ctx = world(docs);
    const { crossed: plan } = await buildPlan(ctx.db as any);
    expect(plan.map((c) => c.path).sort()).toEqual([NEW_PATH, 'families/5/kin/n']);
    delete (docs as Record<string, unknown>)[NEW_PATH];
    expect(await applyPlan(ctx.db as any, plan)).toBe(1);
    expect(docs[NEW_PATH]).toBeUndefined();
    expect(ctx.writes.map((w: { path: string }) => w.path)).toEqual(['families/5/kin/n']);
  });

  it('refuses to write anywhere but a family Kin doc', async () => {
    const ctx = world({});
    await expect(
      applyPlan(ctx.db as any, [{ path: 'kin/flatOld', kinfolkId: HOUSEHOLD, kinId: 'x', flatId: 'flatOld', ownerKinId: null }]),
    ).rejects.toThrow('refusing to write outside families/*/kin');
    expect(ctx.writes).toEqual([]);
  });
});
