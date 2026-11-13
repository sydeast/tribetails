// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RichText } from './RichText';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
describe('RichText', () => {
  it('renders formatting, not the tags as text', () => {
    const { container } = render(
      <RichText body="<p>Hi Auntie, <strong>please give Sandbox Dog</strong> an extra treat!</p>" />,
    );
    expect(container.textContent).toBe('Hi Auntie, please give Sandbox Dog an extra treat!');
    expect(container.querySelector('strong')?.textContent).toBe('please give Sandbox Dog');
    expect(container.textContent).not.toContain('<p>');
  });
  it('never creates a script, img or handler from a hostile body', () => {
    const { container } = render(
      <RichText body={'<p onclick="x()">a</p><script>window.__pwn=1</script><img src=x onerror="window.__pwn=1"><a href="javascript:window.__pwn=1">l</a>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });
  it('opens links safely', () => {
    render(<RichText body='<a href="https://example.com">site</a>' />);
    const a = screen.getByRole('link', { name: 'site' });
    expect(a).toHaveAttribute('href', 'https://example.com');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(a).toHaveAttribute('target', '_blank');
  });
  it('keeps line breaks of a plain reply', () => {
    const { container } = render(<RichText body={'line one\nline two'} />);
    expect(container.firstElementChild).toHaveStyle({ whiteSpace: 'pre-wrap' });
    expect(container.textContent).toBe('line one\nline two');
  });
});

describe('RichText with a less-than sign (#1873)', () => {
  it('shows every word of a message that has a stray < beside real tags', () => {
    const { container } = render(<RichText body="<p>I think 5 < 6 and 7 > 3 and <b>bold</b> more words</p>" />);
    expect(container.textContent).toBe('I think 5 < 6 and 7 > 3 and bold more words');
    expect(container.querySelector('b')?.textContent).toBe('bold');
  });
  it('shows a tag-looking span as the text typed', () => {
    const { container } = render(<RichText body="<p>a <b and more words</p><p>x &lt; y</p>" />);
    expect(container.textContent).toBe('a <b and more wordsx < y');
    expect(container.querySelector('b')).toBeNull();
  });
  it('a script-like message is text, not an element, and nothing runs', () => {
    const { container } = render(
      <RichText body={'<p>&lt;</p><p><script>window.__pwn=2</script><img src=x onerror="window.__pwn=2"></p>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>window.__pwn=2</script><img src=x onerror="window.__pwn=2">');
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });
  it('a plain body with only a stray < keeps all its text and line breaks', () => {
    const { container } = render(<RichText body={'5 < 6\nnext > line'} />);
    expect(container.textContent).toBe('5 < 6\nnext > line');
  });
  it('an empty body draws nothing', () => {
    const { container } = render(<RichText body="" />);
    expect(container.textContent).toBe('');
  });
});

describe('RichText with the stored form of a hostile link', () => {
  it('opens only a safe address and adds no handler', () => {
    const { container } = render(
      <RichText
        body={
          '<p><a href="https://example.com/?a=1&amp;b=2">ok</a> ' +
          '<a href="java&amp;#x73;cript:alert(1)">x</a> ' +
          '<a href="https://example.com/&amp;quot; onclick=&amp;quot;alert(1)">s</a> ' +
          '<a href=`javascript:alert(1)`>y <b onclick=`alert(1)`>z</p>'
        }
      />,
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com/?a=1&b=2', 'https://example.com/&quot; onclick=&quot;alert(1)']);
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('ok x s <a href=`javascript:alert(1)`>y <b onclick=`alert(1)`>z');
  });
});

interface MessageFixtures {
  hostile: { input: string; stored: string }[];
  plainText: { typed: string; sent: string; stored: string }[];
  editor: { html: string; typed: string; stored: string }[];
}
// Stored bodies exactly as the server writes them (pinned by the functions suite).
const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../functions/test/fixtures/messageBodies.json'), 'utf8'),
) as MessageFixtures;
const allStored = [
  ...fixtures.hostile.map((f) => f.stored),
  ...fixtures.plainText.map((f) => f.stored),
  ...fixtures.editor.map((f) => f.stored),
];
const ALLOWED_ELEMENTS = ['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'blockquote', 'a'];
describe('RichText and the stored message bodies', () => {
  it('inserted as HTML (as an older screen did), a stored body makes only allowed elements and safe links', () => {
    for (const stored of allStored) {
      const div = document.createElement('div');
      div.innerHTML = stored;
      for (const el of Array.from(div.querySelectorAll('*'))) {
        expect(ALLOWED_ELEMENTS).toContain(el.tagName.toLowerCase());
        for (const attr of Array.from(el.attributes)) {
          expect(`${el.tagName.toLowerCase()} ${attr.name}`).toBe('a href');
          expect(['http:', 'https:', 'mailto:']).toContain(new URL(attr.value, 'https://example.com/').protocol);
        }
      }
    }
  });
  it('a plain-text message reads back as typed, drawn here and inserted as HTML', () => {
    for (const f of fixtures.plainText) {
      const { container, unmount } = render(<RichText body={f.stored} />);
      expect(container.textContent).toBe(f.typed);
      unmount();
      const div = document.createElement('div');
      div.innerHTML = f.stored;
      expect(div.textContent).toBe(f.typed);
    }
  });
  it('an editor message reads back as typed, with its formatting', () => {
    for (const f of fixtures.editor) {
      const { container, unmount } = render(<RichText body={f.stored} />);
      expect(container.textContent).toBe(f.typed);
      unmount();
    }
  });
  it('a hostile body never becomes a script, image or handler when drawn', () => {
    for (const f of fixtures.hostile) {
      const { container, unmount } = render(<RichText body={f.stored} />);
      expect(container.querySelector('script, img, svg, iframe, [onclick], [onerror], [onload]')).toBeNull();
      for (const a of Array.from(container.querySelectorAll('a'))) {
        expect(a.getAttribute('href') ?? '').toMatch(/^(https?:\/\/|mailto:)/);
      }
      unmount();
    }
  });
});
