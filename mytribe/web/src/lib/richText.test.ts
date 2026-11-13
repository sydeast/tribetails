import { describe, it, expect } from 'vitest';
import { parseRichText, hasMarkup, decodeEntities, type RichNode } from './richText';
function flat(nodes: RichNode[]): string {
  return nodes
    .map((n) => (n.kind === 'text' ? n.text : `<${n.tag}${n.href ? ` href=${n.href}` : ''}>${flat(n.children)}</${n.tag}>`))
    .join('');
}
describe('parseRichText', () => {
  it('keeps the allowed subset as elements', () => {
    expect(flat(parseRichText('<p>Hi Auntie, <strong>please give Sandbox Dog</strong> an extra treat!</p>'))).toBe(
      '<p>Hi Auntie, <strong>please give Sandbox Dog</strong> an extra treat!</p>',
    );
  });
  it('handles lists, quotes and br', () => {
    expect(flat(parseRichText('<ul><li>a</li><li>b</li></ul><blockquote>q</blockquote>x<br>y'))).toBe(
      '<ul><li>a</li><li>b</li></ul><blockquote>q</blockquote>x<br></br>y',
    );
  });
  it('shows a tag that is not in the allowed subset as the text typed, never as an element', () => {
    expect(flat(parseRichText('a<script>alert(1)</script>b<img src=x onerror=alert(1)>c<div>d</div>'))).toBe(
      'a<script>alert(1)</script>b<img src=x onerror=alert(1)>c<div>d</div>',
    );
  });
  it('a tag carrying attributes other than quoted ones on a link is text', () => {
    expect(flat(parseRichText('<p onclick="x()">hi</p>'))).toBe('<p onclick="x()">hi');
  });
  it('drops every attribute but href on a link', () => {
    expect(flat(parseRichText('<a href="https://example.com" onclick="x()" target="_blank">hi</a>'))).toBe(
      '<a href=https://example.com>hi</a>',
    );
  });
  it('keeps http, https and mailto links only', () => {
    expect(flat(parseRichText('<a href="https://example.com/a?b=1&amp;c=2">x</a>'))).toBe(
      '<a href=https://example.com/a?b=1&c=2>x</a>',
    );
    expect(flat(parseRichText('<a href="mailto:catch@hanasamku.com">m</a>'))).toBe('<a href=mailto:catch@hanasamku.com>m</a>');
    expect(flat(parseRichText('<a href="javascript:alert(1)">bad</a>'))).toBe('<a>bad</a>');
    expect(flat(parseRichText('<a href="  JaVaScRiPt:alert(1)">bad</a>'))).toBe('<a>bad</a>');
    expect(flat(parseRichText('<a href="data:text/html,x">bad</a>'))).toBe('<a>bad</a>');
  });
  it('keeps entity-escaped text as inert text', () => {
    expect(flat(parseRichText('<p>&lt;script&gt;x&lt;/script&gt;</p>'))).toBe('<p><script>x</script></p>');
    expect(parseRichText('<p>&lt;script&gt;</p>')[0]).toMatchObject({ kind: 'el', tag: 'p' });
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
  it('survives unbalanced and unterminated input', () => {
    expect(flat(parseRichText('<p>one<p>two'))).toBe('<p>one<p>two</p></p>');
    expect(flat(parseRichText('text <b unterminated'))).toBe('text <b unterminated');
  });
  it('keeps every word around a stray less-than sign that sits beside real tags (#1873)', () => {
    expect(flat(parseRichText('<p>I think 5 < 6 and 7 > 3 and <b>bold</b></p>'))).toBe(
      '<p>I think 5 < 6 and 7 > 3 and <b>bold</b></p>',
    );
    expect(flat(parseRichText('<p>a <b and more words</p>'))).toBe('<p>a <b and more words</p>');
    expect(flat(parseRichText('<p>x <y and z</p><p>if a<b and c>d then go</p>'))).toBe(
      '<p>x <y and z</p><p>if a<b and c>d then go</p>',
    );
  });
  it('keeps emoji, ampersands and line breaks around the sign', () => {
    expect(flat(parseRichText('<p>Bella \u{1F436} &amp; Max < 3\nnext</p>'))).toBe('<p>Bella \u{1F436} & Max < 3\nnext</p>');
  });
  it('a sign at the very end or alone is text', () => {
    expect(flat(parseRichText('<p>ends with <</p>'))).toBe('<p>ends with <</p>');
    expect(flat(parseRichText('<'))).toBe('<');
  });
  it('hasMarkup is false for plain text with a stray angle bracket', () => {
    expect(hasMarkup('a <b and more words</p')).toBe(false);
    expect(hasMarkup('<script>alert(1)</script>')).toBe(false);
    expect(hasMarkup('2 < 3 and 5 > 4')).toBe(false);
    expect(hasMarkup('<p>x</p>')).toBe(true);
  });
});
