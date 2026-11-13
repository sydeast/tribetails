import { describe, it, expect } from 'vitest';
import {
  sanitizeRichText,
  sanitizePlainText,
  toPlainTextPreview,
  sanitizeMessageBody,
  messagePlainText,
  messagePreview,
} from '../src/lib/richText';

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

describe('a less-than sign that does not open a tag is kept as typed (#1873)', () => {
  it('happy: keeps the words after a stray < next to a real tag', () => {
    expect(sanitizeRichText('I think 5 < 6 and 7 > 3 and <b>bold</b>')).toBe('I think 5 < 6 and 7 > 3 and <b>bold</b>');
    expect(sanitizeRichText('<p>under 5 < 6 and more words</p>')).toBe('<p>under 5 < 6 and more words</p>');
  });

  it('keeps a < glued to a letter or digit with no closing >', () => {
    expect(sanitizeRichText('a <b and more words')).toBe('a <b and more words');
    expect(sanitizeRichText('x <y and z')).toBe('x <y and z');
    expect(sanitizeRichText('1<2 and a<3 love <3')).toBe('1<2 and a<3 love <3');
  });

  it('a word-like span that is not a clean tag is text, with the words after it', () => {
    expect(sanitizeRichText('<p>a <b and more words</p>')).toBe('<p>a <b and more words</p>');
    expect(sanitizeRichText('if a<b and c>d then go')).toBe('if a<b and c>d then go');
  });

  it('keeps emoji, ampersands and line breaks around the sign', () => {
    expect(sanitizeRichText('Bella \u{1F436} & Max < 3\nsecond line')).toBe('Bella \u{1F436} & Max < 3\nsecond line');
  });

  it('negative: real tags are still kept and tags that are not allowed are still stripped', () => {
    expect(sanitizeRichText('<p>Hi <b>there</b></p>')).toBe('<p>Hi <b>there</b></p>');
    expect(sanitizeRichText('hello <script>alert(1)</script> world')).toBe('hello  world');
    expect(sanitizeRichText('<img src=x onerror="evil()">caption')).toBe('caption');
    expect(sanitizeRichText('<a href="javascript:alert(1)">click</a>')).toBe('<a>click</a>');
  });

  it('error: a stray < never lets a real element or handler through', () => {
    // A `<` that is not a whole tag is kept as inert text (clients draw the
    // stored body as text from a fixed tag list); a whole tag is still cut.
    expect(sanitizeRichText('<p>x <img src=x onerror=alert(1)></p>')).toBe('<p>x </p>');
    expect(sanitizeRichText('<svg onload="alert(1)"></svg>after')).toBe('after');
    expect(sanitizeRichText('<b onclick="evil()">hi</b>')).toBe('<b>hi</b>');
  });

  it('sanitizePlainText and the preview keep the text after a stray <', () => {
    expect(sanitizePlainText('a <b and more words')).toBe('a <b and more words');
    expect(sanitizePlainText('<p>5 < 6 and 7 > 3</p>')).toBe('5 < 6 and 7 > 3');
    expect(toPlainTextPreview('<p>I think 5 < 6 and more <b>bold</b></p>', 200)).toBe('I think 5 < 6 and more bold');
    expect(sanitizePlainText('<script>alert(1)</script>Mallory')).toBe('Mallory');
  });
});

