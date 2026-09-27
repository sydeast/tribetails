import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Timestamp } from 'firebase-admin/firestore';
import { findingOf, parseArgs, reportLines, reportOf, resolveTarget } from '../reportMultipleEmergencyContacts';

/**
 * The read-only count of households with more than one Emergency Contact
 * (operator ruling 2026-09-27, Q2: one per household). It says which database
 * it reads, cannot be pointed at production or the emulator by accident, has
 * no write mode, and never prints a full phone number or name.
 */
describe('reportMultipleEmergencyContacts target resolution', () => {
  it('REFUSES --allow-prod under the emulator, and refuses production without it', () => {
    expect(() => resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' })).toThrow(
      /refusing --allow-prod while FIRESTORE_EMULATOR_HOST/,
    );
    expect(() => resolveTarget(parseArgs([]), {})).toThrow(/would read PRODUCTION/);
    expect(resolveTarget(parseArgs(['--allow-prod', '--project', 'p1']), {})).toEqual({ kind: 'production', projectId: 'p1' });
  });

  it('has no apply flag: anything but --project and --allow-prod is refused', () => {
    for (const flag of ['--apply', '--write', '--fix', '--delete', '--dedupe']) {
      expect(() => parseArgs([flag]), flag).toThrow(/unknown arg/);
    }
  });
});

describe('reportMultipleEmergencyContacts is read-only', () => {
  const src = readFileSync(join(__dirname, '..', 'reportMultipleEmergencyContacts.ts'), 'utf8');

  it('the source contains no write call at all', () => {
    for (const call of ['.set(', '.update(', '.delete(', '.add(', '.batch(', 'runTransaction(', '.create(', 'bulkWriter']) {
      expect(src.includes(call), call).toBe(false);
    }
  });
});

describe('reportMultipleEmergencyContacts counting', () => {
  const t = Timestamp.fromDate(new Date('2026-03-04T12:00:00Z'));
  const two = {
    emergencyContacts: [
      { name: 'Rae Mercer', phone: '+18055550199', relationship: null, recordedAt: t, updatedAt: t },
      { name: 'Lee Park', phone: '+18055550177', relationship: 'Friend', recordedAt: null, updatedAt: null },
    ],
  };
  const one = { emergencyContacts: [{ name: 'Sam Ortiz', phone: '+18055550111' }] };
  const legacyOne = { emergencyContactName: 'Ada Stone', emergencyContactPhone: '805-555-0122' };

  it('counts none, one (the legacy flat pair included) and more than one', () => {
    const r = reportOf([
      { id: 'b', data: two },
      { id: 'a', data: one },
      { id: 'c', data: legacyOne },
      { id: 'd', data: {} },
    ]);
    expect(r).toMatchObject({ scanned: 4, none: 1, one: 2 });
    expect(r.over.map((h) => h.kinfolkId)).toEqual(['b']);
  });

  it('masks each contact to initials and the last four digits, with the recorded date', () => {
    expect(findingOf('b', two).finding?.contacts).toEqual([
      { name: 'R. M.', phone: '…0199', recorded: '2026-03-04' },
      { name: 'L. P.', phone: '…0177', recorded: 'no date' },
    ]);
  });

  it('prints no full name or phone, and says when there are none', () => {
    const text = reportLines(reportOf([{ id: 'b', data: two }])).join('\n');
    expect(text).toContain('More than one: 1.');
    expect(text).toContain('household=b  contacts=2');
    for (const secret of ['Rae', 'Mercer', 'Lee Park', '8055550199', '5550177']) expect(text).not.toContain(secret);
    expect(reportLines(reportOf([{ id: 'a', data: one }])).join('\n')).toContain('MORE THAN ONE: none found.');
  });
});
