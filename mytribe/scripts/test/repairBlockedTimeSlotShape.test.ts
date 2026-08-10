import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { parseArgs, planRepair, VALID_SYNC_STATES } from '../repairBlockedTimeSlotShape';

/**
 * The repair's pure rules. Every decision about a single `booking_time_slots`
 * doc lives in `planRepair`, so it can be pinned against fixtures with no
 * Firestore anywhere near it.
 *
 * What is worth reading twice is the REFUSAL. This script knows exactly one
 * wrong `syncState` - `'LOCAL'`, the literal `createBlockedTimeSlot.ts` used to
 * write. Any OTHER out-of-vocabulary value is reported by document id and left
 * alone, because there is no evidence in this repository about what it was
 * meant to be, and a guess would launder an unknown into a value that looks
 * deliberate. The whole point of the repair is that Android's decoder refuses
 * to guess; the repair does not get to either.
 */

/** A slot as `createBlockedTimeSlot.ts` wrote it before the fix. */
const BROKEN = {
  date: '2026-06-25',
  startTime: '09:00',
  endTime: '12:00',
  isAvailable: false,
  slotType: 'BLOCKED',
  notes: 'PTO',
  source: 'INTERNAL_MANUAL',
  syncState: 'LOCAL',
  createdBy: 'auntie-1',
  createdAt: Timestamp.fromDate(new Date('2026-06-25T09:00:00.000Z')),
  updatedAt: Timestamp.fromDate(new Date('2026-06-25T09:00:00.000Z')),
};

/** A slot as `syncGoogleCalendarBusyEvents.ts` wrote it. Always decoded fine. */
const IMPORTED = {
  date: '2026-06-25',
  startTime: '09:00',
  endTime: '12:00',
  isAvailable: false,
  slotType: 'BLOCKED',
  source: 'GOOGLE_BUSY_IMPORT',
  externalEventId: 'busy_cal-1_1_2',
  syncState: 'SYNCED',
  createdAt: '2026-06-25T09:00:00.000Z',
};

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });

  it('--allow-prod is the only thing that switches to apply', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--dry-run']).mode).toBe('dry-run');
  });

  it('an explicit --dry-run beats --allow-prod in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });

  it('refuses --project with no value', () => {
    expect(() => parseArgs(['--project'])).toThrow(/requires a value/);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
  });
});

describe('planRepair', () => {
  it('rewrites the LOCAL literal to the in-vocabulary LOCAL_ONLY', () => {
    expect(planRepair(BROKEN).update.syncState).toBe('LOCAL_ONLY');
  });

  it('converts a Timestamp createdAt to the same instant as an ISO string', () => {
    const plan = planRepair(BROKEN);
    expect(plan.update.createdAt).toBe('2026-06-25T09:00:00.000Z');
    expect(plan.update.updatedAt).toBe('2026-06-25T09:00:00.000Z');
  });

  it('never touches anything but the three broken fields', () => {
    expect(Object.keys(planRepair(BROKEN).update).sort()).toEqual([
      'createdAt',
      'syncState',
      'updatedAt',
    ]);
  });

  /** Idempotent by construction: after one run a second run plans nothing. */
  it('plans nothing for a slot the importer wrote', () => {
    const plan = planRepair(IMPORTED);
    expect(plan.update).toEqual({});
    expect(plan.skip).toBe('already-decodable');
  });

  it('plans nothing for a slot this script has already repaired', () => {
    const repaired = { ...BROKEN, ...planRepair(BROKEN).update };
    expect(planRepair(repaired).update).toEqual({});
  });

  /** The refusal. An unknown value is reported, never guessed at. */
  it('refuses an out-of-vocabulary syncState it does not recognise', () => {
    const plan = planRepair({ ...IMPORTED, syncState: 'PENDING' });
    expect(plan.update).toEqual({});
    expect(plan.skip).toBe('unknown-sync-state');
    expect(plan.unknownSyncState).toBe('PENDING');
  });

  /**
   * A doc with no `syncState` at all decodes fine - the Kotlin model's default
   * fills in. Nothing to repair, and inventing a value would be a write with no
   * cause.
   */
  it('leaves a slot with no syncState alone', () => {
    const { syncState: _dropped, ...noState } = IMPORTED;
    expect(planRepair(noState).update).toEqual({});
  });

  /** The stamp half repairs on its own, even where syncState was already right. */
  it('repairs a Timestamp stamp on a slot whose syncState is fine', () => {
    const plan = planRepair({ ...IMPORTED, createdAt: BROKEN.createdAt });
    expect(plan.update).toEqual({ createdAt: '2026-06-25T09:00:00.000Z' });
  });

  it('agrees with the Android enum vocabulary', () => {
    expect([...VALID_SYNC_STATES].sort()).toEqual([
      'DISMISSED',
      'FAILED',
      'LOCAL_ONLY',
      'OVERRIDDEN',
      'SYNCED',
    ]);
  });
});
