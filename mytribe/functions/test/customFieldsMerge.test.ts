import { describe, it, expect } from 'vitest';
import {
  CUSTOM_FIELDS_GROWTH_MAX_BYTES,
  CUSTOM_FIELDS_HARD_MAX_BYTES,
  CUSTOM_FIELDS_MAX_ROWS,
  SMALLEST_ROW_JSON_BYTES,
  customFieldsBytes,
  mergeCustomFields,
  mergeCustomFieldsForSave,
  newKeysMissingLabel,
} from '../src/lib/customFieldsMerge';

/**
 * #873. `customFields` used to be replaced whole, so a client that rebuilt the
 * list from its form schema deleted every stored row outside the schema. The
 * merge keeps what the client did not name.
 */
describe('mergeCustomFields (#873)', () => {
  const office = { key: 'gateNote', label: 'Set by Auntie', value: 'Side gate sticks' };
  const allergy = { key: 'allergy', label: 'Allergies', value: 'Chicken' };
  const color = { key: 'color', label: 'Favorite color', value: 'Blue' };

  it('keeps every stored row the client did not send, in its stored order', () => {
    expect(mergeCustomFields([office, allergy, color], [{ ...allergy, value: 'Beef' }], [])).toEqual([
      office,
      { ...allergy, value: 'Beef' },
      color,
    ]);
  });

  it('appends a new key after the stored rows, in sent order', () => {
    const a = { key: 'a', label: 'A', value: '1' };
    const b = { key: 'b', label: 'B', value: '2' };
    expect(mergeCustomFields([office], [b, a], [])).toEqual([office, b, a]);
  });

  it("a sent '' is a real clear: the row stays, its value is empty", () => {
    expect(mergeCustomFields([office, allergy], [{ ...allergy, value: '' }], [])).toEqual([office, { ...allergy, value: '' }]);
  });

  it("a sent '' for a key with no stored row writes no row (an old client's untouched, never-set schema field)", () => {
    expect(mergeCustomFields([office], [{ key: 'color', label: 'Favorite color', value: '' }], [])).toEqual([office]);
  });

  it('removes a row only when the client names it', () => {
    expect(mergeCustomFields([office, allergy, color], [], ['allergy'])).toEqual([office, color]);
  });

  it('a sent key replaces the first stored copy and folds later duplicates of that key into it', () => {
    const old1 = { key: 'vetClinicId', label: 'Vet Clinic', value: 'old' };
    const old2 = { key: 'vetClinicId', label: 'Vet Clinic', value: 'older' };
    expect(mergeCustomFields([old1, office, old2], [{ ...old1, value: 'new' }], [])).toEqual([
      { ...old1, value: 'new' },
      office,
    ]);
  });

  it('the last copy of a key sent twice wins', () => {
    expect(mergeCustomFields([], [{ ...allergy, value: 'x' }, { ...allergy, value: 'y' }], [])).toEqual([{ ...allergy, value: 'y' }]);
  });

  it('a stored entry it cannot read is carried through verbatim, never dropped', () => {
    const odd = { note: 'no key here' };
    expect(mergeCustomFields([odd, office] as unknown[], [allergy], [])).toEqual([odd, office, allergy]);
  });

  it('stored rows that are not an array read as none', () => {
    expect(mergeCustomFields(undefined, [allergy], [])).toEqual([allergy]);
  });

  it('a blank sent label on a stored key keeps the stored label; a missing stored label stays blank', () => {
    expect(mergeCustomFields([allergy, { key: 'x', value: '1' }], [{ ...allergy, label: '', value: 'Beef' }, { key: 'x', label: ' ', value: '2' }], [])).toEqual([
      { ...allergy, value: 'Beef' },
      { key: 'x', label: '', value: '2' },
    ]);
  });
});

