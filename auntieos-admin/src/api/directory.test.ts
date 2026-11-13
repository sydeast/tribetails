import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import {
  kinfolkDisplayName,
  householdLabel,
  kinfolkSurnameSortKey,
  matchesKinfolk,
  matchesKin,
  activeKinByKinfolk,
  kinSummaryOf,
  householdSubtitle,
  initialsOf,
  filterSortKinfolk,
  filterSortKin,
  tagNamesOf,
  tagFilterOptions,
  matchesTag,
  KIN_QUERY,
  type Kinfolk,
  type Kin,
} from './directory';
import { KIN_CARE_QUERY } from './kinCare';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function kinfolk(over: Partial<Kinfolk>): Kinfolk {
  return {
    _id: 'kf1',
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '(512) 555-1234',
    email: 'jamie@example.com',
    profilePictureUrl: '',
    status: 'active',
    joinDate: '',
    ...over,
  };
}

function kin(over: Partial<Kin>): Kin {
  return {
    _id: 'k1',
    kinfolkId: 'kf1',
    name: 'Biscuit',
    species: 'Dog',
    breed: 'Corgi',
    age: '3',
    sex: 'Female',
    status: 'active',
    profilePictureUrl: '',
    ...over,
  };
}

describe('kinfolkDisplayName', () => {
  it('joins first + last', () => {
    expect(kinfolkDisplayName({ firstName: 'Jamie', lastName: 'Halbrook' })).toBe('Jamie Halbrook');
  });
  it('falls back to "Unnamed Kinfolk" when both are blank', () => {
    expect(kinfolkDisplayName({ firstName: '', lastName: '' })).toBe('Unnamed Kinfolk');
    expect(kinfolkDisplayName({ firstName: '  ', lastName: ' ' })).toBe('Unnamed Kinfolk');
  });
});

describe('householdLabel', () => {
  it('pluralizes a plain surname with a bare s', () => {
    expect(householdLabel('Halbrook')).toBe('the Halbrooks');
  });
  it('adds "es" for a sibilant ending', () => {
    expect(householdLabel('Brooks')).toBe('the Brookses');
    expect(householdLabel('Marx')).toBe('the Marxes');
    expect(householdLabel('Finch')).toBe('the Finches');
    expect(householdLabel('Nash')).toBe('the Nashes');
  });
  it('returns "" for a blank surname', () => {
    expect(householdLabel('')).toBe('');
    expect(householdLabel('   ')).toBe('');
  });
});

describe('kinfolkSurnameSortKey', () => {
  it('orders by last name then first, lowercased', () => {
    expect(kinfolkSurnameSortKey({ firstName: 'Jamie', lastName: 'Halbrook' })).toBe('halbrook jamie');
  });
  it('falls back to the display name when last name is blank', () => {
    expect(kinfolkSurnameSortKey({ firstName: 'Jamie', lastName: '' })).toBe('jamie');
  });
});

describe('matchesKinfolk', () => {
  it('matches on name substring, case-insensitive', () => {
    expect(matchesKinfolk(kinfolk({}), 'jamie')).toBe(true);
    expect(matchesKinfolk(kinfolk({}), 'JAMIE HAL')).toBe(true);
    expect(matchesKinfolk(kinfolk({}), 'nope')).toBe(false);
  });
  it('matches on email substring', () => {
    expect(matchesKinfolk(kinfolk({}), 'example.com')).toBe(true);
  });
  it('matches a bare-digit query against a formatted phone number', () => {
    expect(matchesKinfolk(kinfolk({}), '1234')).toBe(true);
    expect(matchesKinfolk(kinfolk({}), '5125551234')).toBe(true);
    expect(matchesKinfolk(kinfolk({}), '9999')).toBe(false);
  });
  it('a blank query matches everything', () => {
    expect(matchesKinfolk(kinfolk({}), '   ')).toBe(true);
  });
});

/**
 * #1952: "zzzz8" listed every household whose phone has an 8, because the
 * digits were pulled out of any text and matched alone. A phone is searched
 * only when the text reads as a phone number.
 */
