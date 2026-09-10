import { describe, it, expect } from 'vitest';
import { mergeUserProfile, splitLegacyFullName } from './account';

/**
 * `getUserProfile` itself is a bare `getDoc`; what is worth testing is the
 * merge it runs over whatever the document happens to hold, which is the only
 * thing standing between a legacy `users/{uid}` doc and a blank Account screen.
 */

describe('splitLegacyFullName', () => {
  it('splits on the last space', () => {
    expect(splitLegacyFullName('Nora Brooks')).toEqual({ firstName: 'Nora', lastName: 'Brooks' });
  });

  it('keeps a middle name with the first name rather than dropping it', () => {
    expect(splitLegacyFullName('Ana Maria Brooks')).toEqual({
      firstName: 'Ana Maria',
      lastName: 'Brooks',
    });
  });

  it('treats a single word as all first name', () => {
    expect(splitLegacyFullName('Auntie')).toEqual({ firstName: 'Auntie', lastName: '' });
  });

  it('collapses stray whitespace and reads blank as blank', () => {
    expect(splitLegacyFullName('  Nora   Brooks  ')).toEqual({
      firstName: 'Nora',
      lastName: 'Brooks',
    });
    expect(splitLegacyFullName('   ')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('mergeUserProfile', () => {
  it('derives first and last from a legacy combined name when both are blank', () => {
    const p = mergeUserProfile({ uid: 'op-1', fullName: 'Nora Brooks' } as never);
    expect(p.firstName).toBe('Nora');
    expect(p.lastName).toBe('Brooks');
  });

  it('accepts the other legacy key, `name`', () => {
    const p = mergeUserProfile({ uid: 'op-1', name: 'Nora Brooks' } as never);
    expect(p.firstName).toBe('Nora');
    expect(p.lastName).toBe('Brooks');
  });

  it('never overrides split fields the document actually holds', () => {
    const p = mergeUserProfile({
      uid: 'op-1',
      firstName: 'Nora',
      lastName: 'Brooks',
      fullName: 'Someone Else',
    } as never);
    expect(p.firstName).toBe('Nora');
    expect(p.lastName).toBe('Brooks');
  });

  it('fills only the blank half of a partially-split doc from nothing, not from the legacy name', () => {
    // firstName present means the doc was written by a client that knows the
    // split shape, so its blank lastName is a real blank, not a missing half.
    const p = mergeUserProfile({ uid: 'op-1', firstName: 'Nora', fullName: 'Nora Brooks' } as never);
    expect(p.firstName).toBe('Nora');
    expect(p.lastName).toBe('');
  });

  it('reads a wrong-typed legacy name as no name rather than throwing', () => {
    const p = mergeUserProfile({ uid: 'op-1', fullName: 42 } as never);
    expect(p.firstName).toBe('');
    expect(p.lastName).toBe('');
  });

  it('still defaults every other field on an empty doc', () => {
    const p = mergeUserProfile(undefined);
    expect(p).toEqual({
      uid: '',
      email: '',
      displayName: '',
      firstName: '',
      lastName: '',
      phone: '',
      title: '',
      photoUrl: '',
      bio: '',
    });
  });
});
