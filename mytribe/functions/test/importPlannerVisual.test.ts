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
describe('import planner, what each differing row says will happen (#1060)', () => {
  const existing = { 'emailTemplates/k': { subject: 'Mine', body: 'b', html: '<p>h</p>' } };
  const emailNotes = (overwriteIds?: string[]) =>
    planImport({ corpus: [entry], existing, overwriteIds }).templates[0]!.channels.find((c) => c.channel === 'email')!.notes.join(' ');
  it('an unticked row says the stored copy stays and how to replace it', () => {
    expect(emailNotes()).toBe(
      'The stored email copy differs from the repo copy. Your stored copy stays as it is. Tick this template to replace it with the repo wording.',
    );
  });
  it('a ticked row says importing replaces the stored copy', () => {
    expect(emailNotes(['k'])).toBe(
      'The stored email copy differs from the repo copy. Importing replaces your stored copy with the repo wording.',
    );
  });
});
/**
 * #1936: a differing row carries both wordings, readable, so the operator can
 * decide before ticking the overwrite. Before this the row said the copies
 * differed and showed neither.
 */
describe('import planner, what a differing row shows (#1936)', () => {
  const channelOf = (existing: Record<string, Record<string, unknown>>, channel: 'email' | 'sms' | 'push', overwriteIds?: string[]) =>
    planImport({ corpus: [entry], existing, overwriteIds }).templates[0]!.channels.find((c) => c.channel === channel)!;
  it('a skipped sms row carries the stored text and the repo text', () => {
    const c = channelOf({ 'smsTemplates/k': { text: 'Hi from the office, your visit moved.' } }, 'sms');
    expect(c.outcome).toBe('skipped');
    expect(c.differences).toEqual([
      { field: 'text', label: 'Text message', stored: 'Hi from the office, your visit moved.', repo: 'sms' },
    ]);
  });
  it('a ticked row carries the same comparison, so the choice can be checked before Import', () => {
    const c = channelOf({ 'smsTemplates/k': { text: 'Old wording' } }, 'sms', ['k']);
    expect(c.outcome).toBe('overwrite');
    expect(c.differences?.[0]).toMatchObject({ stored: 'Old wording', repo: 'sms' });
  });
  it('an email lists only the parts that differ, the message as readable text', () => {
    const c = channelOf(
      { 'emailTemplates/k': { subject: 'S', headline: 'Mine', content: '<p>Line one<br>line two</p><p>Second &amp; last</p>', format: 'visual', body: null, html: null } },
      'email',
    );
    expect(c.differences).toEqual([
      { field: 'headline', label: 'Headline', stored: 'Mine', repo: 'H' },
      { field: 'content', label: 'Message', stored: 'Line one\nline two\n\nSecond & last', repo: 'x' },
    ]);
  });
  it('an old-format email is read from its html, and a wording match says what else differs', () => {
    const c = channelOf({ 'emailTemplates/k': { subject: 'S', headline: 'H', html: '<p>x</p>', body: 'x' } }, 'email');
    expect(c.outcome).toBe('skipped');
    expect(c.differences).toEqual([
      {
        field: 'content',
        label: 'Message',
        stored: 'x',
        repo: 'x',
        note: 'The wording is the same. Your stored copy uses the older email format, and importing moves it to the current one.',
      },
    ]);
  });
  it('a push row compares title and message', () => {
    const c = channelOf({ 'pushTemplates/k': { title: 'Title', body: 'mine' } }, 'push');
    expect(c.differences).toEqual([{ field: 'body', label: 'Message', stored: 'mine', repo: 'body' }]);
  });
  it('a row with nothing to compare carries no differences', () => {
    const created = channelOf({}, 'sms');
    expect(created.outcome).toBe('create');
    expect(created.differences).toBeUndefined();
  });
});
