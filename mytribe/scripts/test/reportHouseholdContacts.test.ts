import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dateOf,
  describeTarget,
  householdOf,
  initials,
  labelLooksEmergency,
  looksLikeMisplacedEc,
  maskEmail,
  maskPhone,
  parseArgs,
  reportLines,
  resolveTarget,
  rowFindingOf,
} from '../reportHouseholdContacts';

/**
 * #829's read-only contacts report (ruling 2026-09-27). It says which database
 * it reads before it reads one, cannot be pointed at production or the
 * emulator by accident, has no write mode, and never prints a full phone
 * number, email address or name.
 */
describe('reportHouseholdContacts target resolution', () => {
  it('REFUSES --allow-prod under the emulator, naming the host', () => {
    expect(() =>
      resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' }),
    ).toThrow(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST=127\.0\.0\.1:8385/);
  });

  it('reads the emulator without --allow-prod, and refuses production without it', () => {
    expect(resolveTarget(parseArgs([]), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' })).toEqual({
      kind: 'emulator',
      host: '127.0.0.1:8385',
      projectId: 'demo-report-829',
    });
    expect(() => resolveTarget(parseArgs([]), {})).toThrow(/would read PRODUCTION/);
  });

  it('reading production needs a project id it will not guess', () => {
    expect(() => resolveTarget(parseArgs(['--allow-prod']), {})).toThrow(/needs --project/);
    expect(resolveTarget(parseArgs(['--allow-prod', '--project', 'p1']), {})).toEqual({
      kind: 'production',
      projectId: 'p1',
    });
  });

  it('describes the target in one line', () => {
    expect(describeTarget({ kind: 'production', projectId: 'p1' })).toBe('Target: PRODUCTION, project p1');
  });

  it('has no apply flag: anything but --project and --allow-prod is refused', () => {
    for (const flag of ['--apply', '--write', '--fix', '--delete', '--migrate']) {
      expect(() => parseArgs([flag]), flag).toThrow(/unknown arg/);
    }
  });
});

describe('reportHouseholdContacts is read-only', () => {
  const src = readFileSync(join(__dirname, '..', 'reportHouseholdContacts.ts'), 'utf8');

  it('the source contains no write call at all', () => {
    for (const call of ['.set(', '.update(', '.delete(', '.add(', '.batch(', 'runTransaction(', '.create(', 'bulkWriter']) {
      expect(src.includes(call), call).toBe(false);
    }
  });
});

describe('reportHouseholdContacts masking', () => {
  it('keeps only the last four digits of a phone', () => {
    expect(maskPhone('(805) 555-0143')).toBe('…0143');
    expect(maskPhone('+18055550143')).toBe('…0143');
    expect(maskPhone('12')).toBe('…');
    expect(maskPhone('')).toBe('none');
    expect(maskPhone(null)).toBe('none');
    expect(maskPhone('call the barn')).toBe('(no digits)');
  });

  it('keeps the first letter and the domain of an email', () => {
    expect(maskEmail('ada.lovelace@example.com')).toBe('a…@example.com');
    expect(maskEmail('')).toBe('none');
    expect(maskEmail(undefined)).toBe('none');
    expect(maskEmail('no-at-sign')).toBe('(not an address)');
    expect(maskEmail('trailing@')).toBe('(not an address)');
  });

  it('reduces a name to initials', () => {
    expect(initials('Maria de los Angeles Rivera')).toBe('M. D. L. A. R.');
    expect(initials('  ada  ')).toBe('A.');
    expect(initials('')).toBe('none');
  });

  it('reads a created date without the time', () => {
    expect(dateOf({ toMillis: () => Date.parse('2026-09-12T10:00:00Z') })).toBe('2026-09-12');
    expect(dateOf('2026-09-13T23:59:00Z')).toBe('2026-09-13');
    expect(dateOf(null)).toBe('no date');
  });
});

