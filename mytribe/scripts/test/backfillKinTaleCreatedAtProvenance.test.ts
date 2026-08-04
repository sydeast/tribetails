import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  parseLegacyStamp,
  isMigratedRow,
  recoverOriginalInstant,
  planProvenance,
} from '../backfillKinTaleCreatedAtProvenance';

/**
 * Every decision this migration makes about a single document lives in
 * `planProvenance`, so it can be pinned against fixtures without a Firestore
 * anywhere near it. The WRITE itself is proven separately, against a seeded
 * emulator, in `backfillKinTaleCreatedAtProvenance.emulator.test.ts`.
 */

const INGEST = '2026-05-16T20:36:39Z';
const INGEST_CANONICAL = '2026-05-16T20:36:39.000Z';
const SUBMITTED_CANONICAL = '2025-09-03T14:02:00.000Z';

/**
 * A real production row as the May 2026 migration left it, copied field for
 * field. This is the state production is in if the F7 redate was never run.
 */
const LEGACY_ROW = {
  createdAt: 'September 3, 2025 2:02pm',
  visitDate: 'September 3, 2025 2:02pm',
  sentAt: 'September 3, 2025 2:02pm',
  arrivedAt: '12:03pm',
  departedAt: '2:11pm',
  _legacySubmittedAt: '2025-09-03T14:02:00Z',
  _migratedFrom: 'visit_logs/57',
  _migratedAt: INGEST,
  sentVia: 'legacy_visit_logs',
};

/** The same row as the deleted F7 redate would have left it. */
const REDATED_ROW = { ...LEGACY_ROW, createdAt: INGEST_CANONICAL };

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });

  it('--allow-prod is the only thing that switches to apply', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--dry-run']).mode).toBe('dry-run');
  });

  it('takes a project override', () => {
    expect(parseArgs(['--project', 'auntieos-ttpc']).projectId).toBe('auntieos-ttpc');
  });

  it('refuses --project with no value', () => {
    expect(() => parseArgs(['--project'])).toThrow(/requires a value/);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
  });
});

