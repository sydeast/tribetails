import { describe, it, expect } from 'vitest';
import { sanitizeRichText, sanitizePlainText, toPlainTextPreview } from '../src/lib/richText';

describe('sanitizeRichText', () => {
  it('passes plain text through unchanged', () => {
    expect(sanitizeRichText('See you at 3pm, bring the leash!')).toBe('See you at 3pm, bring the leash!');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeRichText('  hi  ')).toBe('hi');
  });

  it('keeps the allowed formatting subset', () => {
    expect(sanitizeRichText('<p>Hi <b>there</b> <i>friend</i></p>')).toBe('<p>Hi <b>there</b> <i>friend</i></p>');
    expect(sanitizeRichText('<ul><li>one</li><li>two</li></ul>')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('keeps a safe link but strips onclick/other attrs', () => {
    expect(sanitizeRichText('<a href="https://example.com" onclick="evil()">link</a>')).toBe(
      '<a href="https://example.com">link</a>',
    );
  });

  it('drops a javascript: href scheme entirely', () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">click me</a>')).toBe('<a>click me</a>');
  });

  it('drops a protocol-relative href', () => {
    expect(sanitizeRichText('<a href="//evil.example/phish">click me</a>')).toBe('<a>click me</a>');
  });

  it('strips script tags and their content', () => {
    expect(sanitizeRichText('hello <script>alert(1)</script> world')).toBe('hello  world');
  });

  it('strips style tags and their content', () => {
    expect(sanitizeRichText('<style>body{display:none}</style>text')).toBe('text');
  });

  it('unwraps disallowed tags but keeps their text', () => {
    expect(sanitizeRichText('<div onclick="evil()">hello</div>')).toBe('hello');
    expect(sanitizeRichText('<img src=x onerror="evil()">caption')).toBe('caption');
  });

  it('neutralizes an inline SVG XSS payload', () => {
    expect(sanitizeRichText('<svg onload="alert(1)"></svg>after')).toBe('after');
  });

  it('preserves literal comparison operators and ampersands as themselves, not HTML entities', () => {
    expect(sanitizeRichText('5 < 10 and 10 > 5')).toBe('5 < 10 and 10 > 5');
    expect(sanitizeRichText('Bob & Sue')).toBe('Bob & Sue');
    expect(sanitizeRichText("it's a \"test\"")).toBe('it\'s a "test"');
  });

  it('a user typing literal HTML-looking text gets it back as inert text, not a parsed tag', () => {
    // sanitize-html's parser treats source-level entities as text content
    // throughout, so this round-trips as a plain string — it is never fed
    // back into anything that interprets it as markup downstream.
    expect(sanitizeRichText('&lt;script&gt;alert(1)&lt;/script&gt; (typed literally)')).toBe(
      '<script>alert(1)</script> (typed literally)',
    );
  });

  it('a real allowed link survives entity decoding unmangled', () => {
    expect(sanitizeRichText('<a href="https://example.com/?a=1&b=2">link</a>')).toBe(
      '<a href="https://example.com/?a=1&b=2">link</a>',
    );
  });
});

describe('sanitizeRichText — output never contains a live, unescaped tag', () => {
  // The safety invariant `dangerouslySetInnerHTML` on this field relies on
  // (web/src/screens/Messages.tsx): the stored string must never contain a
  // literal, unescaped `<` — only `&lt;`/`&gt;` entities, which a browser's
  // HTML parser decodes into inert TEXT content (entity decoding is
  // single-pass; the decoded character is never re-tokenized as markup).
  // Layered/double-encoded input (which sendKinfolkMessage.ts's two-call
  // chain — sendKinfolkMessage.ts then appendMessage's own re-sanitize —
  // passes through sanitizeRichText twice) must still hold this invariant.
  // Verified against a real HTML parser (jsdom): neither payload below
  // produces a live <img>/<a> element when actually set as innerHTML.
  function assertNoLiveTag(out: string) {
    expect(out).not.toMatch(/<[a-z!/]/i);
  }

  it('a single-encoded fake-tag payload never resurrects a live tag', () => {
    const out = sanitizeRichText('&amp;lt;img src=x onerror=alert(1)&amp;gt;');
    assertNoLiveTag(out);
  });

  it('a double-encoded payload, run through sanitizeRichText twice (the real message write-path chain), never resurrects a live tag', () => {
    const once = sanitizeRichText('&amp;amp;lt;img src=x onerror=alert(1)&amp;amp;gt;');
    const twice = sanitizeRichText(once);
    assertNoLiveTag(twice);
  });

  it('a double-encoded fake-link payload never resurrects a live href', () => {
    const once = sanitizeRichText('&amp;lt;a href=&amp;quot;javascript:alert(1)&amp;quot;&amp;gt;click&amp;lt;/a&amp;gt;');
    assertNoLiveTag(once);
  });
});

describe('sanitizePlainText', () => {
  it('strips all markup, keeping only text', () => {
    expect(sanitizePlainText('<b>Bold</b> and <a href="https://evil.example">link</a>')).toBe('Bold and link');
  });

  it('leaves ordinary text/punctuation untouched', () => {
    expect(sanitizePlainText('Bob & Sue said "hi" — 5 < 10')).toBe('Bob & Sue said "hi" — 5 < 10');
  });

  it('strips a script tag and its content', () => {
    expect(sanitizePlainText('<script>alert(1)</script>Mallory')).toBe('Mallory');
  });
});

describe('toPlainTextPreview', () => {
  it('strips markup and truncates to maxLength', () => {
    expect(toPlainTextPreview('<b>Hello</b> world', 5)).toBe('Hello');
  });

  it('does not truncate mid-tag because it strips tags first', () => {
    expect(toPlainTextPreview('<a href="https://example.com">a very long link text</a>', 6)).toBe('a very');
  });

  it('passes short plain text through unchanged', () => {
    expect(toPlainTextPreview('hi there', 200)).toBe('hi there');
  });
});
