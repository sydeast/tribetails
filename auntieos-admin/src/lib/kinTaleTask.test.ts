import { describe, it, expect } from 'vitest';
import {
  KIN_TALE_REQUIRED_DEFAULT,
  kinTaleOwed,
  kinTaleRequiredFrom,
  kinTaleSent,
  splitOwedKinTales,
} from './kinTaleTask';

/**
 * #2123: the Auntie's "Send the KinTale" task. The same rule as the server's
 * `functions/src/lib/kinTaleRequirement.ts` and the Android and desktop copies.
 */
describe('kinTaleRequiredFrom: absent reads off (ruling 2026-11-13, "Start it off")', () => {
  it('only an explicit true is on', () => {
    expect(KIN_TALE_REQUIRED_DEFAULT).toBe(false);
    expect(kinTaleRequiredFrom(undefined)).toBe(false);
    expect(kinTaleRequiredFrom({})).toBe(false);
    expect(kinTaleRequiredFrom({ businessName: 'Tribe' })).toBe(false);
    expect(kinTaleRequiredFrom({ kinTaleRequired: true })).toBe(true);
    expect(kinTaleRequiredFrom({ kinTaleRequired: false })).toBe(false);
    expect(kinTaleRequiredFrom({ kinTaleRequired: 'true' })).toBe(false);
  });
});

describe('kinTaleSent', () => {
  it('a sent count, and nothing else', () => {
    expect(kinTaleSent({ sentReportCount: 2 })).toBe(true);
    expect(kinTaleSent({})).toBe(false);
    expect(kinTaleSent({ sentReportCount: 0 })).toBe(false);
    // Android lists a draft's id on `reportIds` when it is created.
    expect(kinTaleSent({ reportIds: ['draft1'] } as never)).toBe(false);
  });
});

describe('kinTaleOwed', () => {
  const owed = { status: 'COMPLETED', kinTaleDue: true };

  it('a completed visit the server left owing, with nothing sent, while required', () => {
    expect(kinTaleOwed(owed, true)).toBe(true);
  });

  it('never while the switch is off', () => {
    expect(kinTaleOwed(owed, false)).toBe(false);
  });

  it('never once a KinTale is out, even before the flag is cleared', () => {
    expect(kinTaleOwed({ ...owed, sentReportCount: 1 }, true)).toBe(false);
    expect(kinTaleOwed({ ...owed, kinTaleDue: false }, true)).toBe(false);
  });

  it('never for a visit that is not Completed, or one the server never flagged', () => {
    expect(kinTaleOwed({ ...owed, status: 'DEPARTED' }, true)).toBe(false);
    expect(kinTaleOwed({ ...owed, status: 'CANCELLED' }, true)).toBe(false);
    expect(kinTaleOwed({ status: 'COMPLETED' }, true)).toBe(false);
  });
});

describe('splitOwedKinTales', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, status: 'COMPLETED', ...extra });

  it('takes owed visits out of the board rows and adds the older ones the board does not hold', () => {
    const board = [row('a', { kinTaleDue: true }), row('b'), row('c', { status: 'SCHEDULED' })];
    const due = [row('a', { kinTaleDue: true }), row('old', { kinTaleDue: true })];
    const { owed, rest } = splitOwedKinTales(board, due, true);
    expect(owed.map((r) => r._id)).toEqual(['a', 'old']);
    expect(rest.map((r) => r._id)).toEqual(['b', 'c']);
  });

  it('with the switch off nothing is owed and the board is untouched', () => {
    const board = [row('a', { kinTaleDue: true })];
    const { owed, rest } = splitOwedKinTales(board, [row('old', { kinTaleDue: true })], false);
    expect(owed).toEqual([]);
    expect(rest).toBe(board);
  });

  it('a due row that has since been sent drops out', () => {
    const { owed } = splitOwedKinTales([], [row('x', { kinTaleDue: true, sentReportCount: 1 })], true);
    expect(owed).toEqual([]);
  });
});
