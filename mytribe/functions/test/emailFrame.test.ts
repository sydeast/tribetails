import { describe, it, expect } from 'vitest';
import { contentToText, frameHtml, isVisualTemplate, sendPartsFor } from '../src/lib/emailFrame';
import { renderEmailParts } from '../src/lib/email';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';

describe('frameHtml', () => {
  it('puts headline and content inside the shared frame', () => {
    const html = frameHtml('Reset your password', '<p>Hi</p>');
    expect(html).toContain('<div class="header"><h2>Reset your password</h2></div>');
    expect(html).toContain('<div class="content"><p>Hi</p></div>');
    expect(html).toContain("Tribe Tails Pet Care. Your Kin's Favorite Auntie.");
    expect(html).toContain('border-top: 8px solid #df8431');
    expect(html).toContain('blockquote {');
  });

  it('HTML-escapes the headline so it cannot break out of the <h2> or inject markup', () => {
    const html = frameHtml('A & <b>', '<p>x</p>');
    expect(html).toContain('<h2>A &amp; &lt;b&gt;</h2>');
  });

  it('leaves a {{token}} in the headline intact for Handlebars to resolve', () => {
    const html = frameHtml('Hi {{displayName}}', '<p>x</p>');
    expect(html).toContain('<h2>Hi {{displayName}}</h2>');
  });
});

describe('contentToText', () => {
  it('turns blocks into lines, buttons into Label: href, links into text (href)', () => {
    const text = contentToText(
      'Reset',
      '<p>Hi {{displayName}},</p><h3>Steps</h3><ul><li>One</li><li>Two</li></ul>' +
        '<p><a href="{{link}}" class="button">Reset Password</a></p>' +
        '<p>See <a href="https://tribetails.com/help">help</a> or https://x.com.</p>' +
        '<blockquote><p>Careful</p></blockquote><p>Take care,<br><strong>Auntie</strong></p>',
    );
    expect(text).toBe(
      [
        'Reset',
        '',
        'Hi {{displayName}},',
        '',
        'Steps',
        '',
        '- One',
        '- Two',
        '',
        'Reset Password: {{link}}',
        '',
        'See help (https://tribetails.com/help) or https://x.com.',
        '',
        'Careful',
        '',
        'Take care,',
        'Auntie',
      ].join('\n'),
    );
  });

  it('numbers ordered lists and skips images', () => {
    expect(contentToText('H', '<ol><li>a</li><li>b</li></ol><p><img src="x" alt="y"></p>')).toBe('H\n\n1. a\n2. b');
  });

  it('does not repeat a link whose text is its address', () => {
    expect(contentToText('H', '<p><a href="https://x.com">https://x.com</a></p>')).toBe('H\n\nhttps://x.com');
  });

  it('indents a <br> continuation line under a bulleted item', () => {
    expect(contentToText('H', '<ul><li>Line1<br>Line2</li><li>Two</li></ul>')).toBe('H\n\n- Line1\n  Line2\n- Two');
  });

  it('indents a <br> continuation line under a numbered item', () => {
    expect(contentToText('H', '<ol><li>a<br>b</li></ol>')).toBe('H\n\n1. a\n   b');
  });

  it('drops a trailing empty line from a trailing <br>', () => {
    expect(contentToText('H', '<ul><li>a<br></li></ul>')).toBe('H\n\n- a');
  });

  it('marks the first non-empty line when a <br> leads the item', () => {
    expect(contentToText('H', '<ul><li><br>a</li></ul>')).toBe('H\n\n- a');
  });

  // CRITICAL fix: a bare text node directly inside a `<ul>`/`<ol>` (a
  // Handlebars block tag like `{{#each visits}}`, not visible content) used
  // to be dropped along with every other non-`<li>` child, leaving the
  // `<li>` line with no loop wrapper around it. It must now survive in
  // document order, interleaved with the `<li>` line(s).
  it('keeps a bare text node inside a list in document order, around the <li> line', () => {
    expect(contentToText('H', '<ul>{{#each visits}}<li>{{this.name}}</li>{{/each}}</ul>')).toBe(
      'H\n\n{{#each visits}}\n- {{this.name}}\n{{/each}}',
    );
  });

  it('numbers only the <li> items, not the interleaved text nodes', () => {
    expect(contentToText('H', '<ol>{{#each xs}}<li>{{this}}</li>{{/each}}</ol>')).toBe('H\n\n{{#each xs}}\n1. {{this}}\n{{/each}}');
  });

  // Bare text directly inside a <blockquote> (never wrapped in a <p>) is
  // visible callout content, not layout noise, and must not be dropped the
  // way plain top-level text handling would drop it.
  it('emits bare text directly inside a blockquote instead of dropping it', () => {
    expect(contentToText('H', '<blockquote>Careful now</blockquote>')).toBe('H\n\nCareful now');
  });

  it('keeps bare text alongside a nested element inside a blockquote', () => {
    expect(contentToText('H', '<blockquote>Note: <p>see below</p></blockquote>')).toBe('H\n\nNote:\n\nsee below');
  });
});