describe('matchesKinfolk phone search (#1952)', () => {
  const kf = kinfolk({ firstName: 'Tess', lastName: 'Quill', email: 'catch@hanasamku.com', phoneNumber: '(805) 555-0188' });

  it('text with letters and a digit never matches on the phone', () => {
    expect(matchesKinfolk(kf, 'zzzz8')).toBe(false);
    expect(matchesKinfolk(kf, 'Tes1')).toBe(false);
    expect(matchesKinfolk(kf, 'catch1@')).toBe(false);
  });

  it('a name or email fragment holding a digit still matches on the name or email', () => {
    const digitEmail = kinfolk({ email: 'e2e-admin@tribetails.com', phoneNumber: '(805) 555-0100' });
    expect(matchesKinfolk(digitEmail, 'e2e')).toBe(true);
    expect(matchesKinfolk(kinfolk({ firstName: 'Unit 4', lastName: 'Hall', phoneNumber: '' }), 'unit 4')).toBe(true);
  });

  it('one or two digits alone are too short to search phones', () => {
    expect(matchesKinfolk(kf, '8')).toBe(false);
    expect(matchesKinfolk(kf, '88')).toBe(false);
  });

  it('an area code, the last four, or a full number in any common format matches', () => {
    expect(matchesKinfolk(kf, '805')).toBe(true);
    expect(matchesKinfolk(kf, '0188')).toBe(true);
    expect(matchesKinfolk(kf, '805-555-0188')).toBe(true);
    expect(matchesKinfolk(kf, '(805) 555-0188')).toBe(true);
    expect(matchesKinfolk(kf, '805.555.0188')).toBe(true);
    expect(matchesKinfolk(kf, '+1 805 555 0188')).toBe(true);
    expect(matchesKinfolk(kinfolk({ phoneNumber: '+18055550188' }), '805 555 0188')).toBe(true);
  });

  it('a phone-shaped query that is not in the number does not match', () => {
    expect(matchesKinfolk(kf, '555-0199')).toBe(false);
    expect(matchesKinfolk(kinfolk({ phoneNumber: '' }), '0188')).toBe(false);
  });
});

describe('matchesKin', () => {
  it('matches name, species, or breed substrings', () => {
    expect(matchesKin(kin({}), 'biscuit')).toBe(true);
    expect(matchesKin(kin({}), 'dog')).toBe(true);
    expect(matchesKin(kin({}), 'corgi')).toBe(true);
    expect(matchesKin(kin({}), 'iguana')).toBe(false);
  });
});

describe('activeKinByKinfolk', () => {
  it('groups by kinfolkId and excludes archived kin', () => {
    const rows = [
      kin({ _id: 'a', kinfolkId: 'kf1', name: 'Biscuit' }),
      kin({ _id: 'b', kinfolkId: 'kf1', name: 'Gravy', status: 'archived' }),
      kin({ _id: 'c', kinfolkId: 'kf2', name: 'Nacho' }),
    ];
    const map = activeKinByKinfolk(rows);
    expect(map.get('kf1')?.map((k) => k._id)).toEqual(['a']);
    expect(map.get('kf2')?.map((k) => k._id)).toEqual(['c']);
    expect(map.get('kf3')).toBeUndefined();
  });
});

describe('kinSummaryOf', () => {
  it('empty list -> ""', () => {
    expect(kinSummaryOf([])).toBe('');
  });
  it('one pet -> its name', () => {
    expect(kinSummaryOf([kin({ name: 'Biscuit' })])).toBe('Biscuit');
  });
  it('two pets -> both joined, no "more"', () => {
    expect(kinSummaryOf([kin({ name: 'Biscuit' }), kin({ name: 'Gravy' })])).toBe('Biscuit, Gravy');
  });
  it('three+ pets -> first two plus a count', () => {
    expect(
      kinSummaryOf([kin({ name: 'Biscuit' }), kin({ name: 'Gravy' }), kin({ name: 'Nacho' })]),
    ).toBe('Biscuit, Gravy & 1 more');
  });
});

describe('householdSubtitle', () => {
  it('prefers the household label when a last name is on file', () => {
    expect(householdSubtitle({ lastName: 'Halbrook' }, [kin({ name: 'Biscuit' })])).toBe(
      'the Halbrooks',
    );
  });
  it('falls back to a kin summary when there is no last name', () => {
    expect(householdSubtitle({ lastName: '' }, [kin({ name: 'Biscuit' })])).toBe('Biscuit');
  });
  it('is "" when there is neither a last name nor any kin', () => {
    expect(householdSubtitle({ lastName: '' }, [])).toBe('');
  });
});

