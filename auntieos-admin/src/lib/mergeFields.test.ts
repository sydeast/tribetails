import { describe, it, expect } from 'vitest';
import { findMergeFields, renderPreview, unresolvedKeys, ENRICHABLE_SAMPLE } from './mergeFields';

/**
 * The parser behind the live preview. Deliberately NOT a Handlebars runtime:
 * see the module's own comment for why a template evaluator has no business in
 * the admin bundle.
 */
describe('findMergeFields', () => {
  it('finds Handlebars tokens and reports their spans', () => {
    expect(findMergeFields('Hi {{kinfolkName}}, see {{ link }}.')).toEqual([
      { token: '{{kinfolkName}}', key: 'kinfolkName', start: 3, end: 18 },
      { token: '{{ link }}', key: 'link', start: 24, end: 34 },
    ]);
  });

  it('returns an empty list for a body with no tokens', () => {
    expect(findMergeFields('No fields here.')).toEqual([]);
  });

  it('ignores a block helper, which the senders scrub rather than resolve', () => {
    // `{{#if x}}` / `{{/if}}` / `{{> partial}}` are not simple merge fields.
    // stripUnresolvedTokens (mytribe/functions/src/notifications/templateParsers.ts)
    // wipes anything Handlebars leaves behind, so naming them as merge fields
    // would send the author chasing a value that was never a value.
    expect(findMergeFields('{{#if paid}}Thanks{{/if}} {{> footer}}')).toEqual([]);
  });

  it('reads a dotted path as one key', () => {
    expect(findMergeFields('{{invoice.number}}')).toEqual([
      { token: '{{invoice.number}}', key: 'invoice.number', start: 0, end: 18 },
    ]);
  });
});

describe('renderPreview', () => {
  it('marks a token with no sample binding as unresolved', () => {
    const segs = renderPreview('Hi {{kinfolkName}}!', {});
    expect(segs).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'field', key: 'kinfolkName', value: null },
      { kind: 'text', value: '!' },
    ]);
  });

  it('substitutes a bound token', () => {
    const segs = renderPreview('Hi {{kinfolkName}}!', { kinfolkName: 'Sandy' });
    expect(segs[1]).toEqual({ kind: 'field', key: 'kinfolkName', value: 'Sandy' });
  });

  it('keeps an empty-string binding distinct from an absent one', () => {
    // A bound-but-blank value is a different fact from "nothing binds this":
    // the first sends an empty string on purpose, the second is the defect the
    // warning counts. Collapsing them would make the warning lie in one
    // direction or the other.
    expect(renderPreview('{{a}}', { a: '' })[0]).toEqual({ kind: 'field', key: 'a', value: '' });
    expect(renderPreview('{{a}}', {})[0]).toEqual({ kind: 'field', key: 'a', value: null });
  });

  it('returns the whole body as one text segment when nothing merges', () => {
    expect(renderPreview('Plain copy.', {})).toEqual([{ kind: 'text', value: 'Plain copy.' }]);
  });

  it('returns nothing at all for an empty body', () => {
    expect(renderPreview('', {})).toEqual([]);
  });
});

describe('unresolvedKeys', () => {
  it('names a repeated unbound key once, so the count matches the names', () => {
    expect(unresolvedKeys(renderPreview('{{a}} {{b}} {{a}}', { b: 'bound' }))).toEqual(['a']);
  });

  it('names each unbound key once, in first-seen order', () => {
    const segs = renderPreview('{{link}} {{code}} {{link}}', {});
    expect(unresolvedKeys(segs)).toEqual(['link', 'code']);
  });

  it('names nothing when every token binds', () => {
    expect(unresolvedKeys(renderPreview('{{a}}', { a: 'x' }))).toEqual([]);
  });
});

describe('ENRICHABLE_SAMPLE', () => {
  it('covers exactly the twelve tokens the notification enricher hydrates', () => {
    // Mirrors ENRICHABLE in mytribe/functions/src/notifications/enrichTemplateData.ts.
    // If that set grows, this list has to grow with it or the preview will warn
    // about a token the pipeline does in fact fill.
    expect(Object.keys(ENRICHABLE_SAMPLE).sort()).toEqual([
      'amount',
      'bookingDate',
      'bookingTime',
      'displayName',
      'dueDate',
      'email',
      'invoiceNumber',
      'kinName',
      'kinfolkEmail',
      'kinfolkName',
      'notes',
      'serviceType',
    ]);
  });

  it('binds every one of them to a non-blank sample', () => {
    for (const [key, value] of Object.entries(ENRICHABLE_SAMPLE)) {
      expect(value.trim(), `${key} has no sample value`).not.toBe('');
    }
  });

  it('leaves an emitter-supplied token such as link unbound', () => {
    // `link`, `score`, `incidentId` and friends come from the emitter, not the
    // enricher. The preview must warn about them: that is the whole point.
    expect(ENRICHABLE_SAMPLE['link']).toBeUndefined();
  });
});
