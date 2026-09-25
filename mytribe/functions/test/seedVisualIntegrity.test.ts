import { describe, it, expect } from 'vitest';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { sanitizeEmailContent, MERGE_TOKEN } from '../src/lib/emailContent';
import { TEMPLATE_FIELDS } from '../src/notifications/enrichTemplateData';

describe('every seed is a valid visual template', () => {
  it('there are 52', () => expect(SEED_CORPUS.length).toBe(52));
  for (const s of SEED_CORPUS) {
    it(`${s.key}: headline, clean content, known tokens`, () => {
      expect(s.emailSubject.trim()).not.toBe('');
      expect(s.emailHeadline.trim()).not.toBe('');
      const r = sanitizeEmailContent(s.emailContent, '');
      expect(r.issues).toEqual([]);
      expect(r.content).toBe(s.emailContent);
      const fields = TEMPLATE_FIELDS[s.key];
      if (fields) {
        for (const m of `${s.emailSubject}${s.emailHeadline}${s.emailContent}`.matchAll(MERGE_TOKEN)) {
          // `{{this.x}}` names a field of a `{{#each}}` block's current item
          // (see assignment.assigned / kincare.booking.confirm), not a context
          // field TEMPLATE_FIELDS describes -- same exclusion enrichTemplateData
          // .test.ts's drift guard makes for the same reason.
          if (m[1] === 'this' || m[1].startsWith('this.')) continue;
          expect(fields, `${s.key} uses {{${m[1]}}}`).toContain(m[1]);
        }
      }
    });
  }
});
