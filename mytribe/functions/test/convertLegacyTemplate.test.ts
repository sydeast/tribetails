import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { convertLegacyTemplate } from '../src/notifications/convertLegacyTemplate';
import { sanitizeEmailContent } from '../src/lib/emailContent';

const frame = (inner: string, h = 'Hello there') =>
  `<!DOCTYPE html><html><head><style>.x{}</style></head><body><div class="container">` +
  `<div class="header"><h2>${h}</h2></div><div class="content">${inner}</div>` +
  `<div class="footer">Tribe Tails Pet Care.</div></div></body></html>`;

describe('convertLegacyTemplate', () => {
  it('takes the headline from the header and the content from the content box', () => {
    expect(convertLegacyTemplate(frame('<p>Hi {{displayName}}</p>'), '')).toEqual({
      ok: true,
      headline: 'Hello there',
      content: '<p>Hi {{displayName}}</p>',
    });
  });

  it("keeps a single-quoted button as a button", () => {
    const r = convertLegacyTemplate(frame("<a href='{{link}}' class='button'>Reset Password</a>"), '');
    expect(r).toMatchObject({ ok: true, content: '<p><a href="{{link}}" class="button">Reset Password</a></p>' });
  });

  it('turns an alert box into a callout and drops styling', () => {
    const r = convertLegacyTemplate(frame('<div class="alert-box"><strong>Heads up</strong> x</div><p style="margin:6px 0">y</p><ul class="visits"><li>z</li></ul>'), '');
    expect(r).toMatchObject({ ok: true, content: '<blockquote><p><strong>Heads up</strong> x</p></blockquote><p>y</p><ul><li>z</li></ul>' });
  });

  it('keeps the text of any other nested div as paragraphs', () => {
    const r = convertLegacyTemplate(frame('<div>Plain words</div>'), '');
    expect(r).toMatchObject({ ok: true, content: '<p>Plain words</p>' });
  });

  it('refuses HTML without the frame', () => {
    expect(convertLegacyTemplate('<p>hand built</p>', '')).toEqual({ ok: false, reason: 'unreadable' });
    expect(convertLegacyTemplate(frame('<p>x</p>', ''), '')).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses a button with no href instead of guessing one', () => {
    const r = convertLegacyTemplate(frame('<p><a class="button" href="">Go</a></p>'), '');
    expect(r).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('converts the real reset seed', () => {
    const html = readFileSync(join(__dirname, 'fixtures/legacyResetEmail.html'), 'utf8');
    const r = convertLegacyTemplate(html, '');
    expect(r).toMatchObject({ ok: true, headline: 'Reset your Tribe Tails password' });
    expect((r as { content: string }).content).toContain('<a href="{{link}}" class="button">Reset Password</a>');
  });

  // Fix round 1 (review): a real .alert-box body sits on its own indented
  // line, e.g. `<div class="alert-box">\n  <p>...</p>\n</div>` -- the old
  // `(?!<p>)` lookahead didn't see past that leading whitespace and doubled
  // the paragraph.
  it('keeps an alert box that already holds a <p> from doubling it', () => {
    const r = convertLegacyTemplate(frame('<div class="alert-box">\n  <p>Heads up</p>\n</div>'), '');
    expect(r).toMatchObject({ ok: true, content: '<blockquote><p>Heads up</p></blockquote>' });
  });

  // Fix round 1 (review): the manual per-child pre-wrap split a single run
  // of bare text and inline markup into one <p> per child instead of one <p>
  // for the whole run.
  it('wraps a bare text-and-inline run in a single paragraph', () => {
    const r = convertLegacyTemplate(frame('Hi <strong>there</strong>, welcome'), '');
    expect(r).toMatchObject({ ok: true, content: '<p>Hi <strong>there</strong>, welcome</p>' });
  });

  // Fix round 1 (review): the old blanket `>\s+<` collapse deleted a real
  // space typed between two inline elements, not just layout indentation.
  it('keeps the space between two adjacent inline elements', () => {
    const r = convertLegacyTemplate(frame('<p><strong>a</strong> <em>b</em></p>'), '');
    expect(r).toMatchObject({ ok: true, content: '<p><strong>a</strong> <em>b</em></p>' });
  });

  // Fix round 2 (review): the whitespace collapse consumed the tag on the
  // right of each gap, so it couldn't also serve as the left tag of the
  // NEXT gap -- a three-deep chain (blockquote > p > strong) only collapsed
  // every other gap, leaking indentation around the middle tag.
  it('collapses every layout gap in a chain of nested block tags, not just every other one', () => {
    const r = convertLegacyTemplate(frame('<div class="alert-box">\n  <p>\n    <strong>x</strong>\n  </p>\n</div>'), '');
    expect(r).toMatchObject({ ok: true, content: '<blockquote><p><strong>x</strong></p></blockquote>' });
  });

  it('produces output the sanitizer accepts unchanged, with no doubled paragraph tags', () => {
    const cases = [
      frame('<div class="alert-box">\n  <p>Heads up</p>\n</div>'),
      frame('Hi <strong>there</strong>, welcome'),
      frame('<p><strong>a</strong> <em>b</em></p>'),
      frame('<div class="alert-box">\n  <p>\n    <strong>x</strong>\n  </p>\n</div>'),
    ];
    for (const html of cases) {
      const r = convertLegacyTemplate(html, '');
      if (!r.ok) throw new Error(`expected ok for ${html}`);
      expect(r.content).not.toContain('<p><p');
      expect(r.content).not.toContain('</p></p>');
      const resanitized = sanitizeEmailContent(r.content, '');
      expect(resanitized.issues).toEqual([]);
      expect(resanitized.content).toBe(r.content);
    }
  });
});
