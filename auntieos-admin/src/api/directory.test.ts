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
  type Kinfolk,
  type Kin,
} from './directory';

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
  it('sorts recently_created and recently_updated by joinDate (both proxy the same field)', () => {
    expect(filterSortKinfolk(rows, '', 'recently_created').map((r) => r._id)).toEqual(['b', 'a']);
    expect(filterSortKinfolk(rows, '', 'recently_updated').map((r) => r._id)).toEqual(['b', 'a']);
  });
  it('filters by the query before sorting', () => {
    expect(filterSortKinfolk(rows, 'amy', 'alpha_asc').map((r) => r._id)).toEqual(['b']);
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
