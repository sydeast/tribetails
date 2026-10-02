import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  resolveTarget,
  planRow,
  buildPlanFromRows,
  reportLines,
} from '../backfillGoogleBusySlotZone';

const CHICAGO = 'America/Chicago';
const ms = (iso: string): number => Date.parse(iso);

/** A pre-#1160 import: UTC wall clock, no instants. */
const legacy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  date: '2026-10-05',
  startTime: '19:00',
  endTime: '20:00',
  source: 'GOOGLE_BUSY_IMPORT',
  externalEventId: `busy_cal_${ms('2026-10-05T19:00:00Z')}_${ms('2026-10-05T20:00:00Z')}`,
  externalCalendarId: 'cal',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('parseArgs', () => {
  it('is a dry run by default', () => {
    expect(parseArgs([])).toEqual({ projectId: null, allowProd: false, apply: false });
  });
  it('--dry-run beats --apply in either order', () => {
    expect(parseArgs(['--apply', '--dry-run']).apply).toBe(false);
    expect(parseArgs(['--dry-run', '--apply']).apply).toBe(false);
  });
  it('--allow-prod alone is still a dry run', () => {
    expect(parseArgs(['--allow-prod'])).toMatchObject({ allowProd: true, apply: false });
  });
  it('refuses an unknown flag', () => {
    expect(() => parseArgs(['--write'])).toThrow(/unknown arg/);
  });
});

describe('resolveTarget', () => {
  it('refuses production without --allow-prod', () => {
    expect(() => resolveTarget(parseArgs([]), {})).toThrow(/PRODUCTION/);
  });
  it('refuses --allow-prod when the emulator host is set', () => {
    expect(() => resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: 'localhost:8080' })).toThrow(/refused/);
  });
  it('targets the emulator when its host is set', () => {
    expect(resolveTarget(parseArgs([]), { FIRESTORE_EMULATOR_HOST: 'localhost:8080' })).toEqual({ kind: 'emulator', host: 'localhost:8080' });
  });
});

describe('planRow', () => {
  it('moves a legacy 19:00 UTC row to the 14:00 Chicago row and adds its instants', () => {
    const plan = planRow(legacy(), CHICAGO, new Set());
    expect(plan).toEqual({
      kind: 'rewrite',
      update: {
        date: '2026-10-05',
        startTime: '14:00',
        endTime: '15:00',
        startMs: ms('2026-10-05T19:00:00Z'),
        endMs: ms('2026-10-05T20:00:00Z'),
        timeZone: CHICAGO,
      },
      newRows: [],
    });
  });

  it('a legacy row whose UTC date differs from its business date moves to the business day', () => {
    // 02:00 to 03:00 UTC on Oct 6 is 21:00 to 22:00 CDT on Oct 5.
    const plan = planRow(legacy({ date: '2026-10-06', startTime: '02:00', endTime: '03:00' }), CHICAGO, new Set());
    expect(plan).toMatchObject({ kind: 'rewrite', update: { date: '2026-10-05', startTime: '21:00', endTime: '22:00' } });
  });

  it('splits a legacy row that crosses business midnight, keyed off the row own key', () => {
    // 03:00 to 07:00 UTC on Oct 6 is 22:00 CDT Oct 5 to 02:00 CDT Oct 6.
    const key = 'busy_cal_A_B';
    const plan = planRow(legacy({ date: '2026-10-06', startTime: '03:00', endTime: '07:00', externalEventId: key }), CHICAGO, new Set());
    expect(plan.kind).toBe('rewrite');
    if (plan.kind !== 'rewrite') return;
    expect(plan.update).toMatchObject({ date: '2026-10-05', startTime: '22:00', endTime: '23:59' });
    expect(plan.newRows).toHaveLength(1);
    expect(plan.newRows[0]).toMatchObject({
      date: '2026-10-06',
      startTime: '00:00',
      endTime: '02:00',
      externalEventId: `${key}_d1`,
      externalCalendarId: 'cal',
      createdAt: '2026-09-01T00:00:00.000Z',
      source: 'GOOGLE_BUSY_IMPORT',
    });
  });

  it('does not create a later-day row whose key already exists', () => {
    const key = 'busy_cal_A_B';
    const plan = planRow(
      legacy({ date: '2026-10-06', startTime: '03:00', endTime: '07:00', externalEventId: key }),
      CHICAGO,
      new Set([`${key}_d1`]),
    );
    expect(plan).toMatchObject({ kind: 'rewrite', newRows: [] });
  });

  it('leaves rows that are not Google imports, or already carry instants', () => {
    expect(planRow(legacy({ source: 'INTERNAL_MANUAL' }), CHICAGO, new Set())).toEqual({ kind: 'skip', reason: 'not-google' });
    expect(
      planRow(legacy({ startMs: ms('2026-10-05T19:00:00Z'), endMs: ms('2026-10-05T20:00:00Z') }), CHICAGO, new Set()),
    ).toEqual({ kind: 'skip', reason: 'already-has-instants' });
  });

  it('reports a legacy row it cannot read instead of guessing', () => {
    expect(planRow(legacy({ startTime: 'xx' }), CHICAGO, new Set())).toEqual({ kind: 'unreadable' });
  });
});

describe('buildPlanFromRows', () => {
  it('is idempotent: rows it rewrote are skipped on a second pass', () => {
    const first = buildPlanFromRows([{ id: 'a', data: legacy() }], CHICAGO);
    expect(first.updates).toHaveLength(1);
    const after = { ...legacy(), ...first.updates[0]!.update };
    const second = buildPlanFromRows([{ id: 'a', data: after }], CHICAGO);
    expect(second.updates).toHaveLength(0);
    expect(second.report.alreadyHasInstants).toBe(1);
  });

  it('counts each kind and says a dry run wrote nothing', () => {
    const plan = buildPlanFromRows(
      [
        { id: 'a', data: legacy() },
        { id: 'b', data: legacy({ source: 'INTERNAL_MANUAL' }) },
        { id: 'c', data: legacy({ date: 'bad' }) },
      ],
      CHICAGO,
    );
    expect(plan.report).toMatchObject({ scanned: 3, notGoogle: 1, rewritten: 1, unreadable: ['c'] });
    expect(reportLines(plan.report, false).join('\n')).toContain('DRY RUN: nothing was written');
  });
});
