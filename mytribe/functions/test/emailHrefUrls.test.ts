import { describe, it, expect } from 'vitest';
import { renderEmailParts } from '../src/lib/email';

/**
 * #892 secondary defect: the html part rendered `{{link}}` with Handlebars
 * escaping, so `href` carried `&#x3D;` and `&amp;`. Browsers decode that, but a
 * click-tracking rewriter that reads the attribute literally hands the user a
 * broken reset link.
 *
 * The fix lives in the renderer, not in the templates: `{{{link}}}` is refused
 * by both template doors (`lib/templateValidation.ts`), so a triple-stash seed
 * could never be imported. Only a value that is a plain https URL renders raw;
 * everything else keeps its escaping.
 */

const RESET_LINK =
  'https://kinfolk.tribetails.com/account/secure-reset?mode=resetPassword&oobCode=abc=123&apiKey=k&lang=en';

function hrefOf(html: string): string {
  const m = /href=(['"])(.*?)\1/.exec(html);
  if (!m) throw new Error(`no href in ${html}`);
  return m[2];
}

describe('renderEmailParts: URLs inside href', () => {
  it('round-trips a URL containing & and = through a single-quoted href', () => {
    const { html } = renderEmailParts({
      subjectTemplate: 's',
      bodyTemplate: 'b',
      htmlTemplate: "<a href='{{link}}' class='button'>Reset Password</a>",
      data: { link: RESET_LINK },
    });
    expect(hrefOf(html!)).toBe(RESET_LINK);
    expect(html).not.toContain('&#x3D;');
    expect(html).not.toContain('&amp;');
  });

  it('round-trips through a double-quoted href too (the portalUrl shape)', () => {
    const portalUrl = 'https://kinfolk.tribetails.com/schedule?view=week&from=2026-09-14';
    const { html } = renderEmailParts({
      subjectTemplate: 's',
      bodyTemplate: 'b',
      htmlTemplate: '<a class="button" href="{{portalUrl}}">See your schedule</a>',
      data: { portalUrl },
    });
    expect(hrefOf(html!)).toBe(portalUrl);
  });

  it('keeps escaping a javascript: URL', () => {
    const { html } = renderEmailParts({
      subjectTemplate: 's',
      bodyTemplate: 'b',
      htmlTemplate: "<a href='{{link}}'>x</a>",
      data: { link: 'javascript:alert(1)//?a=1&b=2' },
    });
    expect(html).toContain('&amp;');
    expect(html).toContain('&#x3D;');
  });

  it('keeps escaping a plain http URL', () => {
    const { html } = renderEmailParts({
      subjectTemplate: 's',
      bodyTemplate: 'b',
      htmlTemplate: "<a href='{{link}}'>x</a>",
      data: { link: 'http://example.com/?a=1&b=2' },
    });
    expect(html).toContain('&amp;');
  });

  it('never lets an https value break out of the attribute or inject markup', () => {
    const hostile = [
      "https://example.com/?a=1'onmouseover='alert(1)",
      'https://example.com/?a="><script>alert(1)</script>',
      'https://example.com/ onmouseover=alert(1)',
      'https://example.com/`x`',
    ];
    for (const link of hostile) {
      const { html } = renderEmailParts({
        subjectTemplate: 's',
        bodyTemplate: 'b',
        htmlTemplate: "<a href='{{link}}'>x</a>",
        data: { link },
      });
      expect(html, link).not.toContain("'onmouseover");
      expect(html, link).not.toContain('<script>');
      expect(html, link).not.toContain('"><');
      expect(html, link).not.toMatch(/ onmouseover=/);
    }
  });

  it('still escapes ordinary text values in html', () => {
    const { html } = renderEmailParts({
      subjectTemplate: 's',
      bodyTemplate: 'b',
      htmlTemplate: '<p>{{displayName}}</p>',
      data: { displayName: '<b>Dee & Co</b>' },
    });
    expect(html).toBe('<p>&lt;b&gt;Dee &amp; Co&lt;/b&gt;</p>');
  });

  it('leaves subject and text rendering unchanged (noEscape)', () => {
    const parts = renderEmailParts({
      subjectTemplate: 'Reset for {{displayName}}',
      bodyTemplate: 'Open {{link}}',
      data: { displayName: 'Dee & Co', link: RESET_LINK },
    });
    expect(parts.subject).toBe('Reset for Dee & Co');
    expect(parts.text).toBe(`Open ${RESET_LINK}`);
    expect(parts.html).toBeUndefined();
  });
});
