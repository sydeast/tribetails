import { describe, expect, it } from 'vitest';
import { KIN_AGE_MESSAGE, KIN_WEIGHT_MESSAGE, validateKinAge, validateKinWeight } from './kinMeasures';
describe('validateKinAge (#1583)', () => {
  it.each(['', '  ', '5', '0.5', '12', '1.25', '100'])('accepts %j', (v) => {
    expect(validateKinAge(v)).toBeNull();
  });

  it.each(['abc-5', '5 yrs', '-1', '1,5', '.5', '5.', '101', '1e3', '5-6', 'ten'])('refuses %j', (v) => {
    expect(validateKinAge(v)).toBe(KIN_AGE_MESSAGE);
  });

  it('lets a legacy value stand until it is edited', () => {
    expect(validateKinAge('abc-5', 'abc-5')).toBeNull();
    expect(validateKinAge('abc-6', 'abc-5')).toBe(KIN_AGE_MESSAGE);
    expect(validateKinAge('5', 'abc-5')).toBeNull();
  });
});

describe('validateKinWeight (#1583)', () => {
  it.each(['', '45', '45 lb', '45lbs', '12.5 kg', '8 OZ', '300g', '0.5 kg'])('accepts %j', (v) => {
    expect(validateKinWeight(v)).toBeNull();
  });

  it.each(['heavy-ish', 'abc', '45 stone', '-3', '0', '0 lb', '10000', 'lb', '4 5', '1.234 kg'])('refuses %j', (v) => {
    expect(validateKinWeight(v)).toBe(KIN_WEIGHT_MESSAGE);
  });

  it('lets a legacy value stand until it is edited', () => {
    expect(validateKinWeight('heavy-ish', 'heavy-ish')).toBeNull();
    expect(validateKinWeight('heavy', 'heavy-ish')).toBe(KIN_WEIGHT_MESSAGE);
    expect(validateKinWeight('40 lb', 'heavy-ish')).toBeNull();
  });
});