describe('sanitizeMessageBody: a message keeps every word, as typed (#1873)', () => {
  // The admin web, admin Android, desktop console and MyTribe Android send a
  // message as typed plain text. Any `<` that does not open one of the twelve
  // formatting tags is a character the person typed, so it is kept as text
  // (escaped while parsing, never stripped).
  it('happy: keeps a word between angle brackets in a plain-text message', () => {
    expect(sanitizeMessageBody('write to Pawsome <pawsome@hanasamku.com> today')).toBe(
      'write to Pawsome <pawsome@hanasamku.com> today',
    );
    expect(sanitizeMessageBody('if a<x and c>d then go')).toBe('if a<x and c>d then go');
    expect(sanitizeMessageBody('the gate code is <1234> ok')).toBe('the gate code is <1234> ok');
  });

  it('happy: keeps formatting the editor wrote', () => {
    expect(sanitizeMessageBody('<p>Hi <strong>there</strong> <em>friend</em><br>next</p>')).toBe(
      '<p>Hi <strong>there</strong> <em>friend</em><br />next</p>',
    );
    expect(
      sanitizeMessageBody('<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com">site</a></p>'),
    ).toBe('<p><a href="https://example.com">site</a></p>');
    expect(sanitizeMessageBody('<ul><li><p>one</p></li></ul>')).toBe('<ul><li><p>one</p></li></ul>');
  });

  it('negative: text that looks like a tag outside the twelve is shown as typed, not stripped', () => {
    expect(sanitizeMessageBody('I use <script>alert(1)</script> tags')).toBe('I use <script>alert(1)</script> tags');
    expect(sanitizeMessageBody('<div onclick="evil()">hello</div>')).toBe('<div onclick="evil()">hello</div>');
    expect(sanitizeMessageBody('<img src=x onerror="evil()">caption')).toBe('<img src=x onerror="evil()">caption');
    expect(sanitizeMessageBody('<!-- note --> after')).toBe('<!-- note --> after');
  });

  it('negative: an allowed tag still loses every attribute but a safe href', () => {
    expect(sanitizeMessageBody('<b onclick="evil()">hi</b>')).toBe('<b>hi</b>');
    expect(sanitizeMessageBody('<a href="javascript:alert(1)">click</a>')).toBe('<a>click</a>');
    expect(sanitizeMessageBody('<a href="//evil.example/x">click</a>')).toBe('<a>click</a>');
  });

  it('error: the two write passes (callable, then appendMessage) give the same text as one', () => {
    // The portal editor sends typed signs as entities. The first pass decodes
    // them; the second pass must not then read the decoded text as a tag.
    const inputs = [
      '<p>x &lt;y and z&gt; w</p>',
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; typed</p>',
      '<p>5 &lt; 6 and <strong>bold</strong> &amp; more</p>',
      'write to Pawsome <pawsome@hanasamku.com> today',
    ];
    for (const input of inputs) {
      const once = sanitizeMessageBody(input);
      expect(sanitizeMessageBody(once)).toBe(once);
    }
    expect(sanitizeMessageBody(sanitizeMessageBody('<p>x &lt;y and z&gt; w</p>'))).toBe('<p>x <y and z> w</p>');
    expect(sanitizeMessageBody(sanitizeMessageBody('<p>&lt;script&gt;alert(1)&lt;/script&gt; typed</p>'))).toBe(
      '<p><script>alert(1)</script> typed</p>',
    );
  });

  it('messagePlainText and messagePreview keep the same words, with no tags', () => {
    expect(messagePlainText('<p>I use <script> tags and <b>bold</b></p>')).toBe('I use <script> tags and bold');
    expect(messagePlainText('write to Pawsome <pawsome@hanasamku.com> today')).toBe(
      'write to Pawsome <pawsome@hanasamku.com> today',
    );
    expect(messagePreview('<p>x <y and z> w</p>', 6)).toBe('x <y a');
    expect(messagePlainText('<p><br></p>')).toBe('');
  });
});

