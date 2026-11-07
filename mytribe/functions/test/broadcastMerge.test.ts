import { describe, it, expect } from 'vitest';
import {
  BROADCAST_MERGE_FIELDS,
  KINFOLK_NAME_STAND_IN,
  broadcastMergeData,
  renderBroadcastCopy,
  unsupportedMergeFields,
} from '../src/lib/broadcastMerge';

describe('broadcast merge fields (#1610)', () => {
  it('a blank first name reads "Kinfolk" (operator ruling, 2026-11-05)', () => {
    const data = broadcastMergeData({ firstName: '  ', lastName: '' }, '');
    expect(KINFOLK_NAME_STAND_IN).toBe('Kinfolk');
    expect(renderBroadcastCopy('For {{firstName}}', 'Hi {{firstName}},', data)).toEqual({
      subject: 'For Kinfolk',
      body: 'Hi Kinfolk,',
    });
  });

  it('fills a real name, the full name and the business name', () => {
    const data = broadcastMergeData({ firstName: 'Dana', lastName: 'Wren' }, 'Tribe Tails');
    expect(renderBroadcastCopy('', 'Hi {{ firstName }} {{lastName}} ({{kinfolkName}}), from {{business}}', data).body).toBe(
      'Hi Dana Wren (Dana Wren), from Tribe Tails',
    );
  });

  it('a household with no name at all reads Kinfolk in kinfolkName too', () => {
    expect(broadcastMergeData({}, '').kinfolkName).toBe('Kinfolk');
  });

  it('does not HTML-escape a name (texts and push are plain text)', () => {
    const data = broadcastMergeData({ firstName: "O'Neil & Co" }, '');
    expect(renderBroadcastCopy('', 'Hi {{firstName}}', data).body).toBe("Hi O'Neil & Co");
  });

  it('accepts every supported field and copy with no fields', () => {
    expect(unsupportedMergeFields('Hi {{firstName}} {{lastName}} {{kinfolkName}} {{business}} {{Business}}', 'plain')).toEqual([]);
    expect(BROADCAST_MERGE_FIELDS).toContain('firstName');
  });

  it('names an unknown field, a misspelling, and a block helper', () => {
    expect(unsupportedMergeFields('Hi {{firstname}}', 'Your {{kinName}} {{#if paid}}x{{/if}}')).toEqual([
      'firstname',
      'kinName',
      '{{#if paid}}',
      '{{/if}}',
    ]);
  });

  it('names a stray brace run that is not a field at all', () => {
    expect(unsupportedMergeFields('smile {{ :) }}')).toEqual(['{{ :) }}']);
    expect(unsupportedMergeFields('oops }} here')).toEqual(['}}']);
  });

  it('reports each problem once', () => {
    expect(unsupportedMergeFields('{{x}} {{x}}', '{{x}}')).toEqual(['x']);
  });
});