/** #873 review: the refusals and the limits the callables share. */
describe('customFields save limits (#873 review)', () => {
  const allergy = { key: 'allergy', label: 'Allergies', value: 'Chicken' };

  it('newKeysMissingLabel names only a new, labelless key that would land', () => {
    const sent = [
      { key: 'allergy', label: '', value: 'Beef' },
      { key: 'pool', label: '', value: 'Heated' },
      { key: 'shed', label: '', value: '' },
      { key: 'gone', label: '', value: 'x' },
      { key: 'named', label: 'Named', value: 'x' },
    ];
    expect(newKeysMissingLabel([allergy], sent, ['gone'])).toEqual(['pool']);
  });

  it('the row cap is the growth ceiling over the smallest row, and the ceiling sits under the document backstop', () => {
    expect(customFieldsBytes([{ key: 'a', label: '', value: '' }])).toBe(SMALLEST_ROW_JSON_BYTES + 2);
    expect(CUSTOM_FIELDS_GROWTH_MAX_BYTES).toBe(64 * 1024);
    expect(CUSTOM_FIELDS_MAX_ROWS).toBe(Math.floor(CUSTOM_FIELDS_GROWTH_MAX_BYTES / SMALLEST_ROW_JSON_BYTES));
    expect(CUSTOM_FIELDS_MAX_ROWS).toBe(1985);
    expect(CUSTOM_FIELDS_GROWTH_MAX_BYTES).toBeLessThanOrEqual(CUSTOM_FIELDS_HARD_MAX_BYTES);
  });

  // 66 rows of 1000 characters is about 67 KiB: past the growth ceiling.
  const overCeiling = () => Array.from({ length: 66 }, (_, i) => ({ key: `k${i}`, label: 'L', value: 'x'.repeat(1000) }));

  it('refuses a save that grows an empty list past 64 KiB', () => {
    const rows = overCeiling();
    expect(customFieldsBytes(rows)).toBeGreaterThan(CUSTOM_FIELDS_GROWTH_MAX_BYTES);
    expect(() => mergeCustomFieldsForSave([], rows, [])).toThrow(/too large/);
    expect(mergeCustomFieldsForSave([], rows.slice(0, 60), [])).toHaveLength(60);
  });

  it('a household already over 64 KiB can echo, clear and remove, and cannot grow', () => {
    const big = overCeiling();
    expect(mergeCustomFieldsForSave(big, big, [])).toHaveLength(66);
    expect(mergeCustomFieldsForSave(big, [{ key: 'k0', label: 'L', value: '' }], ['k1'])).toHaveLength(65);
    expect(() => mergeCustomFieldsForSave(big, [{ key: 'pool', label: 'Pool', value: 'y' }], [])).toThrow(/too large/);
    expect(() => mergeCustomFieldsForSave(big, [{ key: 'k0', label: 'L', value: 'x'.repeat(1000) + 'y' }], [])).toThrow(/too large/);
  });

  it('counts UTF-8 bytes, not UTF-16 length: an emoji is 4 bytes', () => {
    const row = [{ key: 'a', label: '', value: '😀'.repeat(500) }];
    expect(customFieldsBytes(row)).toBeGreaterThan(2000);
    expect(JSON.stringify(row).length).toBeLessThan(1100);
  });

  it('refuses an emoji list that is over the ceiling in bytes though under it in UTF-16 length', () => {
    // 64 rows of 250 emoji: 500 UTF-16 units each (inside the 1000 value cap), 1000 bytes each.
    const rows = Array.from({ length: 64 }, (_, i) => ({ key: `e${i}`, label: 'E', value: '😀'.repeat(250) }));
    expect(JSON.stringify(rows).length).toBeLessThan(CUSTOM_FIELDS_GROWTH_MAX_BYTES);
    expect(customFieldsBytes(rows)).toBeGreaterThan(CUSTOM_FIELDS_GROWTH_MAX_BYTES);
    expect(() => mergeCustomFieldsForSave([], rows, [])).toThrow(/too large/);
  });

  it('mergeCustomFieldsForSave refuses a new labelless row with invalid-argument', () => {
    expect(() => mergeCustomFieldsForSave([allergy], [{ key: 'pool', label: '', value: 'Heated' }], [])).toThrow(
      expect.objectContaining({ code: 'invalid-argument' }),
    );
  });
});
