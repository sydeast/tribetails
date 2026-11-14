import { describe, it, expect } from 'vitest';
import { FORM_SCHEMA_LIMITS, formSchemaRefusals, textProblem } from './formSchemaRules';

/**
 * #2074: the same accept and refuse strings the functions test
 * (`mytribe/functions/test/saveFormSchema.test.ts`, "saveFormSchema refusals")
 * pins on the server. If one side changes a rule, one of the two fails.
 */
describe('textProblem (#2074, parity with saveFormSchema)', () => {
  it('refuses the walk label, naming the three characters', () => {
    expect(textProblem('Label', 'QA-R1 field <b>x</b> \' " & %', 200)).toBe('Label cannot contain <, > or &.');
  });

  it('accepts quotes, percent and emoji', () => {
    expect(textProblem('Label', 'QA-R1 field \' " %', 200)).toBeNull();
    expect(textProblem('Name', 'QA-R1 schema \u{1F43E}', 200)).toBeNull();
  });

  it('refuses a tab in a one-line input, accepts line breaks and tabs in a description', () => {
    expect(textProblem('Label', 'Family\tname', 200)).toBe(
      'Label cannot contain a tab, a line break or another hidden character.',
    );
    expect(textProblem('Description', 'Line one\nLine two', 2000, { multiline: true })).toBeNull();
    expect(textProblem('Section description', 'First\r\nSecond', 2000, { multiline: true })).toBeNull();
    expect(textProblem('Description', 'bell\u0007', 2000, { multiline: true })).toMatch(/hidden character/);
  });

  it('names the length and the limit', () => {
    expect(textProblem('Label', 'x'.repeat(330), FORM_SCHEMA_LIMITS.label)).toBe(
      'Label is 330 characters long. The limit is 200.',
    );
    expect(textProblem('Label', 'x'.repeat(200), FORM_SCHEMA_LIMITS.label)).toBeNull();
  });

  it('checks Group for length only, as the server does', () => {
    expect(textProblem('Group', 'a & b', FORM_SCHEMA_LIMITS.group, { plain: false })).toBeNull();
    expect(textProblem('Group', 'g'.repeat(81), FORM_SCHEMA_LIMITS.group, { plain: false })).toMatch(/limit is 80/);
  });
});

describe('formSchemaRefusals (#2074)', () => {
  it('reads the server sentences and where each one belongs', () => {
    const err = {
      details: {
        reason: 'form-schema-refused',
        validationErrors: [
          { path: 'schema.sections.0.title', message: 'x', text: 'Section 1: Section title cannot contain <, > or &.', sectionIndex: 0, fieldIndex: null },
          { path: 'schema.name', message: 'x', text: 'Name cannot contain <, > or &.', sectionIndex: null, fieldIndex: null },
        ],
      },
    };
    expect(formSchemaRefusals(err)).toEqual([
      { text: 'Section 1: Section title cannot contain <, > or &.', sectionIndex: 0, fieldIndex: null },
      { text: 'Name cannot contain <, > or &.', sectionIndex: null, fieldIndex: null },
    ]);
  });

  it('is empty for any other failure, and for a server that predates the sentences', () => {
    expect(formSchemaRefusals(new Error('boom'))).toEqual([]);
    expect(formSchemaRefusals({ details: { reason: 'other', validationErrors: [{ text: 'x' }] } })).toEqual([]);
    expect(
      formSchemaRefusals({ details: { reason: 'form-schema-refused', validationErrors: [{ path: 'a', message: 'b' }] } }),
    ).toEqual([]);
    expect(formSchemaRefusals(null)).toEqual([]);
  });
});
