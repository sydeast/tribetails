import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { convertLegacyTemplate } from '../src/notifications/convertLegacyTemplate';

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
    const html = readFileSync(join(__dirname, '../../seeds/notificationTemplates/auth.password.reset/email.html'), 'utf8');
    const r = convertLegacyTemplate(html, '');
    expect(r).toMatchObject({ ok: true, headline: 'Reset your Tribe Tails password' });
    expect((r as { content: string }).content).toContain('<a href="{{link}}" class="button">Reset Password</a>');
  });
});
