import { describe, it, expect } from 'vitest';
import { mergeFieldBlocker, unsupportedMergeFields, KINFOLK_NAME_STAND_IN } from './broadcastMerge';

// Mirrors mytribe/functions/test/broadcastMerge.test.ts: the composer must
// refuse exactly what the server refuses.
describe('broadcast merge fields, client mirror (#1610)', () => {
  it('accepts every field the server fills', () => {
    expect(unsupportedMergeFields('Hi {{firstName}} {{ lastName }} {{kinfolkName}} {{business}} {{Business}}')).toEqual([]);
    expect(mergeFieldBlocker('Hi', 'Hi {{firstName}},')).toBeNull();
  });
  it('names a misspelling, an unknown field and a block helper', () => {
    expect(unsupportedMergeFields('Hi {{firstname}}', 'Your {{kinName}} {{#if paid}}x{{/if}}')).toEqual([
      'firstname',
      'kinName',
      '{{#if paid}}',
      '{{/if}}',
    ]);
  });
  it('names stray braces', () => {
    expect(unsupportedMergeFields('smile {{ :) }}')).toEqual(['{{ :) }}']);
    expect(unsupportedMergeFields('oops }} here')).toEqual(['}}']);
  });
  it('the blocker lists what to fix', () => {
    expect(mergeFieldBlocker('', 'Hi {{name}}')).toMatch(/Remove or fix: name\./);
  });
  it('the stand-in word is the operator ruling', () => {
    expect(KINFOLK_NAME_STAND_IN).toBe('Kinfolk');
  });
});
