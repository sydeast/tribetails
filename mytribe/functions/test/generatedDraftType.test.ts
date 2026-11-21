import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DRAFT_CREATOR_FIELD,
  draftMadeBy,
  draftTypeIsExactly,
  isKinTaleDraft,
  isPushDraft,
} from '../src/lib/generatedDraftType';

/** The type of a generated draft, read exactly as stored, in both spellings. */
describe('generatedDraftType', () => {
  it('HAPPY: a type matches in either spelling, or in both when they agree', () => {
    expect(isPushDraft({ communication_type: 'push' })).toBe(true);
    expect(isPushDraft({ communicationType: 'push' })).toBe(true);
    expect(isPushDraft({ communication_type: 'push', communicationType: 'push' })).toBe(true);
    expect(draftTypeIsExactly({ communication_type: 'email' }, 'email')).toBe(true);
  });

  it('NEGATIVE: a type that is not exactly push is not push, whatever the other spelling says', () => {
    const notExactlyPush: unknown[] = [
      'Push', ' push', 'push ', 'push\n', '\u00a0push', 'push\u2028', 'push\u2029', '\u3000push', '\ufeffpush', '', 7, null, ['push'],
    ];
    for (const type of notExactlyPush) {
      expect(isPushDraft({ communication_type: type })).toBe(false);
      expect(isPushDraft({ communicationType: type })).toBe(false);
      expect(isPushDraft({ communication_type: type, communicationType: 'push' })).toBe(false);
      expect(isPushDraft({ communication_type: 'push', communicationType: type })).toBe(false);
    }
  });

  it('NEGATIVE: a draft with no type is no type at all', () => {
    expect(isPushDraft({})).toBe(false);
    expect(isKinTaleDraft({})).toBe(false);
    expect(draftTypeIsExactly({ status: 'approved' }, 'push')).toBe(false);
  });

  it('HAPPY: a KinTale draft says visit_report in the generator spelling', () => {
    expect(isKinTaleDraft({ communication_type: 'visit_report' })).toBe(true);
    expect(isKinTaleDraft({ communication_type: 'visit_report', communicationType: 'visit_report' })).toBe(true);
  });

  it('NEGATIVE: a KinTale draft needs the generator spelling, exactly, and no other type beside it', () => {
    expect(isKinTaleDraft({ communicationType: 'visit_report' })).toBe(false);
    expect(isKinTaleDraft({ communication_type: 'visit_report', communicationType: 'push' })).toBe(false);
    expect(isKinTaleDraft({ communication_type: 'visit_report', communicationType: '' })).toBe(false);
    expect(isKinTaleDraft({ communication_type: 'visit_report', communicationType: null })).toBe(false);
    expect(isKinTaleDraft({ communication_type: 'Visit_Report' })).toBe(false);
    expect(isKinTaleDraft({ communication_type: 'visit_report ' })).toBe(false);
    expect(isKinTaleDraft({ communication_type: 'visit_report\u00a0' })).toBe(false);
    expect(isKinTaleDraft({ communication_type: 'push' })).toBe(false);
  });
});

/**
 * An Auntie's drafts list filters on the type and on her uid as the maker
 * (#2443), and sorts by `createdOn` (`auntieos-admin/src/lib/caretakerScope.ts`).
 * Firestore serves that only from a composite index, and the emulator the rules
 * tests run on does not check for one, so this does.
 */
describe('the index behind an Auntie\'s drafts list', () => {
  it('is declared in firestore.indexes.json', () => {
    const indexes = JSON.parse(readFileSync(resolve(__dirname, '../../firestore.indexes.json'), 'utf8')) as {
      indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string }[] }[];
    };
    expect(indexes.indexes).toContainEqual({
      collectionGroup: 'generated_drafts',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'communication_type', order: 'ASCENDING' },
        { fieldPath: 'createdBy', order: 'ASCENDING' },
        { fieldPath: 'createdOn', order: 'DESCENDING' },
      ],
    });
  });
});

/** #2443 ruling: who made a draft, compared exactly as stored. */
describe('draftMadeBy', () => {
  it('HAPPY: a draft stamped with the uid was made by it', () => {
    expect(DRAFT_CREATOR_FIELD).toBe('createdBy');
    expect(draftMadeBy({ createdBy: 'auntie-1' }, 'auntie-1')).toBe(true);
  });

  it('NEGATIVE: another maker, no stamp, or a stamp that only looks like the uid', () => {
    expect(draftMadeBy({ createdBy: 'auntie-2' }, 'auntie-1')).toBe(false);
    expect(draftMadeBy({}, 'auntie-1')).toBe(false);
    for (const stamp of ['', ' auntie-1', 'auntie-1 ', 'AUNTIE-1', 7, null, ['auntie-1'], { uid: 'auntie-1' }]) {
      expect(draftMadeBy({ createdBy: stamp }, 'auntie-1')).toBe(false);
    }
  });

  it('NEGATIVE: a blank caller made nothing, even a draft with a blank stamp', () => {
    expect(draftMadeBy({ createdBy: '' }, '')).toBe(false);
    expect(draftMadeBy({}, '')).toBe(false);
  });
});
