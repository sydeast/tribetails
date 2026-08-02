import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  parseLegacyStamp,
  normalizeIsoInstant,
  classifyCreatedAt,
  planRedate,
} from '../backfillKinTaleCreatedAt';

/**
 * Punchlist F7's pure rules. Every decision this migration makes about a single
 * document lives in `planRedate`, so it can be pinned against fixtures without
 * a Firestore anywhere near it. The WRITE itself is proven separately, against a
 * seeded emulator, in `backfillKinTaleCreatedAt.emulator.test.ts`.
 */

const INGEST = '2026-05-16T20:36:39Z';
const INGEST_CANONICAL = '2026-05-16T20:36:39.000Z';

/** A real production row, copied field for field. */
const LEGACY_ROW = {
  createdAt: 'September 3, 2025 2:02pm',
  visitDate: 'September 3, 2025 2:02pm',
  sentAt: 'September 3, 2025 2:02pm',
  arrivedAt: '12:03pm',
  departedAt: '2:11pm',
  _migratedAt: INGEST,
  sentVia: 'legacy_visit_logs',
};

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
    expect(parseLegacyStamp('September 3, 2025 2:02pm')).toBe('2025-09-03T14:02:00.000Z');
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
    const sep = parseLegacyStamp('September 3, 2025 2:02pm') ?? '';
    const mar = parseLegacyStamp('March 31, 2026 10:16am') ?? '';
    expect(sep < mar).toBe(true);
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
  });

  it('does not depend on the machine timezone', () => {
    // Built through Date.UTC, so this is a fixed string, not a local rendering.
    expect(parseLegacyStamp('January 1, 2026 12:00am')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('normalizeIsoInstant', () => {
  it('re-renders to the millisecond form the live rows already use', () => {
    expect(normalizeIsoInstant(INGEST)).toBe(INGEST_CANONICAL);
  });

  it('leaves an already-canonical instant identical', () => {
    expect(normalizeIsoInstant('2025-12-02T19:00:00.000Z')).toBe('2025-12-02T19:00:00.000Z');
  });

  it('normalizing matters: the two forms do NOT sort together', () => {
    // 'Z' is 0x5A, '.' is 0x2E, so the same instant compares unequal, and a
    // mixed collection would carry a smaller copy of the bug being fixed.
    expect('2026-05-16T20:36:39Z' > '2026-05-16T20:36:39.000Z').toBe(true);
  });

  it('accepts an offset instant', () => {
    expect(normalizeIsoInstant('2026-05-16T15:36:39-05:00')).toBe('2026-05-16T20:36:39.000Z');
  });

  it('refuses anything that is not an instant', () => {
    expect(normalizeIsoInstant('2026-05-16')).toBeNull();
    expect(normalizeIsoInstant('September 3, 2025 2:02pm')).toBeNull();
    expect(normalizeIsoInstant('')).toBeNull();
  });
});

describe('classifyCreatedAt', () => {
  it('names the two live formats', () => {
    expect(classifyCreatedAt('September 3, 2025 2:02pm')).toBe('legacy');
    expect(classifyCreatedAt('2025-12-02T19:00:00.000Z')).toBe('iso');
  });

  it('treats a bare calendar date as already sorting with the digits', () => {
    expect(classifyCreatedAt('2026-05-16')).toBe('date-shaped');
  });

  it('blank, absent and non-string are all "missing"', () => {
    expect(classifyCreatedAt('')).toBe('missing');
    expect(classifyCreatedAt('   ')).toBe('missing');
    expect(classifyCreatedAt(undefined)).toBe('missing');
    expect(classifyCreatedAt(42)).toBe('missing');
  });
});

describe('planRedate', () => {
  it('redates a legacy row to its own ingest stamp', () => {
    const plan = planRedate(LEGACY_ROW);
    expect(plan.shape).toBe('legacy');
    expect(plan.skip).toBeNull();
    expect(plan.update['createdAt']).toBe(INGEST_CANONICAL);
  });

  it('carries the human submit stamp across as _legacySubmittedAt', () => {
    expect(planRedate(LEGACY_ROW).update['_legacySubmittedAt']).toBe('2025-09-03T14:02:00.000Z');
  });

  it('NEVER writes visitDate, sentAt, arrivedAt or departedAt', () => {
    // The sub-question, settled in the plan itself rather than only in prose:
    // 18 of the 83 live rows record an arrival LATER in the day than the submit
    // stamp, so that stamp is not the visit date and must not be written as one.
    const keys = Object.keys(planRedate(LEGACY_ROW).update);
    expect(keys.sort()).toEqual(['_legacySubmittedAt', 'createdAt']);
  });

  it('leaves an ISO row completely alone', () => {
    const plan = planRedate({
      createdAt: '2025-12-02T19:00:00.000Z',
      visitDate: '2025-12-02',
      _migratedAt: INGEST,
    });
    expect(plan.shape).toBe('iso');
    expect(plan.update).toEqual({});
    expect(plan.skip).toBeNull();
  });

  it('is idempotent: replaying its own output plans nothing', () => {
    const first = planRedate(LEGACY_ROW);
    const after = { ...LEGACY_ROW, ...first.update };
    const second = planRedate(after);
    expect(second.update).toEqual({});
    expect(second.shape).toBe('iso');
  });

  it('SKIPS a legacy row with no _migratedAt rather than guessing at one', () => {
    const { _migratedAt, ...noStamp } = LEGACY_ROW;
    void _migratedAt;
    const plan = planRedate(noStamp);
    expect(plan.skip).toBe('no-ingest-stamp');
    expect(plan.update).toEqual({});
  });

  it('SKIPS a legacy row whose _migratedAt is not a usable instant', () => {
    expect(planRedate({ ...LEGACY_ROW, _migratedAt: 'May 16, 2026' }).skip).toBe('no-ingest-stamp');
    expect(planRedate({ ...LEGACY_ROW, _migratedAt: '' }).skip).toBe('no-ingest-stamp');
  });

  it('SKIPS a row with no createdAt rather than inventing one', () => {
    const plan = planRedate({ _migratedAt: INGEST, visitDate: '2026-01-01' });
    expect(plan.skip).toBe('no-created-at');
    expect(plan.update).toEqual({});
  });

  it('still redates when the submit stamp is unparseable, and says so', () => {
    const plan = planRedate({ ...LEGACY_ROW, createdAt: 'sometime last Tuesday' });
    expect(plan.update['createdAt']).toBe(INGEST_CANONICAL);
    expect(plan.update['_legacySubmittedAt']).toBeUndefined();
    expect(plan.unparsedStamp).toBe(true);
  });

  it('does not overwrite an existing _legacySubmittedAt', () => {
    const plan = planRedate({ ...LEGACY_ROW, _legacySubmittedAt: '2000-01-01T00:00:00.000Z' });
    expect(plan.update['_legacySubmittedAt']).toBeUndefined();
    expect(plan.update['createdAt']).toBe(INGEST_CANONICAL);
  });

  it('every value it writes is a STRING, never a Date or a Timestamp', () => {
    // Load-bearing across all four clients: both Kotlin KinCareReport models
    // type createdAt as a non-null String, and the React admin windows the list
    // with a string `>=`. A Timestamp here would crash the Android snapshot
    // listener and silently empty the web list.
    for (const v of Object.values(planRedate(LEGACY_ROW).update)) {
      expect(typeof v).toBe('string');
    }
  });
});
