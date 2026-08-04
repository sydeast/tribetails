import { describe, it, expect } from 'vitest';
import { parseArgs, planStrip, FIELD } from '../stripBookingVisitLocation';

/**
 * The strip's pure rules. Every decision the migration makes about a single
 * visit doc lives in `planStrip`, so it can be pinned against fixtures with no
 * Firestore anywhere near it.
 *
 * The one thing worth reading twice is the null case: `location: null` is a
 * STORED KEY, not an absent one, and both callables wrote exactly that on every
 * visit with no place given. If the plan looked at the value instead of the
 * key, the overwhelming majority of the corpus would survive the migration
 * still advertising a field the schema no longer has.
 */

/** A real visit doc, trimmed to the fields the plan can see. */
const VISIT = {
  batchId: 'req_1',
  familyId: 'kf1',
  status: 'requested',
  serviceName: 'Dog Walk',
  assignedAuntieUid: 'auntie1',
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
    expect(parseArgs(['--project', 'mytribe-prod']).projectId).toBe('mytribe-prod');
  });

  it('refuses --project with no value', () => {
    expect(() => parseArgs(['--project'])).toThrow(/requires a value/);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
  });
});

describe('planStrip', () => {
  it('leaves a visit that never had the field alone: this is idempotency', () => {
    expect(planStrip({ ...VISIT })).toEqual({ shape: 'absent', strip: false, value: null });
  });

  it('strips a STORED NULL, because a null key still advertises the field', () => {
    expect(planStrip({ ...VISIT, [FIELD]: null })).toEqual({
      shape: 'null',
      strip: true,
      value: null,
    });
  });

  it('strips a real value and carries it back so the dry run can print it', () => {
    expect(planStrip({ ...VISIT, [FIELD]: '12 Oak Street' })).toEqual({
      shape: 'value',
      strip: true,
      value: '12 Oak Street',
    });
  });

  it('treats a blank string as a null, not as a value worth printing', () => {
    expect(planStrip({ ...VISIT, [FIELD]: '   ' })).toEqual({
      shape: 'null',
      strip: true,
      value: null,
    });
  });

  it('strips a wrong-typed value rather than skipping what it cannot read', () => {
    expect(planStrip({ ...VISIT, [FIELD]: { lat: 1, lng: 2 } })).toEqual({
      shape: 'null',
      strip: true,
      value: null,
    });
  });

  it('is idempotent: the post-run document plans no second write', () => {
    const after = { ...VISIT };
    expect(planStrip(after).strip).toBe(false);
    expect(planStrip(after).strip).toBe(false);
  });
});
