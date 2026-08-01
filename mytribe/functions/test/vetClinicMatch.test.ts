import { describe, it, expect } from 'vitest';
import {
  clinicMatchCandidates,
  acknowledgesAll,
  phoneDigits,
  MAX_CANDIDATES,
  type CatalogRow,
} from '../src/lib/vetClinicMatch';

/**
 * Operator ruling 2026-08-01: a near match must OFFER a choice, never take it.
 * These pin the two properties that ruling requires: the default path can never
 * substitute a different clinic, and the confirmation cannot be forged by a
 * client that never showed the user anything.
 */

function row(id: string, data: Record<string, unknown>): CatalogRow {
  return { id, data };
}

const RIVERSIDE = row('c1', {
  name: 'Riverside Animal Hospital',
  phone: '(512) 555-0100',
  address: '418 Mill St',
});
const MILL = row('c2', { name: 'The Mill Vet', phone: '(512) 555-0200' });

describe('phoneDigits', () => {
  it('strips formatting so the same number compares equal', () => {
    expect(phoneDigits('(512) 555-0100')).toBe(phoneDigits('512.555.0100'));
  });

  it('is empty for a blank phone', () => {
    expect(phoneDigits('')).toBe('');
  });
});

describe('clinicMatchCandidates: the name rule (the old behaviour, kept)', () => {
  it('matches an identical normalized name', () => {
    const hits = clinicMatchCandidates('riverside   ANIMAL hospital', '', [RIVERSIDE, MILL]);
    expect(hits.map((c) => c.id)).toEqual(['c1']);
    expect(hits[0]!.reason).toBe('name');
  });

  it('returns nothing when nothing resembles the name', () => {
    expect(clinicMatchCandidates('Zzz Veterinary', '', [RIVERSIDE, MILL])).toEqual([]);
  });

  it('returns nothing for a blank name rather than matching everything', () => {
    expect(clinicMatchCandidates('   ', '', [RIVERSIDE, MILL])).toEqual([]);
  });

  it('carries enough of the clinic to be recognizable in a choice list', () => {
    const [hit] = clinicMatchCandidates('Riverside Animal Hospital', '', [RIVERSIDE]);
    expect(hit).toMatchObject({
      id: 'c1',
      name: 'Riverside Animal Hospital',
      address: '418 Mill St',
      phone: '(512) 555-0100',
    });
  });
});

describe('clinicMatchCandidates: the phone rule (the false negative the old rule missed)', () => {
  it('matches the SAME practice spelled differently, by phone', () => {
    const hits = clinicMatchCandidates('Riverside Animal Hosp', '512-555-0100', [RIVERSIDE, MILL]);
    expect(hits.map((c) => c.id)).toEqual(['c1']);
    expect(hits[0]!.reason).toBe('phone');
  });

  it('ignores a phone too short to identify anything', () => {
    // A fragment or extension would otherwise collide clinics sharing a suffix.
    const hits = clinicMatchCandidates('Totally Other Vets', '0100', [RIVERSIDE]);
    expect(hits).toEqual([]);
  });

  it('ignores a blank phone rather than matching every clinic without one', () => {
    const noPhone = row('c9', { name: 'Somewhere Vets' });
    expect(clinicMatchCandidates('Different Name', '', [noPhone])).toEqual([]);
  });
});

describe('clinicMatchCandidates: the containment rule', () => {
  it('offers an abbreviation of an existing clinic', () => {
    const hits = clinicMatchCandidates('Riverside Animal', '', [RIVERSIDE]);
    expect(hits[0]!.reason).toBe('similar');
  });

  it('offers a longer form of an existing clinic', () => {
    const short = row('c3', { name: 'Riverside' });
    const hits = clinicMatchCandidates('Riverside Animal Hospital', '', [short]);
    expect(hits[0]!.reason).toBe('similar');
  });

  it('does not fire on a token too short to mean anything', () => {
    const vet = row('c4', { name: 'Vet' });
    expect(clinicMatchCandidates('Riverside Animal Hospital', '', [vet])).toEqual([]);
  });
});

describe('clinicMatchCandidates: what is offered', () => {
  it('ranks an exact name above a phone match above a mere resemblance', () => {
    const exact = row('a', { name: 'Oak Vets' });
    const byPhone = row('b', { name: 'Somewhere Else', phone: '5125550999' });
    const similar = row('c', { name: 'Oak Vets Downtown' });
    const hits = clinicMatchCandidates('Oak Vets', '512-555-0999', [similar, byPhone, exact]);
    expect(hits.map((c) => c.reason)).toEqual(['name', 'phone', 'similar']);
  });

  it('excludes an archived clinic, which could not be picked anyway', () => {
    const retired = row('r', { name: 'Riverside Animal Hospital', archived: true });
    expect(clinicMatchCandidates('Riverside Animal Hospital', '', [retired])).toEqual([]);
  });

  it('INCLUDES a pending submission, and flags it', () => {
    // Two households submitting the same new clinic in one week is exactly the
    // duplicate this exists to catch.
    const pending = row('p', { name: 'Riverside Animal Hospital', verified: false });
    const [hit] = clinicMatchCandidates('Riverside Animal Hospital', '', [pending]);
    expect(hit!.verified).toBe(false);
  });

  it('treats a missing verified flag as approved', () => {
    const [hit] = clinicMatchCandidates('Riverside Animal Hospital', '', [RIVERSIDE]);
    expect(hit!.verified).toBe(true);
  });

  it('caps the list so a choice does not become a wall', () => {
    const many = Array.from({ length: 12 }, (_, i) => row(`x${i}`, { name: 'Riverside Animal' }));
    expect(clinicMatchCandidates('Riverside Animal', '', many)).toHaveLength(MAX_CANDIDATES);
  });

  it('skips a catalog row with no name at all', () => {
    expect(clinicMatchCandidates('Riverside', '', [row('n', { phone: '5125550100' })])).toEqual([]);
  });
});

describe('acknowledgesAll: the anti-forgery property', () => {
  const candidates = clinicMatchCandidates('Riverside Animal Hospital', '', [RIVERSIDE]);

  it('is false when the caller acknowledged nothing', () => {
    expect(acknowledgesAll(candidates, [])).toBe(false);
  });

  it('is true when every offered id was echoed back', () => {
    expect(acknowledgesAll(candidates, ['c1'])).toBe(true);
  });

  it('is false when only SOME candidates were acknowledged', () => {
    // "Oakhill" is above the containment floor, so both rows are offered.
    const two = clinicMatchCandidates('Oakhill', '', [
      row('a', { name: 'Oakhill' }),
      row('b', { name: 'Oakhill Vets' }),
    ]);
    expect(two).toHaveLength(2);
    expect(acknowledgesAll(two, ['a'])).toBe(false);
  });

  it('is false when a NEW match appeared since the choice was shown', () => {
    // The caller acknowledged c1, but another household added a match in the
    // meantime. Asking again beats creating a duplicate of something unseen.
    const now = clinicMatchCandidates('Riverside Animal Hospital', '', [
      RIVERSIDE,
      row('c5', { name: 'Riverside Animal Hospital' }),
    ]);
    expect(acknowledgesAll(now, ['c1'])).toBe(false);
  });

  it('is vacuously true when there is nothing to acknowledge', () => {
    expect(acknowledgesAll([], [])).toBe(true);
  });

  it('tolerates acknowledging ids that are no longer candidates', () => {
    expect(acknowledgesAll(candidates, ['c1', 'gone'])).toBe(true);
  });
});