describe('initialsOf', () => {
  it('two-word name -> first letter of each', () => {
    expect(initialsOf('John Smith')).toBe('JS');
  });
  it('one-word name -> first two letters', () => {
    expect(initialsOf('Cher')).toBe('CH');
  });
  it('blank name -> "?"', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
  it('three-word name uses first and LAST word, not the middle', () => {
    expect(initialsOf('Mary Jane Watson')).toBe('MW');
  });
});

describe('filterSortKinfolk', () => {
  const rows = [
    kinfolk({ _id: 'a', firstName: 'Zack', lastName: 'Young', joinDate: '2026-01-01' }),
    kinfolk({ _id: 'b', firstName: 'Amy', lastName: 'Adams', joinDate: '2026-06-01' }),
  ];

  it('sorts alpha_asc by surname', () => {
    expect(filterSortKinfolk(rows, '', 'alpha_asc').map((r) => r._id)).toEqual(['b', 'a']);
  });
  it('sorts alpha_desc by surname', () => {
    expect(filterSortKinfolk(rows, '', 'alpha_desc').map((r) => r._id)).toEqual(['a', 'b']);
  });
  it('sorts recently_updated by the last change, not by joinDate (#2155)', () => {
    const edited = [
      kinfolk({ _id: 'a', firstName: 'Zack', lastName: 'Young', joinDate: '2026-01-01', updatedAt: fakeTs('2026-11-12T08:00:00.000Z') }),
      kinfolk({ _id: 'b', firstName: 'Amy', lastName: 'Adams', joinDate: '2026-06-01', updatedAt: fakeTs('2026-07-01T00:00:00.000Z') }),
    ];
    expect(filterSortKinfolk(edited, '', 'recently_updated').map((r) => r._id)).toEqual(['a', 'b']);
  });
  it('filters by the query before sorting', () => {
    expect(filterSortKinfolk(rows, 'amy', 'alpha_asc').map((r) => r._id)).toEqual(['b']);
  });
});

/**
 * #1953: "Recently Created" sorted on `joinDate`, which Add Kinfolk writes
 * blank, so two households made minutes ago sat 11th and 13th of 14. The
 * creation stamp is `createdAt`, written by the createKinfolk callable.
 */
describe('Recently Created (#1953)', () => {
  const ids = (rows: Kinfolk[]) => filterSortKinfolk(rows, '', 'recently_created').map((r) => r._id);

  it('puts the households made minutes ago first, newest first, though their join date is blank', () => {
    const rows = [
      kinfolk({ _id: 'old', lastName: 'Adams', joinDate: '2026-06-01' }),
      kinfolk({ _id: 'first', lastName: 'Brook', createdAt: fakeTs('2026-11-10T15:00:00.000Z'), joinDate: '' }),
      kinfolk({ _id: 'none', lastName: 'Cole', joinDate: '' }),
      kinfolk({ _id: 'second', lastName: 'Dale', createdAt: fakeTs('2026-11-10T15:04:00.000Z'), joinDate: '' }),
    ];
    expect(ids(rows)).toEqual(['second', 'first', 'old', 'none']);
  });

  it('#2171: a join date sits on the same timeline as a creation stamp, not below every stamped one', () => {
    const rows = [
      kinfolk({ _id: 'joined-today', lastName: 'Adams', joinDate: '2026-11-12' }),
      kinfolk({ _id: 'stamped', lastName: 'Brook', createdAt: fakeTs('2026-10-01T12:00:00.000Z') }),
      kinfolk({ _id: 'joined-2025', lastName: 'Cole', joinDate: '2025-03-04T10:00:00.000Z' }),
    ];
    expect(ids(rows)).toEqual(['joined-today', 'stamped', 'joined-2025']);
  });

  it('never orders by an import date: a createdAt marked import falls back to the join date', () => {
    const rows = [
      kinfolk({ _id: 'imported', lastName: 'Adams', createdAt: fakeTs('2026-11-11T00:00:00.000Z'), createdAtSource: 'import', joinDate: '2025-02-01' }),
      kinfolk({ _id: 'live', lastName: 'Brook', createdAt: fakeTs('2026-09-01T00:00:00.000Z'), createdAtSource: 'live' }),
      kinfolk({ _id: 'original', lastName: 'Cole', createdAt: '2025-01-15T09:00:00Z', createdAtSource: 'original' }),
    ];
    expect(ids(rows)).toEqual(['live', 'imported', 'original']);
  });

  it('#2171: a migrated household sorts by the old system creation date, below a newer household and above an older one', () => {
    const rows = [
      kinfolk({ _id: 'older', lastName: 'Adams', createdAt: '2021-08-15T10:30:00Z', createdAtSource: 'original' }),
      kinfolk({ _id: 'migrated', lastName: 'Brook', createdAt: '2024-03-02T09:00:00.000Z', createdAtSource: 'original', joinDate: '2025-06-01' }),
      kinfolk({ _id: 'auntieos', lastName: 'Cole', createdAt: fakeTs('2026-11-10T15:04:00.000Z'), createdAtSource: 'live' }),
      kinfolk({ _id: 'joined-older', lastName: 'Dale', joinDate: '2022-04-01' }),
    ];
    // The migrated row's own join date (2025-06-01) is not read: it has an original creation date.
    expect(ids(rows)).toEqual(['auntieos', 'migrated', 'joined-older', 'older']);
  });

  it('reads createdAt as a Timestamp, a {seconds} object or an ISO string, and compares instants, not text', () => {
    const rows = [
      kinfolk({ _id: 'iso-no-ms', lastName: 'Adams', createdAt: '2026-11-10T15:00:01Z' }),
      kinfolk({ _id: 'seconds', lastName: 'Brook', createdAt: { seconds: Date.parse('2026-11-10T15:00:00.500Z') / 1000, nanoseconds: 0 } }),
      kinfolk({ _id: 'iso-ms', lastName: 'Cole', createdAt: '2026-11-10T15:00:00.900Z' }),
    ];
    expect(ids(rows)).toEqual(['iso-no-ms', 'iso-ms', 'seconds']);
  });

  it('records with no date at all sort last, A to Z among themselves; unreadable text is no date', () => {
    const rows = [
      kinfolk({ _id: 'z', firstName: 'Zed', lastName: 'Young', joinDate: '' }),
      kinfolk({ _id: 'junk', firstName: 'Ann', lastName: 'Adams', joinDate: '07/24/2026', createdAt: 'sometime' }),
      kinfolk({ _id: 'dated', lastName: 'Mills', joinDate: '2025-05-05' }),
      kinfolk({ _id: 'nullstamp', firstName: 'Bo', lastName: 'Brook', createdAt: null }),
    ];
    expect(ids(rows)).toEqual(['dated', 'junk', 'nullstamp', 'z']);
  });
});

/**
 * #2171 / #2155: ONE fixture, the same ids, instants and expected orders as
 * Android `DirectorySortTest` and desktop `DirectoryViewModelTest`
 * ("shared date-sort fixture"), so the three clients are held to one order.
 * Timestamps are Firestore Timestamps here; the other clients carry the same
 * instants in their own stored shapes.
 */
describe('shared date-sort fixture (#2171, #2155)', () => {
  const fixture: Kinfolk[] = [
    kinfolk({ _id: 'auntie-new', firstName: 'Bea', lastName: 'Brook', createdAt: fakeTs('2026-11-10T15:04:00.000Z'), createdAtSource: 'live' }),
    kinfolk({ _id: 'migrated-mid', firstName: 'Cal', lastName: 'Cole', createdAt: '2024-03-02T09:00:00.000Z', createdAtSource: 'original', joinDate: '2025-06-01', updatedAt: '2026-11-12T08:00:00Z' }),
    kinfolk({ _id: 'migrated-old', firstName: 'Eve', lastName: 'Earl', createdAt: '2021-08-15T10:30:00Z', createdAtSource: 'original', updatedAt: '2026-11-11T20:00:00Z' }),
    kinfolk({ _id: 'joined-only', firstName: 'Amy', lastName: 'Adams', joinDate: '2022-04-01', updatedAt: fakeTs('2026-11-11T20:00:00.500Z') }),
    kinfolk({ _id: 'imported-unknown', firstName: 'Fay', lastName: 'Ford', createdAt: fakeTs('2026-11-11T00:00:00.000Z'), createdAtSource: 'import', joinDate: '2020-02-02' }),
    kinfolk({ _id: 'tie-grant', firstName: 'Gus', lastName: 'Grant', createdAt: '2026-09-01T00:00:00.000Z' }),
    kinfolk({ _id: 'tie-hill', firstName: 'Hal', lastName: 'Hill', createdAt: '2026-09-01T00:00:00Z' }),
    kinfolk({ _id: 'no-date', firstName: 'Zed', lastName: 'Young' }),
    kinfolk({ _id: 'no-date-junk', firstName: 'Ann', lastName: 'Abbot', joinDate: '07/24/2026', createdAt: 'sometime', updatedAt: 'yesterday' }),
  ];
  const order = (sort: 'recently_created' | 'recently_updated') =>
    filterSortKinfolk(fixture, '', sort).map((r) => r._id);

  it('Recently Created is one timeline: auntieOS stamp, else the old system date, else the join date; undated last A to Z', () => {
    expect(order('recently_created')).toEqual([
      'auntie-new', 'tie-grant', 'tie-hill', 'migrated-mid', 'joined-only', 'migrated-old', 'imported-unknown',
      'no-date-junk', 'no-date',
    ]);
  });

  it('Recently Updated follows the last change, compares instants not text, and falls back to the creation date', () => {
    expect(order('recently_updated')).toEqual([
      'migrated-mid', 'joined-only', 'migrated-old', 'auntie-new', 'tie-grant', 'tie-hill', 'imported-unknown',
      'no-date-junk', 'no-date',
    ]);
  });
});

/**
 * #713: "tags are just labels and not actual tags which act like a filter."
 * These are the pure halves of the Directory's tag filter.
 */
describe('tag filtering', () => {
  it('reads only the string entries off a tags field', () => {
    expect(tagNamesOf({ tags: ['VIP', 7, null, 'Slow pay'] })).toEqual(['VIP', 'Slow pay']);
    expect(tagNamesOf({ tags: 'VIP' })).toEqual([]);
    expect(tagNamesOf({})).toEqual([]);
  });

  it('offers every distinct tag on the rows, alphabetically, collapsing casing', () => {
    const rows = [{ tags: ['Slow pay', 'VIP'] }, { tags: ['vip', 'Allergy'] }, { tags: [] }];
    expect(tagFilterOptions(rows)).toEqual(['Allergy', 'Slow pay', 'VIP']);
  });

  it('offers nothing when no row carries a tag, so the control can hide itself', () => {
    expect(tagFilterOptions([{ tags: [] }, {}])).toEqual([]);
  });

  it('matches case- and whitespace-insensitively, the rule the chips resolve by', () => {
    expect(matchesTag({ tags: ['  vip '] }, 'VIP')).toBe(true);
    expect(matchesTag({ tags: ['VIP'] }, 'Slow pay')).toBe(false);
  });

  it('a blank tag narrows nothing', () => {
    expect(matchesTag({ tags: [] }, '')).toBe(true);
    expect(matchesTag({}, '   ')).toBe(true);
  });

  it('narrows the household list, on top of the search query', () => {
    const rows = [
      kinfolk({ _id: 'a', firstName: 'Jamie', lastName: 'Halbrook', tags: ['VIP'] }),
      kinfolk({ _id: 'b', firstName: 'Amy', lastName: 'Adams', tags: ['Slow pay'] }),
      kinfolk({ _id: 'c', firstName: 'Ros', lastName: 'Vance' }),
    ];
    expect(filterSortKinfolk(rows, '', 'alpha_asc', 'VIP').map((r) => r._id)).toEqual(['a']);
    expect(filterSortKinfolk(rows, 'amy', 'alpha_asc', 'VIP')).toEqual([]);
    // Omitted (the pre-#713 call shape) still means "every row".
    expect(filterSortKinfolk(rows, '', 'alpha_asc')).toHaveLength(3);
  });

  it('narrows the Kin list, and still excludes archived kin', () => {
    const rows = [
      kin({ _id: 'a', name: 'Biscuit', tags: ['Reactive'] }),
      kin({ _id: 'b', name: 'Gravy', tags: ['On meds'] }),
      kin({ _id: 'c', name: 'Old', status: 'archived', tags: ['Reactive'] }),
    ];
    expect(filterSortKin(rows, '', 'alpha_asc', 'Reactive').map((r) => r._id)).toEqual(['a']);
  });
});

describe('filterSortKin', () => {
  const rows = [
    kin({ _id: 'a', name: 'Zeke', updatedAt: fakeTs('2026-01-01T00:00:00Z') }),
    kin({ _id: 'b', name: 'Ann', updatedAt: fakeTs('2026-06-01T00:00:00Z') }),
    kin({ _id: 'c', name: 'Old', status: 'archived', updatedAt: fakeTs('2026-07-01T00:00:00Z') }),
  ];

  it('excludes archived kin regardless of sort or query', () => {
    expect(filterSortKin(rows, '', 'alpha_asc').some((r) => r._id === 'c')).toBe(false);
  });
  it('sorts alpha_asc / alpha_desc by name', () => {
    expect(filterSortKin(rows, '', 'alpha_asc').map((r) => r._id)).toEqual(['b', 'a']);
    expect(filterSortKin(rows, '', 'alpha_desc').map((r) => r._id)).toEqual(['a', 'b']);
  });
  it('sorts recently_updated by the real updatedAt Timestamp, newest first', () => {
    expect(filterSortKin(rows, '', 'recently_updated').map((r) => r._id)).toEqual(['b', 'a']);
  });
  it('a kin with no updatedAt sorts last under recently_updated, never fabricated as newest', () => {
    // Omit the key entirely (never present) rather than set it to `undefined`, 
    // exactOptionalPropertyTypes distinguishes the two, and "absent" is what a
    // real doc that predates the field looks like.
    const { updatedAt: _drop, ...withoutUpdatedAt } = kin({ _id: 'd', name: 'Mystery' });
    const withMissing = [...rows, withoutUpdatedAt as Kin];
    const sorted = filterSortKin(withMissing, '', 'recently_updated');
    expect(sorted[sorted.length - 1]?._id).toBe('d');
  });
});
/**
 * Regression cover for the 2026-07-21 "invisible Kin" defect: KIN_QUERY and
 * KIN_CARE_QUERY both ordered the flat `kin` mirror by `updatedAt`, which the
 * 2026-07-20 live model audit measured on 23 of 24 real docs. Firestore's
 * `orderBy` EXCLUDES any document missing the sort field, so one live Kin
 * rendered in neither the Directory Kin tab nor the Care Flags join, silently.
 *
 * `survivesOrderBy` models exactly that Firestore rule and nothing else. It is
 * the whole point of these tests: asserting the literal string `'__name__'`
 * alone would pass for any typo, whereas running the real exclusion rule over
 * documents that are each missing a different field proves the chosen key
 * cannot hide a row.
 */
function survivesOrderBy<T extends object>(docs: readonly T[], orderField: string): T[] {
  // A document id is not a document FIELD; every document has one, so this key
  // excludes nothing. Any other key is a field, and Firestore returns a doc only
  // when that field is present on it.
  if (orderField === '__name__') return [...docs];
  return docs.filter((d) => orderField in d);
}
describe('KIN_QUERY / KIN_CARE_QUERY ordering cannot hide a Kin', () => {
  // Four real writer shapes for a flat `kin` doc. No single FIELD is present on
  // all four, which is the finding that ruled out simply moving the sort to a
  // different field (see the KIN_QUERY doc comment for the writer-by-writer
  // trace).
  const fromMirrorTrigger = { _id: 'trigger', updatedAt: 'ts', familyKinPath: 'families/kf1/kin/a' };
  const fromReactCreateKin = { _id: 'react', updatedAt: 'ts' }; // directoryWrite.ts, no familyKinPath
  const fromAndroidCreateKin = { _id: 'android', familyKinPath: 'families/kf1/kin/c' }; // no updatedAt stamp
  const legacyDoc = { _id: 'legacy' }; // the 24th doc: predates both stamps
  const allWriterShapes = [fromMirrorTrigger, fromReactCreateKin, fromAndroidCreateKin, legacyDoc];
  it('returns every writer shape, including docs with no updatedAt', () => {
    const survivors = survivesOrderBy(allWriterShapes, KIN_QUERY.order[0]).map((d) => d._id);
    expect(survivors).toEqual(['trigger', 'react', 'android', 'legacy']);
  });
  it('Care Flags reads the same complete roster, so an all-clear is never a dropped row', () => {
    const survivors = survivesOrderBy(allWriterShapes, KIN_CARE_QUERY.order[0]).map((d) => d._id);
    expect(survivors).toEqual(['trigger', 'react', 'android', 'legacy']);
  });
  it('the two kin streams order identically, so the Directory and Care Flags rosters cannot drift', () => {
    expect(KIN_CARE_QUERY.order).toEqual(KIN_QUERY.order);
    expect(KIN_CARE_QUERY.path).toBe(KIN_QUERY.path);
  });
  it('pins the harness itself: a field-name sort key really does drop a doc missing it', () => {
    // Guards against survivesOrderBy silently degrading to "return everything",
    // which would make the two tests above pass no matter what order is chosen.
    expect(survivesOrderBy(allWriterShapes, 'updatedAt').map((d) => d._id)).toEqual([
      'trigger',
      'react',
    ]);
    expect(survivesOrderBy(allWriterShapes, 'familyKinPath').map((d) => d._id)).toEqual([
      'trigger',
      'android',
    ]);
  });
  it('sorts ascending, which keeps the sandbox kinfolkId scope composite-index-free', () => {
    expect(KIN_QUERY.order[1]).toBe('asc');
    expect(KIN_CARE_QUERY.order[1]).toBe('asc');
  });
});
