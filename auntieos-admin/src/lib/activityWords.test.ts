import { describe, expect, it } from 'vitest';
import { ACTIVITY_WORDS, activityDescriptionWords } from './activityWords';

/**
 * #1747: the stored Activity Log rows that name `generated_drafts/<id>` read as
 * words. These are the exact shapes the three writers stored before the fix.
 */
describe('activityDescriptionWords', () => {
  it('reads a stored Communicate approval as words, whatever the household bracket says', () => {
    expect(activityDescriptionWords('Approved generated_drafts/aB3dE9 (kf-robyn)')).toBe('Approved an Auntie AI draft');
    expect(activityDescriptionWords('Approved generated_drafts/aB3dE9 (no kinfolk)')).toBe('Approved an Auntie AI draft');
    expect(activityDescriptionWords('Approved generated_drafts/aB3dE9 (no-kinfolk)')).toBe('Approved an Auntie AI draft');
  });

  it('reads the stored KinTale draft send and delete as words', () => {
    expect(activityDescriptionWords('Sent draft generated_drafts/d1 as KinTale rep_77 (kf-robyn)')).toBe(
      'Sent a KinTale draft',
    );
    expect(activityDescriptionWords('Deleted draft generated_drafts/d1 (no household)')).toBe('Deleted a KinTale draft');
    expect(activityDescriptionWords('Deleted unsent KinTale draft kin_care_reports/r1 (kf-robyn)')).toBe(
      'Deleted a KinTale draft',
    );
  });

  it('never leaves a draft path in any other text', () => {
    expect(activityDescriptionWords('Restored generated_drafts/d1 by hand')).toBe('Restored a draft by hand');
  });

  it('passes text with no path through untouched', () => {
    expect(activityDescriptionWords('  signed in ')).toBe('signed in');
    expect(activityDescriptionWords('')).toBe('');
  });

  it('the words the writers now store read as themselves', () => {
    for (const words of Object.values(ACTIVITY_WORDS)) {
      expect(activityDescriptionWords(words)).toBe(words);
    }
  });
});
