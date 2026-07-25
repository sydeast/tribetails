import { describe, it, expect } from 'vitest';
import { vetClinicSuggestions, VET_CLINIC_SUGGESTION_CAP } from './vetClinicSearch';
import type { VetClinic } from '../api/vetClinics';

function clinic(over: Partial<VetClinic> & { _id: string; name: string }): VetClinic {
  return {
    phone: '',
    address: '',
    website: '',
    googleMapsUrl: '',
    isEmergency: false,
    ...over,
  } as VetClinic;
}

describe('vetClinicSuggestions', () => {
  it('returns nothing for a blank query: this is a search box, not a catalog dump', () => {
    const all = [clinic({ _id: '1', name: 'Riverside Animal Hospital' })];
    expect(vetClinicSuggestions('', all)).toEqual([]);
    expect(vetClinicSuggestions('   ', all)).toEqual([]);
  });

  it('ranks PREFIX matches ahead of substring matches', () => {
    const all = [
      clinic({ _id: 'sub', name: 'The Mill Vet' }),
      clinic({ _id: 'pre', name: 'Mill Creek Animal Care' }),
    ];
    expect(vetClinicSuggestions('mill', all).map((c) => c._id)).toEqual(['pre', 'sub']);
  });

  it('keeps catalog order WITHIN each rank, so the list does not reshuffle per keystroke', () => {
    const all = [
      clinic({ _id: 'p1', name: 'Millbrook A' }),
      clinic({ _id: 's1', name: 'A Mill B' }),
      clinic({ _id: 'p2', name: 'Millbrook C' }),
      clinic({ _id: 's2', name: 'D Mill E' }),
    ];
    expect(vetClinicSuggestions('mill', all).map((c) => c._id)).toEqual(['p1', 'p2', 's1', 's2']);
  });

  it('matches case-insensitively and ignores surrounding whitespace on the query', () => {
    const all = [clinic({ _id: '1', name: 'Riverside Animal Hospital' })];
    expect(vetClinicSuggestions('  RIVERSIDE ', all).map((c) => c._id)).toEqual(['1']);
  });

  it('caps at 8 rows so a 100-clinic catalog stays scannable', () => {
    const all = Array.from({ length: 40 }, (_, i) => clinic({ _id: `c${i}`, name: `Vet ${i}` }));
    expect(VET_CLINIC_SUGGESTION_CAP).toBe(8);
    expect(vetClinicSuggestions('vet', all)).toHaveLength(8);
  });

  it('fills the cap with prefix matches BEFORE any substring match gets a slot', () => {
    const prefixes = Array.from({ length: 10 }, (_, i) => clinic({ _id: `p${i}`, name: `Mill ${i}` }));
    const substrings = [clinic({ _id: 'sub', name: 'A Mill Place' })];
    // The substring row is FIRST in catalog order, and still must not appear.
    const out = vetClinicSuggestions('mill', [...substrings, ...prefixes]);
    expect(out.map((c) => c._id)).not.toContain('sub');
    expect(out).toHaveLength(8);
  });

  it('returns an empty list when nothing matches (the create button is the caller\'s job)', () => {
    const all = [clinic({ _id: '1', name: 'Riverside Animal Hospital' })];
    expect(vetClinicSuggestions('zzz', all)).toEqual([]);
  });

  it('skips nameless rows rather than rendering a blank option', () => {
    const all = [clinic({ _id: 'blank', name: '' }), clinic({ _id: 'ok', name: 'Mill Vet' })];
    expect(vetClinicSuggestions('mill', all).map((c) => c._id)).toEqual(['ok']);
  });
});

describe('vetClinicSuggestions: emergency filtering is the caller\'s, not this helper\'s', () => {
  it('does not filter by isEmergency itself', () => {
    const all = [
      clinic({ _id: 'day', name: 'Mill Day Clinic' }),
      clinic({ _id: 'er', name: 'Mill ER', isEmergency: true }),
    ];
    expect(vetClinicSuggestions('mill', all).map((c) => c._id)).toEqual(['day', 'er']);
  });
});
