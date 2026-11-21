import { describe, it, expect } from 'vitest';
import { buildDbMock } from '../../functions/test/_helpers/mockDb';
import { parseArgs, buildPlan, applyPlans } from '../rewriteVisitKinIds';

/**
 * #2350 backfill: visits and KinTales stored under a Kin's household card id
 * are put on its admin record id. The real write is an operator step; this
 * file proves the plan, the write, the dry run and the second run against an
 * in-memory Firestore. No emulator run (agents do not start emulators).
 */

function world() {
  const docs: Record<string, Record<string, unknown> | null> = {
    // Household kf-1: Biscuit has two ids, the office cat one.
    'families/kf-1/kin/fam-a': { name: 'Biscuit', legacyKinId: 'flat-a' },
    'kin/flat-a': { name: 'Biscuit', kinfolkId: 'kf-1' },
    'kin/flat-f': { name: 'Office Cat', kinfolkId: 'kf-1' },
    // Household kf-2: every Kin has one id.
    'families/kf-2/kin/both-p': { name: 'Pepper', legacyKinId: 'both-p' },
    'kin/both-p': { name: 'Pepper', kinfolkId: 'kf-2' },
    'kin_care_sessions/s-old': { kinfolkId: 'kf-1', kinIds: ['fam-a', 'flat-f'], kinNames: ['Biscuit', 'Office Cat'] },
    'kin_care_sessions/s-right': { kinfolkId: 'kf-1', kinIds: ['flat-a'] },
    'kin_care_sessions/s-other': { kinfolkId: 'kf-2', kinIds: ['both-p'] },
    'kin_care_sessions/s-orphan': { kinIds: ['fam-a'] },
    'kin_care_reports/r-tale': { kinfolkId: 'kf-1', kinIds: ['fam-a'], status: 'SENT' },
    'kin_care_reports/r-mood': { kinfolkId: 'kf-1', kinIds: ['fam-a'], kinMoods: { 'fam-a': 'happy' } },
  };
  const ctx = buildDbMock({ docs, writeThrough: true });
  return { ctx, docs };
}

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });
  it('--allow-prod applies', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
  });
  it('--dry-run beats --allow-prod in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  it('refuses an unknown flag and a valueless --project', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/requires a value/);
  });
});

describe('buildPlan', () => {
  it('plans the household with a two-id Kin, lists the tale it cannot move, and writes nothing', async () => {
    const { ctx } = world();
    const { summary, plans } = await buildPlan(ctx.db as never);

    expect(summary).toEqual({ households: 2, householdsWithAliases: 1, scanned: 5, toWrite: 2, refused: 1 });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.writes).toEqual([
      { collection: 'kin_care_sessions', docId: 's-old', update: { kinIds: ['flat-a', 'flat-f'] } },
      { collection: 'kin_care_reports', docId: 'r-tale', update: { kinIds: ['flat-a'] } },
    ]);
    expect(plans[0]?.refusals).toEqual([{ collection: 'kin_care_reports', docId: 'r-mood', cardIds: ['fam-a'], reason: 'card-id-elsewhere' }]);
    expect(ctx.writes).toEqual([]);
  });
});

describe('applyPlans', () => {
  it('writes kinIds only, and a second run plans nothing', async () => {
    const { ctx, docs } = world();
    const first = await buildPlan(ctx.db as never);

    expect(await applyPlans(ctx.db as never, first.plans)).toEqual({ written: 2, skippedOnRecheck: 0 });
    expect(docs['kin_care_sessions/s-old']).toEqual({
      kinfolkId: 'kf-1',
      kinIds: ['flat-a', 'flat-f'],
      kinNames: ['Biscuit', 'Office Cat'],
    });
    expect(docs['kin_care_reports/r-tale']).toEqual({ kinfolkId: 'kf-1', kinIds: ['flat-a'], status: 'SENT' });
    expect(docs['kin_care_reports/r-mood']?.['kinIds']).toEqual(['fam-a']);
    expect(docs['kin_care_sessions/s-orphan']?.['kinIds']).toEqual(['fam-a']);

    const second = await buildPlan(ctx.db as never);
    expect(second.summary.toWrite).toBe(0);
    expect(second.plans.flatMap((p) => p.writes)).toEqual([]);
  });
});
describe('a crossed pair', () => {
  it('lists the visits of both cards that claim one record and writes neither, even with --allow-prod', async () => {
    const docs: Record<string, Record<string, unknown> | null> = {
      'families/kf-3/kin/aa-new': { name: 'Rover', legacyKinId: 'rec-1' },
      'families/kf-3/kin/zz-old': { name: 'Rex', legacyKinId: 'rec-1' },
      'kin/rec-1': { name: 'Rex', kinfolkId: 'kf-3' },
      'kin_care_sessions/s-rover': { kinfolkId: 'kf-3', kinIds: ['aa-new'] },
      'kin_care_sessions/s-rex': { kinfolkId: 'kf-3', kinIds: ['zz-old'] },
    };
    const ctx = buildDbMock({ docs, writeThrough: true });
    const { summary, plans } = await buildPlan(ctx.db as never);
    expect(summary).toMatchObject({ toWrite: 0, refused: 2 });
    expect(plans[0]?.refusals.map((r) => [r.docId, r.reason])).toEqual([
      ['s-rover', 'crossed-link'],
      ['s-rex', 'crossed-link'],
    ]);
    expect(await applyPlans(ctx.db as never, plans)).toEqual({ written: 0, skippedOnRecheck: 0 });
    expect(docs['kin_care_sessions/s-rover']?.['kinIds']).toEqual(['aa-new']);
    expect(ctx.writes).toEqual([]);
  });
});
