import { describe, it, expect } from 'vitest';
import { mergeCustomFields } from '../src/lib/customFieldsMerge';

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
});