describe('reportHouseholdContacts findings', () => {
  const kinfolk = {
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '805-555-0100',
    emergencyContacts: [{ name: 'Ruth Okafor', phone: '+18055550199', relationship: 'Neighbour' }],
  };
  const members = [{ displayName: 'Sam Halbrook', phone: '805 555 0111' }];

  it('reads the household Emergency Contact, including the legacy flat pair', () => {
    expect(householdOf(kinfolk, members).ec).toBe('yes');
    expect(householdOf({ emergencyContactName: 'Ruth', emergencyContactPhone: '8055550199' }, []).ec).toBe('legacy');
    expect(householdOf({ firstName: 'Jamie' }, []).ec).toBe('NO');
    expect(householdOf(null, []).kinfolkExists).toBe(false);
  });

  it('answers the four questions without printing the values it compared', () => {
    const h = householdOf(kinfolk, members);
    const row = rowFindingOf(
      'c1',
      { name: 'Ruth Okafor', label: 'Emergency', phone: '(805) 555-0199', email: 'ruth@example.org', createdAt: '2026-09-12T10:00:00Z' },
      h,
    );
    expect(row).toEqual({
      contactId: 'c1',
      label: 'Emergency',
      name: 'R. O.',
      phone: '…0199',
      email: 'r…@example.org',
      created: '2026-09-12',
      phoneMatchesEc: true,
      nameMatchesEc: true,
      matchesSomeoneInside: false,
      labelLooksEmergency: true,
    });
    expect(looksLikeMisplacedEc(row, h)).toBe(true);
  });

  it('flags a row that is somebody in the household as NOT a misplaced Emergency Contact', () => {
    const h = householdOf(kinfolk, members);
    const row = rowFindingOf('c2', { name: 'Sam Halbrook', label: 'Partner', phone: '8055550111' }, h);
    expect(row.matchesSomeoneInside).toBe(true);
    expect(looksLikeMisplacedEc(row, h)).toBe(false);
  });

  it('flags an outside person on a household with no Emergency Contact', () => {
    const h = householdOf({ firstName: 'Jamie', lastName: 'Halbrook', phoneNumber: '8055550100' }, []);
    const row = rowFindingOf('c3', { name: 'Pat Neighbour', label: 'Folk', phone: '8055550177' }, h);
    expect(looksLikeMisplacedEc(row, h)).toBe(true);
  });

  it('knows an emergency-sounding label', () => {
    for (const l of ['Emergency', 'emergency contact', 'EC', 'ICE', 'In case of emergency']) {
      expect(labelLooksEmergency(l), l).toBe(true);
    }
    for (const l of ['Folk', 'Sister', 'Neighbour', 'Dog walker', 'Grace']) {
      expect(labelLooksEmergency(l), l).toBe(false);
    }
  });

  it('prints no full phone, email or name anywhere in the report', () => {
    const h = householdOf(kinfolk, members);
    const lines = reportLines({
      contactsRows: 1,
      otherParentRows: 0,
      households: [
        {
          kinfolkId: 'fam1',
          household: h,
          rows: [rowFindingOf('c1', { name: 'Ruth Okafor', label: 'Neighbour', phone: '(805) 555-0199', email: 'ruth@example.org' }, h)],
        },
      ],
      kinfolkScanned: 13,
      kinfolkWithoutEc: 5,
    }).join('\n');
    expect(lines).toContain('household=fam1  rows=1  emergencyContact=yes');
    expect(lines).toContain('Households with no Emergency Contact at all: 5 of 13');
    for (const secret of ['Ruth', 'Okafor', '555-0199', '8055550199', 'ruth@', 'Jamie', 'Halbrook', '0100']) {
      expect(lines.includes(secret), secret).toBe(false);
    }
  });

  it('says plainly when there are no rows at all', () => {
    const lines = reportLines({ contactsRows: 0, otherParentRows: 0, households: [], kinfolkScanned: 13, kinfolkWithoutEc: 5 });
    expect(lines.join('\n')).toMatch(/CONTACTS ROWS: none found/);
  });
});
