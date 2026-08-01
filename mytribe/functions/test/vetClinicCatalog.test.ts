import { describe, it, expect, vi } from 'vitest';
import {
  normClinicName,
  readClinicFields,
  isClinicArchived,
  findLinkedHouseholds,
  VET_LINK_SLOTS,
} from '../src/lib/vetClinicCatalog';

describe('normClinicName', () => {
  it('folds case', () => {
    expect(normClinicName('RIVERSIDE')).toBe(normClinicName('riverside'));
  });

  it('collapses runs of whitespace', () => {
    expect(normClinicName('The  Mill   Vet')).toBe('the mill vet');
  });

  it('trims the ends', () => {
    expect(normClinicName('  Riverside  ')).toBe('riverside');
  });

  /**
   * Pins this equal to `submitVetClinic.ts#normName`. If create and rename ever
   * normalize differently, the bank accumulates the near-duplicates the dedupe
   * exists to prevent: create would collapse two spellings, rename would not.
   */
  it('matches the create-path dedupe rule exactly', () => {
    const submitNormName = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const sample of ['  The  MILL vet ', 'Riverside', 'a', '', '  ', 'Dr X\tClinic']) {
      expect(normClinicName(sample)).toBe(submitNormName(sample));
    }
  });
});

/**
 * The household link lives on `household_data`, NOT on `kinfolk`. Operator
 * ruling 2026-08-01: "vet info lives on household data, it can be seen on the
 * kin profile", matching page-specs 04-kinfolk-profile.md item 3.
 */
describe('VET_LINK_SLOTS', () => {
  it('names the two household_data link fields', () => {
    expect(VET_LINK_SLOTS).toEqual(['primaryVetClinicId', 'emergencyVetClinicId']);
  });

  it('keeps the emergency vet a DISTINCT slot from the primary', () => {
    expect(new Set(VET_LINK_SLOTS).size).toBe(VET_LINK_SLOTS.length);
  });

  it('references no kinfolk vet field, since kinfolk no longer owns the vet', () => {
    // Widened to string so the assertion survives the union narrowing: the
    // point is that the OLD kinfolk field name is absent, not a type identity.
    const slots: readonly string[] = VET_LINK_SLOTS;
    expect(slots).not.toContain('vetClinicId');
    expect(slots).not.toContain('emergencyVetClinicId_kinfolk');
  });
});

describe('findLinkedHouseholds', () => {
  /** A Firestore double answering each `where(slot, '==', id)` from a map. */
  function db(bySlot: Record<string, string[]>) {
    const where = vi.fn((field: string) => ({
      get: async () => ({ docs: (bySlot[field] ?? []).map((id) => ({ id })) }),
    }));
    const collection = vi.fn(() => ({ where }));
    return { db: { collection } as never, where, collection };
  }

  it('finds households linked through the regular slot', async () => {
    const d = db({ primaryVetClinicId: ['h1'] });
    expect(await findLinkedHouseholds(d.db, 'c1')).toEqual(['h1']);
  });

  it('finds households linked through the emergency slot', async () => {
    const d = db({ emergencyVetClinicId: ['h2'] });
    expect(await findLinkedHouseholds(d.db, 'c1')).toEqual(['h2']);
  });

  it('counts a household using BOTH slots exactly once', async () => {
    const d = db({ primaryVetClinicId: ['h1'], emergencyVetClinicId: ['h1'] });
    expect(await findLinkedHouseholds(d.db, 'c1')).toEqual(['h1']);
  });

  it('merges distinct households from both slots', async () => {
    const d = db({ primaryVetClinicId: ['h1'], emergencyVetClinicId: ['h2'] });
    expect(new Set(await findLinkedHouseholds(d.db, 'c1'))).toEqual(new Set(['h1', 'h2']));
  });

  /**
   * The guard that matters most. An UNLINKED household carries an empty id, so
   * without this a single clinic edit would appear to touch every unlinked
   * household in the tribe.
   */
  it('returns nothing for a blank clinic id, and queries nothing', async () => {
    const d = db({ primaryVetClinicId: ['h1'] });
    expect(await findLinkedHouseholds(d.db, '   ')).toEqual([]);
    expect(d.where).not.toHaveBeenCalled();
  });

  it('reads household_data, never kinfolk', async () => {
    const d = db({});
    await findLinkedHouseholds(d.db, 'c1');
    expect(d.collection.mock.calls.length).toBeGreaterThan(0);
    for (const call of d.collection.mock.calls) {
      expect((call as unknown as string[])[0]).toBe('household_data');
    }
  });
});

describe('readClinicFields', () => {
  it('defaults every absent field on a legacy row', () => {
    expect(readClinicFields({ name: 'Old Clinic' })).toEqual({
      name: 'Old Clinic',
      phone: '',
      address: '',
      website: '',
      hours: '',
      isEmergency: false,
      notes: '',
    });
  });

  it('ignores a non-string stored value rather than propagating it', () => {
    expect(readClinicFields({ name: 42 }).name).toBe('');
  });

  it('treats only an explicit true as emergency', () => {
    expect(readClinicFields({ isEmergency: 'true' }).isEmergency).toBe(false);
  });
});

describe('isClinicArchived', () => {
  it('is false when the field is absent, so legacy rows stay available', () => {
    expect(isClinicArchived({ name: 'Legacy' })).toBe(false);
  });

  it('is false for an explicit false', () => {
    expect(isClinicArchived({ archived: false })).toBe(false);
  });

  it('is true only for an explicit true', () => {
    expect(isClinicArchived({ archived: true })).toBe(true);
    expect(isClinicArchived({ archived: 'yes' })).toBe(false);
  });
});
