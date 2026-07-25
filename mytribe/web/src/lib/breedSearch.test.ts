import { describe, it, expect } from 'vitest';
import {
  breedCatalogForSpecies,
  breedDropdownOptions,
  breedSuggestions,
  isExactBreed,
  speciesWantsBreedBank,
  BREED_DROPDOWN_CAP,
} from './breedSearch';

const DOGS = [
  'Airedale Terrier',
  'Australian Shepherd',
  'Basset Hound',
  'Border Collie',
  'German Shepherd Dog',
  'Golden Retriever',
  'Labrador Retriever',
  'Shetland Sheepdog',
];
const CATS = ['Abyssinian', 'Bengal', 'Maine Coon', 'Siamese'];

describe('breedSuggestions', () => {
  it('returns nothing for a blank query (typing is a filter, browsing is not)', () => {
    expect(breedSuggestions('', DOGS)).toEqual([]);
    expect(breedSuggestions('   ', DOGS)).toEqual([]);
  });

  it('ranks prefix matches above substring matches', () => {
    // "Shetland Sheepdog" starts with "she"; the two Shepherds only contain it.
    expect(breedSuggestions('she', DOGS)).toEqual([
      'Shetland Sheepdog',
      'Australian Shepherd',
      'German Shepherd Dog',
    ]);
  });

  it('preserves catalog order inside each rank so the list does not reshuffle mid-type', () => {
    expect(breedSuggestions('retriever', DOGS)).toEqual(['Golden Retriever', 'Labrador Retriever']);
  });

  it('is case- and whitespace-insensitive on the query', () => {
    expect(breedSuggestions('  BORDER ', DOGS)).toEqual(['Border Collie']);
  });

  it('caps the list at the limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Terrier ${String(i)}`);
    expect(breedSuggestions('terrier', many, 8)).toHaveLength(8);
  });

  it('returns nothing when the query matches no breed', () => {
    expect(breedSuggestions('zzz', DOGS)).toEqual([]);
  });
});

describe('breedDropdownOptions', () => {
  it('shows the catalog HEAD when nothing is typed, so the seeded bank is visible on open', () => {
    // The regression this pins: the old search-only field showed nothing until
    // you typed, which the operator read as "breed isn't pulling the DB".
    expect(breedDropdownOptions('', DOGS)).toEqual(DOGS);
  });

  it('caps the browse list', () => {
    const many = Array.from({ length: 500 }, (_, i) => `Breed ${String(i)}`);
    expect(breedDropdownOptions('', many)).toHaveLength(BREED_DROPDOWN_CAP);
  });

  it('filters once something is typed', () => {
    expect(breedDropdownOptions('bor', DOGS)).toEqual(['Border Collie']);
  });

  it('returns nothing for an empty catalog, which is the free-text signal', () => {
    expect(breedDropdownOptions('', [])).toEqual([]);
    expect(breedDropdownOptions('lab', [])).toEqual([]);
  });
});

describe('breedCatalogForSpecies', () => {
  it('picks the dog bank for Dog and the cat bank for Cat', () => {
    expect(breedCatalogForSpecies('Dog', DOGS, CATS)).toEqual(DOGS);
    expect(breedCatalogForSpecies('Cat', DOGS, CATS)).toEqual(CATS);
  });

  it('matches case-insensitively, because the admin species field is free text', () => {
    expect(breedCatalogForSpecies('  dOG ', DOGS, CATS)).toEqual(DOGS);
  });

  it('returns nothing for a species with no seeded bank', () => {
    for (const s of ['Bird', 'Rabbit', 'Reptile', 'Small mammal', 'Other', '']) {
      expect(breedCatalogForSpecies(s, DOGS, CATS)).toEqual([]);
    }
  });
});

describe('speciesWantsBreedBank', () => {
  it('is true only where a bank is actually seeded', () => {
    expect(speciesWantsBreedBank('Dog')).toBe(true);
    expect(speciesWantsBreedBank('cat')).toBe(true);
    expect(speciesWantsBreedBank('Bird')).toBe(false);
    expect(speciesWantsBreedBank('')).toBe(false);
  });
});

describe('isExactBreed', () => {
  it('matches a committed breed regardless of case or padding', () => {
    expect(isExactBreed('border collie', DOGS)).toBe(true);
    expect(isExactBreed('  Border Collie ', DOGS)).toBe(true);
  });

  it('is false for a partial, a blank, or a breed the bank has never heard of', () => {
    expect(isExactBreed('Border', DOGS)).toBe(false);
    expect(isExactBreed('', DOGS)).toBe(false);
    expect(isExactBreed('Lab / pit mix', DOGS)).toBe(false);
  });
});
