import { describe, it, expect } from 'vitest';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { sendPartsFor } from '../src/lib/emailFrame';
import { renderEmailParts } from '../src/lib/email';

/**
 * #2280: the booking confirmation email carries the note the office wrote the
 * household with its yes (#2030), and says nothing about a note when there was
 * none. Rendered the way it is sent: the repo template through `sendPartsFor`
 * and `renderEmailParts`, real Handlebars, html and text parts both.
 */

const seed = SEED_CORPUS.find((s) => s.key === 'kincare.booking.confirm')!;
const doc = {
  subject: seed.emailSubject,
  format: 'visual' as const,
  headline: seed.emailHeadline,
  content: seed.emailContent,
};

/** What the approve core sends, with the note it was given (null when none, as it sends it). */
function confirmData(note: unknown): Record<string, unknown> {
  return {
    kinfolkName: 'Jordan',
    kinName: 'Biscuit',
    serviceType: 'Drop-In Visit',
    visits: [
      { weekday: 'Monday', date: 'Nov 16', time: 'Midday (11 AM to 3 PM)' },
      { weekday: 'Tuesday', date: 'Nov 17', time: 'Midday (11 AM to 3 PM)' },
    ],
    visitCount: 2,
    nextVisit: { weekday: 'Monday', date: 'Nov 16', time: 'Midday (11 AM to 3 PM)' },
    portalUrl: 'https://kinfolk.tribetails.com',
    ...(note === undefined ? {} : { note }),
  };
}

const render = (note: unknown) => renderEmailParts({ ...sendPartsFor(doc), data: confirmData(note) });

describe('#2280: the confirmation email and the office note', () => {
  it('carries the note in the html and the text part', () => {
    const out = render('The spare key is with the neighbour at number 12.');
    expect(out.html).toContain('<strong>A note from me:</strong> The spare key is with the neighbour at number 12.');
    expect(out.text).toContain('A note from me: The spare key is with the neighbour at number 12.');
    // The rest of the email is still there, after the note.
    expect(out.html).toContain("I'll be there ready to go.");
    expect(out.text).toContain("\n\nI'll be there ready to go.");
    expect(out.text).toContain('- Monday, Nov 16 at Midday (11 AM to 3 PM)');
  });

  it.each([
    ['null, as the approve core sends it', null],
    ['an empty string', ''],
    ['no note field at all, as the other three emitters send it', undefined],
  ])('has no note section with %s', (_label, note) => {
    const out = render(note);
    expect(out.html).not.toContain('A note from me');
    expect(out.text).not.toContain('A note from me');
    // No empty paragraph or stray break left where the note would have been.
    expect(out.html).not.toMatch(/<p>\s*<\/p>/);
    expect(out.html).toContain("</ul><p>I'll be there ready to go.");
    expect(out.text).not.toMatch(/\n{3,}/);
    expect(out.html).not.toContain('{{');
    expect(out.text).not.toContain('{{');
  });

  it('prints markup in a note as text, never as markup', () => {
    const out = render('<script>alert(1)</script> & <a href="https://kinfolk.tribetails.com">tap</a> "now"');
    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('<a href="https://kinfolk.tribetails.com">tap</a>');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;a href');
    expect(out.html).toContain('&quot;now&quot;');
    // The text part is plain text: the same words, as typed.
    expect(out.text).toContain('A note from me: <script>alert(1)</script> & <a href');
  });

  it('a note that is only a web address stays text, and one with markup after it is still escaped', () => {
    // `renderEmailParts` lets a bare https address through unescaped so a
    // button's href survives; a note is not a button, and gains no markup by it.
    const plain = render('https://kinfolk.tribetails.com/notifications?a=1&b=2');
    expect(plain.html).toContain('<strong>A note from me:</strong> https://kinfolk.tribetails.com/notifications?a=1&b=2<br>');
    expect(plain.html).not.toContain('<a href="https://kinfolk.tribetails.com/notifications');

    const sly = render('https://kinfolk.tribetails.com/"><img src=x onerror=alert(1)>');
    expect(sly.html).not.toContain('<img src=x');
    expect(sly.html).toContain('&lt;img src');
  });

  it('a note with Handlebars in it is printed, not run', () => {
    const out = render('{{kinfolkName}} {{{portalUrl}}} {{#each visits}}x{{/each}}');
    expect(out.html).not.toContain('Jordan https://');
    expect(out.html).not.toContain('xx');
  });

  it('the template prints the note with two braces only, inside one #if', () => {
    expect(seed.emailContent).toContain('{{#if note}}');
    expect(seed.emailContent).not.toContain('{{{');
    expect(seed.emailContent.match(/\{\{note\}\}/g)).toHaveLength(1);
  });
});