describe('contentToText: the {{#each}} loop seeds render one line per visit', () => {
  // assignment.assigned and kincare.booking.confirm are the two seeds whose
  // content wraps a single `<li>{{this.weekday}}, {{this.date}} at
  // {{this.time}}</li>` in `{{#each visits}}...{{/each}}`, written directly
  // as bare text around the `<li>` (see seedCorpus.generated.ts). Built and
  // rendered exactly as a real send would (sendPartsFor + renderEmailParts,
  // real Handlebars), with a real two-item `visits` array, so this proves
  // the fix end to end, not just against contentToText's own output string.
  const VISITS = [
    { weekday: 'Thu', date: 'Sep 4', time: '9:00 AM' },
    { weekday: 'Fri', date: 'Sep 5', time: '10:00 AM' },
  ];

  it('assignment.assigned renders one line per visit', () => {
    const seed = SEED_CORPUS.find((s) => s.key === 'assignment.assigned')!;
    const doc = { subject: seed.emailSubject, format: 'visual' as const, headline: seed.emailHeadline, content: seed.emailContent };
    const out = renderEmailParts({
      ...sendPartsFor(doc),
      data: {
        kinName: 'Fido',
        serviceType: 'dog walking',
        portalUrl: 'https://auntieos.tribetails.com',
        visitCount: 2,
        visits: VISITS,
      },
    });
    // Adjacent, in order, with nothing stray between: proves the `{{#each}}`
    // wrapper actually looped, not just that both lines appear somewhere.
    expect(out.text).toContain('- Thu, Sep 4 at 9:00 AM\n- Fri, Sep 5 at 10:00 AM');
    expect(out.text).not.toContain('{{');
  });

  it('kincare.booking.confirm renders one line per visit', () => {
    const seed = SEED_CORPUS.find((s) => s.key === 'kincare.booking.confirm')!;
    const doc = { subject: seed.emailSubject, format: 'visual' as const, headline: seed.emailHeadline, content: seed.emailContent };
    const out = renderEmailParts({
      ...sendPartsFor(doc),
      data: {
        kinfolkName: 'Pat',
        kinName: 'Fido',
        serviceType: 'dog walking',
        portalUrl: 'https://kinfolk.tribetails.com',
        visitCount: 2,
        visits: VISITS,
      },
    });
    expect(out.text).toContain('- Thu, Sep 4 at 9:00 AM\n- Fri, Sep 5 at 10:00 AM');
    expect(out.text).not.toContain('{{');
  });

  it('an empty visits array leaves no stray broken bullet line', () => {
    for (const key of ['assignment.assigned', 'kincare.booking.confirm']) {
      const seed = SEED_CORPUS.find((s) => s.key === key)!;
      const doc = { subject: seed.emailSubject, format: 'visual' as const, headline: seed.emailHeadline, content: seed.emailContent };
      const out = renderEmailParts({
        ...sendPartsFor(doc),
        data: {
          kinfolkName: 'Pat',
          kinName: 'Fido',
          serviceType: 'dog walking',
          portalUrl: 'https://x.tribetails.com',
          visitCount: 0,
          visits: [],
        },
      });
      // No line left over from the loop body: no bullet marker at all, and
      // specifically not the broken "- ,  at " shape the missing #each wrap
      // used to produce.
      expect(out.text).not.toMatch(/^- /m);
      expect(out.text).not.toContain('- ,');
      expect(out.text).not.toContain('{{');
    }
  });
});

describe('sendPartsFor', () => {
  it('passes an old-format template through untouched', () => {
    expect(sendPartsFor({ subject: 's', body: 'b', html: '<p>h</p>' })).toEqual({
      subjectTemplate: 's',
      bodyTemplate: 'b',
      htmlTemplate: '<p>h</p>',
    });
    expect(sendPartsFor({ subject: 's', body: 'b', html: null })).toEqual({ subjectTemplate: 's', bodyTemplate: 'b' });
  });

  it('frames a visual template and generates its text', () => {
    const parts = sendPartsFor({ subject: 's', format: 'visual', headline: 'H', content: '<p>x</p>' });
    expect(parts.subjectTemplate).toBe('s');
    expect(parts.bodyTemplate).toBe('H\n\nx');
    expect(parts.htmlTemplate).toContain('<div class="content"><p>x</p></div>');
  });

  it('isVisualTemplate needs the flag and both fields', () => {
    expect(isVisualTemplate({ subject: 's', format: 'visual', headline: 'H', content: '<p>x</p>' })).toBe(true);
    expect(isVisualTemplate({ subject: 's', format: 'visual', headline: 'H' })).toBe(false);
    expect(isVisualTemplate({ subject: 's', body: 'b' })).toBe(false);
  });

  it('a {{token}} headline survives a real render with the value substituted', () => {
    const parts = sendPartsFor({ subject: 's', format: 'visual', headline: 'Hi {{displayName}}', content: '<p>x</p>' });
    const out = renderEmailParts({ ...parts, data: { displayName: 'Pat' } });
    expect(out.html).toContain('<h2>Hi Pat</h2>');
  });

  it('throws when a document is marked visual but has no headline or content', () => {
    expect(() => sendPartsFor({ subject: 's', format: 'visual' })).toThrow(
      'email template is marked visual but has no headline or content',
    );
    expect(() => sendPartsFor({ subject: 's', format: 'visual', headline: 'H' })).toThrow(
      'email template is marked visual but has no headline or content',
    );
  });

  it('an old-format document with an empty body still sends as today', () => {
    expect(sendPartsFor({ subject: 's', body: '' })).toEqual({ subjectTemplate: 's', bodyTemplate: '' });
  });
});
