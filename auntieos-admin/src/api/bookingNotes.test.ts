import { describe, it, expect } from 'vitest';
import { bookingNotesQuery, noteBody, noteAuthorLabel, noteCreatedMs, sortNotes } from './bookingNotes';

describe('bookingNotesQuery', () => {
  it('reads kinfolk-facing notes from the envelope notes subcollection', () => {
    expect(bookingNotesQuery('kf1', 'batch1', 'visit1', false)).toEqual({
      path: 'families/kf1/bookings/batch1/kinCares/visit1/notes',
      order: ['createdAt', 'asc'],
      max: 100,
    });
  });

  it('reads internal notes from internalNotes, the separate admin-only path', () => {
    // Not a field flag on one collection: firestore.rules draws the kinfolk
    // boundary at the PATH, so these are two different subcollections.
    expect(bookingNotesQuery('kf1', 'batch1', 'visit1', true).path).toBe(
      'families/kf1/bookings/batch1/kinCares/visit1/internalNotes',
    );
  });
});

describe('noteBody / noteAuthorLabel / noteCreatedMs', () => {
  it('reads a well-formed note', () => {
    expect(noteBody({ _id: 'n1', body: 'Fed the cat.' })).toBe('Fed the cat.');
    expect(noteAuthorLabel({ _id: 'n1', authorRole: 'admin' })).toBe('Auntie');
    expect(noteAuthorLabel({ _id: 'n1', authorRole: 'kinfolk' })).toBe('Kinfolk');
  });

  it('never throws on a legacy or partial note doc', () => {
    expect(noteBody({ _id: 'n1' })).toBe('');
    expect(noteAuthorLabel({ _id: 'n1' })).toBe('Unknown');
    expect(noteCreatedMs({ _id: 'n1' })).toBe(0);
  });

  it('reads createdAt whether it arrives as a Timestamp or as ISO text', () => {
    const iso = '2026-07-16T14:00:00.000Z';
    expect(noteCreatedMs({ _id: 'n1', createdAt: iso })).toBe(Date.parse(iso));
    expect(
      noteCreatedMs({ _id: 'n1', createdAt: { toDate: () => new Date(iso) } as never }),
    ).toBe(Date.parse(iso));
  });
});

describe('sortNotes', () => {
  it('orders oldest first so a thread reads top to bottom', () => {
    const rows = [
      { _id: 'b', body: 'second', createdAt: '2026-07-16T15:00:00.000Z' },
      { _id: 'a', body: 'first', createdAt: '2026-07-16T14:00:00.000Z' },
    ];
    expect(sortNotes(rows).map((n) => n._id)).toEqual(['a', 'b']);
  });

  it('keeps undated notes at the top rather than dropping them', () => {
    const rows = [
      { _id: 'b', body: 'dated', createdAt: '2026-07-16T15:00:00.000Z' },
      { _id: 'a', body: 'pending server stamp' },
    ];
    expect(sortNotes(rows).map((n) => n._id)).toEqual(['a', 'b']);
  });

  it('does not mutate the caller array (it is a live snapshot)', () => {
    const rows = [
      { _id: 'b', createdAt: '2026-07-16T15:00:00.000Z' },
      { _id: 'a', createdAt: '2026-07-16T14:00:00.000Z' },
    ];
    sortNotes(rows);
    expect(rows.map((n) => n._id)).toEqual(['b', 'a']);
  });
});
