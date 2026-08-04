/**
 * Tests for backfillBookingKinRoster.ts.
 *
 * Pure-planner only, no Firestore deps. Validates:
 *   - arg parsing (dry-run default, --allow-prod, --project)
 *   - eligibility: which documents count as "kinIds not stated"
 *   - the two ROSTER-DRIFT rules, which are the whole reason this script is
 *     more than a one-liner: a Kin adopted after the booking is not
 *     retroactively added, and a memorial Kin counts on a past visit but not
 *     on an upcoming one
 *   - idempotency: a document the planner already filled is no longer eligible
 */

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planKinRoster,
  needsRoster,
  toMillis,
  type RosterKin,
} from '../backfillBookingKinRoster';

const MARCH = Date.parse('2026-03-01T00:00:00.000Z');
const JULY = Date.parse('2026-07-01T00:00:00.000Z');

const fido: RosterKin = { id: 'k1', name: 'Fido', status: 'active', createdAtMs: MARCH - 1000 };
const whiskers: RosterKin = { id: 'k2', name: 'Whiskers', status: undefined, createdAtMs: null };
const newcomer: RosterKin = { id: 'k3', name: 'Newcomer', status: 'active', createdAtMs: JULY };
const oldBoy: RosterKin = { id: 'k4', name: 'Old Boy', status: 'noLongerWithUs', createdAtMs: MARCH - 5000 };
const ghost: RosterKin = { id: 'k5', name: 'Ghost', status: 'archived', createdAtMs: MARCH - 5000 };

describe('parseArgs', () => {
  it('defaults to a dry run, so an accidental invocation writes nothing', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });

  it('--allow-prod is what flips it to apply; nothing else does', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--dry-run']).mode).toBe('dry-run');
  });

  it('takes a project override', () => {
    expect(parseArgs(['--project', 'mytribe-dev']).projectId).toBe('mytribe-dev');
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    expect(() => parseArgs(['--wipe'])).toThrow(/unknown arg/);
  });
});

describe('needsRoster: which documents the script is even allowed to touch', () => {
  it('an absent kinIds is eligible', () => {
    expect(needsRoster({})).toBe(true);
  });

  it('an empty kinIds is eligible: R1 says that never meant "nobody"', () => {
    expect(needsRoster({ kinIds: [] })).toBe(true);
  });

  it('a stated kinIds is NOT eligible, so a deliberately narrowed booking is left alone', () => {
    expect(needsRoster({ kinIds: ['k1'] })).toBe(false);
  });

  it('an array of junk with no usable id is still eligible', () => {
    expect(needsRoster({ kinIds: ['', 7, null] })).toBe(true);
  });

  it('is idempotent: a doc this script already filled is no longer eligible', () => {
    const filled = planKinRoster({ roster: [fido, whiskers], docCreatedAtMs: MARCH, upcoming: false });
    expect(needsRoster({ kinIds: filled.kinIds })).toBe(false);
  });
});

describe('planKinRoster: roster drift', () => {
  it('materializes the whole household when nothing disqualifies anyone', () => {
    const out = planKinRoster({ roster: [fido, whiskers], docCreatedAtMs: MARCH, upcoming: true });
    expect(out).toEqual({ kinIds: ['k1', 'k2'], kinNames: ['Fido', 'Whiskers'] });
  });

  it('EXCLUDES a Kin adopted after the booking: a March visit never cared for a July dog', () => {
    const out = planKinRoster({ roster: [fido, newcomer], docCreatedAtMs: MARCH, upcoming: false });
    expect(out.kinIds).toEqual(['k1']);
  });

  it('INCLUDES that same Kin on a booking created after they arrived', () => {
    const out = planKinRoster({ roster: [fido, newcomer], docCreatedAtMs: JULY + 1000, upcoming: true });
    expect(out.kinIds).toEqual(['k1', 'k3']);
  });

  it('includes an undateable Kin: the legacy imports predate every booking here', () => {
    const out = planKinRoster({ roster: [whiskers], docCreatedAtMs: MARCH, upcoming: false });
    expect(out.kinIds).toEqual(['k2']);
  });

  it('cannot exclude anyone on age when the booking itself carries no stamp', () => {
    const out = planKinRoster({ roster: [fido, newcomer], docCreatedAtMs: null, upcoming: false });
    expect(out.kinIds).toEqual(['k1', 'k3']);
  });

  it('keeps a memorial Kin on a PAST visit: they were alive and in care then', () => {
    const out = planKinRoster({ roster: [fido, oldBoy], docCreatedAtMs: MARCH, upcoming: false });
    expect(out.kinIds).toEqual(['k1', 'k4']);
  });

  it('drops a memorial Kin from an UPCOMING visit: nobody is walking them next Tuesday', () => {
    const out = planKinRoster({ roster: [fido, oldBoy], docCreatedAtMs: MARCH, upcoming: true });
    expect(out.kinIds).toEqual(['k1']);
  });

  it('drops the legacy archived spelling from both, because it is not a portal Kin at all', () => {
    expect(planKinRoster({ roster: [ghost], docCreatedAtMs: MARCH, upcoming: false }).kinIds).toEqual([]);
    expect(planKinRoster({ roster: [ghost], docCreatedAtMs: MARCH, upcoming: true }).kinIds).toEqual([]);
  });

  it('keeps a nameless Kin on kinIds but off kinNames, never as a blank chip', () => {
    const nameless: RosterKin = { id: 'k9', name: null, status: 'active', createdAtMs: null };
    const out = planKinRoster({ roster: [fido, nameless], docCreatedAtMs: MARCH, upcoming: false });
    expect(out.kinIds).toEqual(['k1', 'k9']);
    expect(out.kinNames).toEqual(['Fido']);
  });

  it('is deterministic: replanning the same inputs gives a deeply-equal plan', () => {
    const args = { roster: [fido, whiskers, oldBoy, newcomer], docCreatedAtMs: MARCH, upcoming: false };
    expect(planKinRoster(args)).toEqual(planKinRoster(args));
  });
});

describe('toMillis', () => {
  it('reads an ISO string, the shape kin_care_sessions.startTime uses', () => {
    expect(toMillis('2026-03-01T00:00:00.000Z')).toBe(MARCH);
  });

  it('reads a Firestore Timestamp through toMillis()', () => {
    expect(toMillis({ toMillis: () => MARCH })).toBe(MARCH);
  });

  it('reads a Date', () => {
    expect(toMillis(new Date(MARCH))).toBe(MARCH);
  });

  it('returns null for junk rather than NaN or 0, so no rule fires on a guess', () => {
    expect(toMillis('sometime last spring')).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis({})).toBeNull();
  });
});
