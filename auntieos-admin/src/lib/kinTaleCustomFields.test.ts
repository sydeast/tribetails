import { describe, it, expect } from 'vitest';
import { customFieldRows, decodeFormValues } from './kinTaleCustomFields';
import type { FormField, FormSchemaDetail } from '../api/formSchemasWrite';

function field(over: Partial<FormField> = {}): FormField {
  return {
    key: 'gate',
    label: 'Gate left latched?',
    type: 'text',
    required: false,
    helperText: null,
    placeholder: null,
    options: null,
    defaultValue: null,
    group: null,
    ...over,
  };
}

function schema(fields: FormField[], over: Partial<FormSchemaDetail> = {}): FormSchemaDetail {
  return {
    id: 'kintale-extras',
    name: 'KinTale extras',
    description: null,
    appliesTo: 'KINTALE',
    version: 1,
    sections: [{ title: 'Departure', description: null, fields }],
    ...over,
  };
}

describe('decodeFormValues', () => {
  it('keeps a well-formed flat key -> answer map', () => {
    expect(decodeFormValues({ gate: 'Yes', water: 'Topped up' })).toEqual({
      gate: 'Yes',
      water: 'Topped up',
    });
  });

  it('returns an empty map for the shapes Firestore can actually hand back instead', () => {
    expect(decodeFormValues(undefined)).toEqual({});
    expect(decodeFormValues(null)).toEqual({});
    expect(decodeFormValues('Yes')).toEqual({});
    expect(decodeFormValues(['Yes'])).toEqual({});
  });

  it('drops non-string and blank answers rather than coercing them', () => {
    expect(decodeFormValues({ a: 'Yes', b: 4, c: null, d: '', e: '  ', f: { v: 'Yes' } })).toEqual({
      a: 'Yes',
    });
  });
});

describe('customFieldRows', () => {
  it('resolves a stored answer to its authored label', () => {
    const rows = customFieldRows({ gate: 'Yes' }, [schema([field()])]);
    expect(rows).toEqual([
      { key: 'gate', section: 'Departure', label: 'Gate left latched?', value: 'Yes' },
    ]);
  });

  it('orders rows by the authored form, not by whatever order the answers arrived in', () => {
    const rows = customFieldRows({ water: 'Topped up', gate: 'Yes' }, [
      schema([field(), field({ key: 'water', label: 'Water topped up?' })]),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['gate', 'water']);
  });

  it('DROPS an answer whose key no longer matches any field, rather than printing the raw key', () => {
    const rows = customFieldRows({ gate: 'Yes', retiredField: 'Something' }, [schema([field()])]);
    expect(rows.map((r) => r.key)).toEqual(['gate']);
  });

  it('drops a field whose label was left blank, rather than rendering a labelless row', () => {
    const rows = customFieldRows({ gate: 'Yes' }, [schema([field({ label: '   ' })])]);
    expect(rows).toEqual([]);
  });

  it('returns nothing when no schema is available at all', () => {
    expect(customFieldRows({ gate: 'Yes' }, [])).toEqual([]);
  });

  it('returns nothing when the report stored no answers', () => {
    expect(customFieldRows(undefined, [schema([field()])])).toEqual([]);
    expect(customFieldRows({}, [schema([field()])])).toEqual([]);
  });

  it('skips a field with no stored answer: the panel reports answers, not a blank form', () => {
    const rows = customFieldRows({ gate: 'Yes' }, [
      schema([field(), field({ key: 'water', label: 'Water topped up?' })]),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['gate']);
  });

  it('prints one row when two schemas declare the same key, first authored wins', () => {
    const rows = customFieldRows({ gate: 'Yes' }, [
      schema([field()]),
      schema([field({ label: 'A different question' })], { id: 'other' }),
    ]);
    expect(rows).toEqual([
      { key: 'gate', section: 'Departure', label: 'Gate left latched?', value: 'Yes' },
    ]);
  });
});
