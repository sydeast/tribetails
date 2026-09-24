import { describe, it, expect } from 'vitest';
import { contentToText, frameHtml, isVisualTemplate, sendPartsFor } from '../src/lib/emailFrame';

describe('frameHtml', () => {
  it('puts headline and content inside the shared frame', () => {
    const html = frameHtml('Reset your password', '<p>Hi</p>');
    expect(html).toContain('<div class="header"><h2>Reset your password</h2></div>');
    expect(html).toContain('<div class="content"><p>Hi</p></div>');
    expect(html).toContain("Tribe Tails Pet Care. Your Kin's Favorite Auntie.");
    expect(html).toContain('border-top: 8px solid #df8431');
    expect(html).toContain('blockquote {');
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
});
