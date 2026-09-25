import { describe, it, expect } from 'vitest';
import { sanitizeEmailContent } from '../src/lib/emailContent';
import { contentToText } from '../src/lib/emailFrame';

const CLOUD = 'tribetails';
const IMG = `https://res.cloudinary.com/${CLOUD}/image/upload/v1/brand/pup.jpg`;
const clean = (h: string) => sanitizeEmailContent(h, CLOUD);

describe('sanitizeEmailContent', () => {
  it('keeps every allowed element', () => {
    const html =
      '<h2>Hi</h2><h3>Sub</h3><p>A <strong>b</strong> <em>c</em><br>d</p>' +
      '<ul><li>x</li></ul><ol><li>y</li></ol><blockquote><p>careful</p></blockquote>' +
      `<p><a href="https://tribetails.com">site</a></p><p><img src="${IMG}" alt="pup"></p>`;
    const r = clean(html);
    expect(r.issues).toEqual([]);
    expect(r.content).toBe(html);
  });

  it('keeps a button and a token href', () => {
    const r = clean('<p><a href="{{link}}" class="button">Reset</a></p>');
    expect(r.issues).toEqual([]);
    expect(r.content).toBe('<p><a href="{{link}}" class="button">Reset</a></p>');
  });

  it('strips styles, classes, spans, divs and fonts but keeps their text (pasted from Word or Gmail)', () => {
    const r = clean('<div style="color:red"><span class="x"><font face="Arial">Hello</font></span></div><p style="margin:6px 0">there</p>');
    expect(r.content).toBe('<p>Hello</p><p>there</p>');
    expect(r.issues).toEqual([]);
  });

  it('removes scripts, event handlers and javascript: links entirely', () => {
    const r = clean('<p onclick="x()">a</p><script>alert(1)</script><p><a href="javascript:alert(1)">b</a></p>');
    expect(r.content).toBe('<p>a</p><p>b</p>');
  });

  it('drops images from anywhere but our Cloudinary', () => {
    const r = clean('<p><img src="https://evil.example/x.png"></p><p>t</p>');
    expect(r.content).toBe('<p></p><p>t</p>');
    expect(r.issues).toContain('Removed an image that is not from your Cloudinary library.');
  });

  it('refuses a token anywhere but text or href', () => {
    const r = clean(`<p><img src="${IMG}" alt="{{name}}"></p>`);
    expect(r.issues).toContain('A merge field can only be used in text or as a link target.');
  });

  it('refuses a token split by formatting', () => {
    const r = clean('<p>{{li<strong>nk</strong>}}</p>');
    expect(r.issues).toContain('A merge field was broken apart by formatting. Retype it as one piece.');
  });

  it('does not flag a token as split when it contains a private-use-area character (pasted icon-font glyphs are text, not a tag boundary)', () => {
    const r = clean('<p>{{link}}</p>');
    expect(r.issues).not.toContain('A merge field was broken apart by formatting. Retype it as one piece.');
  });

  it('refuses an href that mixes a token with other text', () => {
    const r = clean('<p><a href="https://x.com/{{id}}">a</a></p>');
    expect(r.issues).toContain('A link target must be a web address or a single merge field, not both.');
  });

  it('refuses triple-stash', () => {
    expect(clean('<p>{{{raw}}}</p>').issues).toContain('Triple braces {{{ }}} are not allowed.');
  });

  it('reports empty content', () => {
    expect(clean('<p> </p>').issues).toContain('The email body is empty.');
  });

  it('wraps a top-level bare text/inline run in its own <p>, block-by-block', () => {
    const r = clean('Hi {{displayName}}, <strong>welcome</strong><p>next</p>');
    expect(r.content).toBe('<p>Hi {{displayName}}, <strong>welcome</strong></p><p>next</p>');
    expect(r.issues).toEqual([]);
  });

  it('contentToText renders a wrapped bare top-level run', () => {
    const { content } = clean('Hi {{displayName}}, <strong>welcome</strong><p>next</p>');
    expect(contentToText('H', content)).toContain('Hi {{displayName}}, welcome');
  });

  it('drops a whitespace-only top-level run instead of leaving an empty <p>', () => {
    const r = clean('<p>a</p>   <p>b</p>');
    expect(r.content).toBe('<p>a</p><p>b</p>');
  });

  it('refuses a relative href', () => {
    const r = clean('<p><a href="reset">Reset</a></p>');
    expect(r.issues).toContain('A link must point to a web address (https://), an email address (mailto:), or a merge field.');
  });

  it('refuses a fragment href', () => {
    const r = clean('<p><a href="#top">Top</a></p>');
    expect(r.issues).toContain('A link must point to a web address (https://), an email address (mailto:), or a merge field.');
  });

  it('does not flag an https href or a mailto href', () => {
    const r = clean('<p><a href="https://tribetails.com">a</a> <a href="mailto:help@tribetails.com">b</a></p>');
    expect(r.issues).toEqual([]);
  });
});
