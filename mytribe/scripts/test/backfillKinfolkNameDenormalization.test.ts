import { describe, it, expect } from 'vitest';
import { kinfolkDisplayName } from '../backfillKinfolkNameDenormalization';

describe('kinfolkDisplayName', () => {
  it('prefers explicit displayName when present', () => {
    expect(kinfolkDisplayName({ displayName: 'Sandy Demo', firstName: 'Sandy', lastName: 'Demo' })).toBe('Sandy Demo');
  });

  it('composes firstName + lastName when displayName missing', () => {
    expect(kinfolkDisplayName({ firstName: 'Nora', lastName: 'Halbrook' })).toBe('Nora Halbrook');
  });

  it('trims whitespace around composed name', () => {
    expect(kinfolkDisplayName({ firstName: '  Nora  ', lastName: '  Halbrook  ' })).toBe('Nora Halbrook');
  });

  it('returns single-token name when only one of first/last present', () => {
    expect(kinfolkDisplayName({ firstName: 'Madonna' })).toBe('Madonna');
    expect(kinfolkDisplayName({ lastName: 'Cher' })).toBe('Cher');
  });

  it('returns empty string when no name fields present', () => {
    expect(kinfolkDisplayName({})).toBe('');
  });

  it('returns empty string when displayName + firstName + lastName all whitespace', () => {
    expect(kinfolkDisplayName({ displayName: '   ', firstName: ' ', lastName: '  ' })).toBe('');
  });

  it('ignores non-string types defensively', () => {
    expect(kinfolkDisplayName({ firstName: 42 as never, lastName: 'Smith' })).toBe('Smith');
    expect(kinfolkDisplayName({ displayName: null as never })).toBe('');
  });
});
