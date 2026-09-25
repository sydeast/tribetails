import { describe, it, expect } from 'vitest';
import { planImport, plannedWrites } from '../src/notifications/importPlanner';

const entry = { key: 'k', emailSubject: 'S', emailHeadline: 'H', emailContent: '<p>x</p>', smsTxt: 'sms', pushTxt: 'Title. body\n' };

describe('import planner, visual seeds', () => {
  it('creates a visual doc that clears body and html', () => {
    const plan = planImport({ corpus: [entry], existing: {} });
    const w = plannedWrites(plan).find((x) => x.path === 'emailTemplates/k')!;
    expect(w.content).toEqual({ subject: 'S', headline: 'H', content: '<p>x</p>', format: 'visual', body: null, html: null });
  });

  it('skips an edited old-format doc unless ticked, then overwrites it', () => {
    const existing = { 'emailTemplates/k': { subject: 'Mine', body: 'b', html: '<p>h</p>' } };
    const skipped = planImport({ corpus: [entry], existing });
    expect(skipped.templates[0]!.channels.find((c) => c.channel === 'email')!.outcome).toBe('skipped');
    const ticked = planImport({ corpus: [entry], existing, overwriteIds: ['k'] });
    expect(ticked.templates[0]!.channels.find((c) => c.channel === 'email')!.outcome).toBe('overwrite');
  });

  it('is unchanged when the stored doc already matches', () => {
    const existing = { 'emailTemplates/k': { subject: 'S', headline: 'H', content: '<p>x</p>', format: 'visual', body: null, html: null } };
    expect(planImport({ corpus: [entry], existing }).templates[0]!.channels.find((c) => c.channel === 'email')!.outcome).toBe('unchanged');
  });

  it('blocks a seed whose content fails the sanitizer', () => {
    const bad = { ...entry, emailContent: '<p>{{{raw}}}</p>' };
    expect(planImport({ corpus: [bad], existing: {} }).templates[0]!.blocked).toBe(true);
  });

  it('overwriting a stored old-format doc produces exactly the six visual fields, body and html null', () => {
    // A final review made this a hard prerequisite: an import can never leave a
    // document holding both an old-format body/html and the new visual fields.
    const existing = { 'emailTemplates/k': { subject: 'Mine', body: 'Their own wording.', html: '<p>Their own wording.</p>' } };
    const plan = planImport({ corpus: [entry], existing, overwriteIds: ['k'] });
    const w = plannedWrites(plan).find((x) => x.path === 'emailTemplates/k')!;
    expect(Object.keys(w.content).sort()).toEqual(['body', 'content', 'format', 'headline', 'html', 'subject']);
    expect(w.content).toEqual({ subject: 'S', headline: 'H', content: '<p>x</p>', format: 'visual', body: null, html: null });
  });
});
