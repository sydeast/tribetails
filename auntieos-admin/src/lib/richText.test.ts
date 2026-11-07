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
  it('drops script content and unwraps unknown tags', () => {
    expect(flat(parseRichText('a<script>alert(1)</script>b<img src=x onerror=alert(1)>c<div>d</div>'))).toBe('abcd');
  });
  it('drops every attribute but href', () => {
    expect(flat(parseRichText('<p onclick="x()" style="color:red">hi</p>'))).toBe('<p>hi</p>');
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
  it('hasMarkup is false for plain text with a stray angle bracket', () => {
    expect(hasMarkup('2 < 3 and 5 > 4')).toBe(false);
    expect(hasMarkup('<p>x</p>')).toBe(true);
  });
});