describe('sanitizeMessageBody: hostile bodies settle to one safe stored form', () => {
  // Exact stored output for each hostile body. Text that is not one of the
  // twelve formatting tags is kept as the characters typed (every client draws
  // it as text); an allowed tag keeps only a safe href.
  const table: [string, string][] = [
    ['<script>alert(1)</script>', '<script>alert(1)</script>'],
    ['<script', '<script'],
    ['x <script src=//e.x/a.js', 'x <script src=//e.x/a.js'],
    ['<img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>'],
    ['<img src=x onerror=alert(1)', '<img src=x onerror=alert(1)'],
    ['<svg onload=alert(1)>', '<svg onload=alert(1)>'],
    ['<svg><script>alert(1)</script></svg>', '<svg><script>alert(1)</script></svg>'],
    ['<!-- <img src=x onerror=alert(1)> -->', '<!-- <img src=x onerror=alert(1)> -->'],
    ['<![CDATA[<img src=x onerror=alert(1)>]]>', '<![CDATA[<img src=x onerror=alert(1)>]]>'],
    ['<iframe src="javascript:alert(1)"></iframe>', '<iframe src="javascript:alert(1)"></iframe>'],
    ['<<b>bold</b>', '<<b>bold</b>'],
    ['<<script>alert(1)//<</script>', '<<script>alert(1)//<</script>'],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
    ['<a href=" javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="java&#x73;cript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="javascript&colon;alert(1)">x</a>', '<a>x</a>'],
    ['<a href=javascript:alert(1)>x</a>', '<a>x</a>'],
    ['<a\thref="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href=`javascript:alert(1)`>x</a>', '<a href=`javascript:alert(1)`>x'],
    ['<b onclick=`alert(1)`>x</b>', '<b onclick=`alert(1)`>x'],
    ['<b title="a>b" onclick="alert(1)">x</b>', '<b title="a>b" onclick="alert(1)">x'],
    ["<a href='https://example.com' onmouseover='alert(1)'>x</a>", '<a href="https://example.com">x</a>'],
    ['<a href="https://example.com"\nonclick="alert(1)">x</a>', '<a href="https://example.com">x</a>'],
    ['<b\nonclick="alert(1)">x</b>', '<b>x</b>'],
    // An entity inside a link stays an entity: it can never close the href
    // and open a second attribute, or hide a scheme.
    [
      '<a href="https://example.com/&quot; onclick=&quot;alert(1)">x</a>',
      '<a href="https://example.com/&quot; onclick=&quot;alert(1)">x</a>',
    ],
    [
      '<a href="https://example.com/&amp;quot; onclick=&amp;quot;alert(1)">x</a>',
      '<a href="https://example.com/&amp;quot; onclick=&amp;quot;alert(1)">x</a>',
    ],
    ['<a href="java&amp;#x73;cript:alert(1)">x</a>', '<a href="java&amp;#x73;cript:alert(1)">x</a>'],
    ['<a href="https://example.com/?a=1&b=2">x</a>', '<a href="https://example.com/?a=1&amp;b=2">x</a>'],
    // Typed entities are read as the characters they stand for, and a tag
    // they spell goes through the same tag and link rules.
    ['&lt;script&gt;alert(1)&lt;/script&gt;', '<script>alert(1)</script>'],
    ['&amp;lt;img src=x onerror=alert(1)&amp;gt;', '<img src=x onerror=alert(1)>'],
    ['&amp;lt;a href=&amp;quot;javascript:alert(1)&amp;quot;&amp;gt;x&amp;lt;/a&amp;gt;', '<a>x</a>'],
    ['&amp;amp;lt;b onclick=&amp;amp;quot;x()&amp;amp;quot;&amp;amp;gt;hi&amp;amp;lt;/b&amp;amp;gt;', '<b>hi</b>'],
  ];

  it.each(table)('stores %j as %j', (input, expected) => {
    expect(sanitizeMessageBody(input)).toBe(expected);
  });

  it('a second pass changes nothing (the callable, then appendMessage)', () => {
    for (const [input] of table) {
      const once = sanitizeMessageBody(input);
      expect(sanitizeMessageBody(once)).toBe(once);
    }
  });

  it('every link a client reads as a link carries only a safe href', () => {
    // The clients read `<a` as a link only with quoted attributes, and every
    // other allowed tag only with none. So every such `<a ...>` in a stored
    // body must hold a single href whose value, once decoded, is not a script.
    const clientLink = /<a((?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*>/gi;
    const decodeOnce = (s: string) =>
      s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    for (const [input] of table) {
      for (const m of sanitizeMessageBody(input).matchAll(clientLink)) {
        const attrs = m[1] ?? '';
        expect(attrs).toMatch(/^ href="[^"]*"$/);
        const href = decodeOnce(/"([^"]*)"/.exec(attrs)?.[1] ?? '');
        expect(href).not.toMatch(/^\s*(javascript|data|vbscript):/i);
      }
    }
  });

  it('sad: a body that never settles is stored as nothing, so the send is refused', () => {
    expect(sanitizeMessageBody(`<p>&${'amp;'.repeat(12)}lt;b&gt;x</p>`)).toBe('');
  });
});
