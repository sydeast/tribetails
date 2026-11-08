import { describe, it, expect } from 'vitest';
import { parseArgs, planRow, planRows, isoOf } from '../backfillGeneratedDraftCreatedOn';

/**
 * #1629: drafts generate.js wrote carry `generated_at` and no `createdOn`, so
 * every admin list that orders on `createdOn` drops them. The backfill copies
 * the one into the other and touches nothing else. Pure; no Firestore.
 */
describe('backfillGeneratedDraftCreatedOn', () => {
  it('stamps createdOn from generated_at on a generate.js draft', () => {
    expect(planRow({ status: 'generated', generated_at: '2026-11-05T18:30:00.000Z' })).toEqual({
      state: 'to-stamp',
      createdOn: '2026-11-05T18:30:00.000Z',
    });
  });

  it('treats a blank createdOn as missing', () => {
    expect(planRow({ createdOn: '  ', generated_at: '2026-11-05T18:30:00.000Z' }).state).toBe('to-stamp');
  });

  it('leaves a draft that already carries createdOn alone, so a second run plans nothing', () => {
    expect(planRow({ createdOn: '2026-05-23T22:23:00.000Z', generated_at: '2026-11-05T18:30:00.000Z' })).toEqual({
      state: 'has-created-on',
      createdOn: null,
    });
  });

  it('never dates a draft by guess: no readable generated_at is reported, not written', () => {
    expect(planRow({ status: 'generated' }).state).toBe('undatable');
    expect(planRow({ generated_at: 'not a date' }).state).toBe('undatable');
  });

  it('reads a Timestamp and millis as well as an ISO string', () => {
    const ts = { toDate: () => new Date('2026-11-05T18:30:00.000Z') };
    expect(isoOf(ts)).toBe('2026-11-05T18:30:00.000Z');
    expect(isoOf(Date.parse('2026-11-05T18:30:00.000Z'))).toBe('2026-11-05T18:30:00.000Z');
  });

  it('plans the writes and counts every row', () => {
    const plan = planRows([
      { path: 'generated_drafts/a', data: { generated_at: '2026-11-05T18:30:00.000Z' } },
      { path: 'generated_drafts/b', data: { createdOn: '2026-05-23T22:23:00.000Z' } },
      { path: 'generated_drafts/c', data: {} },
    ]);
    expect(plan.summary).toEqual({ scanned: 3, hasCreatedOn: 1, toStamp: 1, undatable: 1 });
    expect(plan.writes).toEqual([{ path: 'generated_drafts/a', createdOn: '2026-11-05T18:30:00.000Z' }]);
    expect(plan.undatablePaths).toEqual(['generated_drafts/c']);
  });

  it('dry-runs by default; --allow-prod applies; --dry-run wins in either order', () => {
    expect(parseArgs([]).mode).toBe('dry-run');
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
    expect(() => parseArgs(['--project'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