describe('parseLegacyStamp', () => {
  it('parses the one grammar the corpus uses', () => {
    expect(parseLegacyStamp('September 3, 2025 2:02pm')).toBe(SUBMITTED_CANONICAL);
  });

  it('12am is hour 0 and 12pm is hour 12', () => {
    expect(parseLegacyStamp('March 24, 2026 12:29am')).toBe('2026-03-24T00:29:00.000Z');
    expect(parseLegacyStamp('August 10, 2025 12:59pm')).toBe('2025-08-10T12:59:00.000Z');
  });

  it('accepts the bare-hour form the sibling time fields use', () => {
    expect(parseLegacyStamp('March 31, 2026 4pm')).toBe('2026-03-31T16:00:00.000Z');
  });

  it('turns a month-name sort into a chronological one', () => {
    // The defect, in one assertion: the raw text says March is newer than
    // September, because 'S' is 0x53 and 'M' is 0x4D.
    expect('September 3, 2025 2:02pm' > 'March 31, 2026 10:16am').toBe(true);
    expect((parseLegacyStamp('September 3, 2025 2:02pm') ?? '') <
      (parseLegacyStamp('March 31, 2026 10:16am') ?? '')).toBe(true);
  });

  it('REFUSES a bare clock time, which is what makes the visitDate lane safe', () => {
    // When `submitted` was blank the migration copied `arrival` into visitDate,
    // and those are bare clock times carrying no date at all. Recovering from
    // visitDate is only defensible because these return null.
    expect(parseLegacyStamp('8:37pm')).toBeNull();
    expect(parseLegacyStamp('12:03pm')).toBeNull();
  });

  it('refuses a day that does not exist rather than rolling it into next month', () => {
    expect(parseLegacyStamp('February 30, 2026 1:00pm')).toBeNull();
  });

  it('refuses out-of-range clock components', () => {
    expect(parseLegacyStamp('March 1, 2026 0:30am')).toBeNull();
    expect(parseLegacyStamp('March 1, 2026 13:30pm')).toBeNull();
    expect(parseLegacyStamp('March 1, 2026 1:60pm')).toBeNull();
  });

  it('refuses everything ambiguous or unrecognized, never coerces it', () => {
    // 03/09/2025 is two different days depending on who typed it.
    expect(parseLegacyStamp('03/09/2025 2:02pm')).toBeNull();
    expect(parseLegacyStamp('Sep 3, 2025 2:02pm')).toBeNull();
    expect(parseLegacyStamp('September 3, 2025 2:02pm (approx)')).toBeNull();
    expect(parseLegacyStamp('yesterday evening')).toBeNull();
    expect(parseLegacyStamp('')).toBeNull();
    expect(parseLegacyStamp(undefined)).toBeNull();
  });

  it('does not depend on the machine timezone', () => {
    // Built through Date.UTC, so this is a fixed string, not a local rendering.
    expect(parseLegacyStamp('January 1, 2026 12:00am')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('isMigratedRow', () => {
  it('accepts any one of the four markers on its own', () => {
    expect(isMigratedRow({ _migratedFrom: 'visit_logs/57' })).toBe(true);
    expect(isMigratedRow({ _migratedAt: INGEST })).toBe(true);
    expect(isMigratedRow({ sentVia: 'legacy_visit_logs' })).toBe(true);
    expect(isMigratedRow({ sentVia: 'legacy_orphan' })).toBe(true);
  });

  it('is a POSITIVE test, so a modern row is never swept in by looking odd', () => {
    expect(isMigratedRow({ createdAt: '2025-12-02T19:00:00.000Z', sentVia: 'sms' })).toBe(false);
    expect(isMigratedRow({})).toBe(false);
    expect(isMigratedRow({ sentVia: '' })).toBe(false);
    // A DRAFT with no sentVia and no stamps at all is not an import.
    expect(isMigratedRow({ status: 'DRAFT', createdAt: '2026-08-01T10:00:00.000Z' })).toBe(false);
  });
});

describe('recoverOriginalInstant', () => {
  it('lane 1: the parsed stamp the migration already preserved', () => {
    expect(recoverOriginalInstant(LEGACY_ROW)).toBe(SUBMITTED_CANONICAL);
  });

  it('lane 2: the raw free text still sitting in createdAt', () => {
    const { _legacySubmittedAt, visitDate, sentAt, ...row } = LEGACY_ROW;
    void _legacySubmittedAt;
    void visitDate;
    void sentAt;
    expect(recoverOriginalInstant(row)).toBe(SUBMITTED_CANONICAL);
  });

  it('lane 3: visitDate, on a row the redate already overwrote createdAt on', () => {
    const { _legacySubmittedAt, sentAt, ...row } = REDATED_ROW;
    void _legacySubmittedAt;
    void sentAt;
    expect(recoverOriginalInstant(row)).toBe(SUBMITTED_CANONICAL);
  });

  it('lane 3: sentAt, when visitDate fell back to a bare clock time', () => {
    const row = {
      ...REDATED_ROW,
      _legacySubmittedAt: '',
      visitDate: '8:37pm',
      sentAt: 'September 3, 2025 2:02pm',
    };
    expect(recoverOriginalInstant(row)).toBe(SUBMITTED_CANONICAL);
  });

  it('returns null when every lane is a bare clock time or blank', () => {
    // The genuinely unrecoverable row: `submitted` was blank at import, so no
    // field on the document carries a date.
    expect(
      recoverOriginalInstant({
        createdAt: INGEST_CANONICAL,
        visitDate: '8:37pm',
        sentAt: '8:37pm',
        arrivedAt: '8:37pm',
        _legacySubmittedAt: '',
        _migratedAt: INGEST,
      }),
    ).toBeNull();
  });
});

describe('planProvenance', () => {
  it('gives an imported row back its original creation instant', () => {
    const plan = planProvenance(LEGACY_ROW);
    expect(plan.skip).toBeNull();
    expect(plan.source).toBe('original');
    expect(plan.update['createdAt']).toBe(SUBMITTED_CANONICAL);
    expect(plan.update['createdAtSource']).toBe('original');
  });

  it('CONVERGES both production states onto the same answer', () => {
    // Whether the operator ran the deleted F7 redate is not knowable from this
    // repository, so the migration must be correct either way. This is that
    // guarantee, asserted rather than argued.
    const beforeRedate = planProvenance(LEGACY_ROW);
    const afterRedate = planProvenance(REDATED_ROW);
    expect(afterRedate.update).toEqual(beforeRedate.update);
    expect(afterRedate.update['createdAt']).toBe(SUBMITTED_CANONICAL);
  });

  it('MARKS a row whose original cannot be recovered instead of keeping a silent import date', () => {
    const unrecoverable = {
      createdAt: INGEST_CANONICAL,
      visitDate: '8:37pm',
      sentAt: '8:37pm',
      _legacySubmittedAt: '',
      _migratedFrom: 'visit_logs/91',
      _migratedAt: INGEST,
      sentVia: 'legacy_visit_logs',
    };
    const plan = planProvenance(unrecoverable);
    expect(plan.skip).toBeNull();
    expect(plan.source).toBe('import');
    // It keeps a date that is TRUE (the day it was imported) and says so.
    expect(plan.update['createdAt']).toBe(INGEST_CANONICAL);
    expect(plan.update['createdAtSource']).toBe('import');
    // And it does not invent a submit stamp it never found.
    expect(plan.update['_legacySubmittedAt']).toBeUndefined();
  });

  it('NEVER writes visitDate, sentAt, arrivedAt or departedAt', () => {
    // 18 of the 83 live rows record an arrival LATER in the day than the submit
    // stamp, so that stamp is not the visit date and must not be written as one.
    const { _legacySubmittedAt, ...row } = LEGACY_ROW;
    void _legacySubmittedAt;
    const keys = Object.keys(planProvenance(row).update).sort();
    expect(keys).toEqual(['_legacySubmittedAt', 'createdAt', 'createdAtSource']);
  });

  it('leaves a row this system really created completely alone', () => {
    const plan = planProvenance({
      createdAt: '2025-12-02T19:00:00.000Z',
      visitDate: '2025-12-02',
      sentVia: 'sms',
    });
    expect(plan.skip).toBe('not-migrated');
    expect(plan.update).toEqual({});
  });

  it('is idempotent: replaying its own output plans nothing', () => {
    const first = planProvenance(LEGACY_ROW);
    const second = planProvenance({ ...LEGACY_ROW, ...first.update });
    expect(second.update).toEqual({});
    expect(second.skip).toBe('already-stamped');
  });

  it('a row already marked import is not re-examined on a later run', () => {
    // Otherwise a rerun after someone hand-repairs _legacySubmittedAt would
    // silently flip the marker, and "unknown" would stop meaning anything.
    const plan = planProvenance({ ...LEGACY_ROW, createdAtSource: 'import' });
    expect(plan.skip).toBe('already-stamped');
    expect(plan.update).toEqual({});
  });

  it('REFUSES a row with neither a recoverable original nor a usable _migratedAt', () => {
    const plan = planProvenance({
      createdAt: 'sometime last Tuesday',
      visitDate: '',
      sentAt: '',
      _migratedFrom: 'visit_logs/99',
      _migratedAt: 'May 16, 2026',
      sentVia: 'legacy_visit_logs',
    });
    expect(plan.skip).toBe('no-usable-instant');
    expect(plan.update).toEqual({});
    expect(plan.source).toBeNull();
  });

  it('does not overwrite an existing _legacySubmittedAt', () => {
    const plan = planProvenance({ ...REDATED_ROW, _legacySubmittedAt: '2000-01-01T00:00:00.000Z' });
    expect(plan.update['_legacySubmittedAt']).toBeUndefined();
    expect(plan.update['createdAt']).toBe('2000-01-01T00:00:00.000Z');
  });

  it('produces a createdAt that sorts chronologically against a live ISO row', () => {
    // The operator's symptom, closed: a September 2025 tale must sort BELOW a
    // December 2025 one, which the raw free text did not.
    const legacy = planProvenance(LEGACY_ROW).update['createdAt'] ?? '';
    const live = '2025-12-02T19:00:00.000Z';
    expect(legacy < live).toBe(true);
  });

  it('every value it writes is a STRING, never a Date or a Timestamp', () => {
    for (const v of Object.values(planProvenance(LEGACY_ROW).update)) {
      expect(typeof v).toBe('string');
    }
  });
});
