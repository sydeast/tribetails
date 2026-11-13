import { describe, it, expect } from 'vitest';
import {
  sanitizeRichText,
  sanitizePlainText,
  toPlainTextPreview,
  sanitizeMessageBody,
  messagePlainText,
  messagePreview,
  plainTextToMessageBody,
} from '../src/lib/richText';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('sanitizeMessageBody: a message keeps every word, stored as safe HTML (#1873)', () => {
  // The stored body is HTML: every `<`, `>` and `&` that is text is an entity,
  // so a renderer that inserts it as HTML shows it as text, and the clients
  // that draw it from a fixed tag list decode it once.
  it('happy: keeps a word between angle brackets, as entities', () => {
    expect(sanitizeMessageBody('write to Pawsome <pawsome@hanasamku.com> today')).toBe(
      'write to Pawsome &lt;pawsome@hanasamku.com&gt; today',
    );
    expect(sanitizeMessageBody('if a<x and c>d then go')).toBe('if a&lt;x and c&gt;d then go');
    expect(sanitizeMessageBody('the gate code is <1234> ok')).toBe('the gate code is &lt;1234&gt; ok');
  });
  it('happy: keeps formatting the editor wrote', () => {
    expect(sanitizeMessageBody('<p>Hi <strong>there</strong> <em>friend</em><br>next</p>')).toBe(
      '<p>Hi <strong>there</strong> <em>friend</em><br />next</p>',
    );
    expect(
      sanitizeMessageBody('<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com">site</a></p>'),
    ).toBe('<p><a href="https://example.com">site</a></p>');
  });
  it('negative: text that looks like a tag outside the twelve is kept as escaped text', () => {
    expect(sanitizeMessageBody('I use <script>alert(1)</script> tags')).toBe('I use &lt;script&gt;alert(1)&lt;/script&gt; tags');
    expect(sanitizeMessageBody('<div onclick="evil()">hello</div>')).toBe('&lt;div onclick="evil()"&gt;hello&lt;/div&gt;');
    expect(sanitizeMessageBody('<!-- note --> after')).toBe('&lt;!-- note --&gt; after');
  });
  it('negative: an allowed tag still loses every attribute but a safe href', () => {
    expect(sanitizeMessageBody('<b onclick="evil()">hi</b>')).toBe('<b>hi</b>');
    expect(sanitizeMessageBody('<a href="javascript:alert(1)">click</a>')).toBe('<a>click</a>');
    expect(sanitizeMessageBody('<a href="//evil.example/x">click</a>')).toBe('<a>click</a>');
  });
  it('messagePlainText and messagePreview decode once, to the text as typed', () => {
    expect(messagePlainText('<p>I use &lt;script&gt; tags and <b>bold</b></p>')).toBe('I use <script> tags and bold');
    expect(messagePlainText('the entity &amp;lt; and Tom &amp;amp; Jerry')).toBe('the entity &lt; and Tom &amp; Jerry');
    expect(messagePreview('<p>x &lt;y and z&gt; w</p>', 6)).toBe('x <y a');
    expect(messagePlainText('<p><br></p>')).toBe('');
  });
  it('a body from an older plain-text client (not escaped) keeps every word', () => {
    expect(sanitizeMessageBody('use the <side gate> and 2 < 3')).toBe('use the &lt;side gate&gt; and 2 &lt; 3');
    expect(messagePlainText(sanitizeMessageBody('use the <side gate> and 2 < 3'))).toBe('use the <side gate> and 2 < 3');
  });
});
/**
 * Shared with the admin web and portal web suites, which draw every stored
 * string and insert it as HTML (the older portal did) in jsdom.
 */
interface Fixtures {
  hostile: { input: string; stored: string }[];
  plainText: { typed: string; sent: string; stored: string }[];
  editor: { html: string; typed: string; stored: string }[];
}
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'messageBodies.json'), 'utf8')) as Fixtures;
const allStored = [
  ...fixtures.hostile.map((f) => f.stored),
  ...fixtures.plainText.map((f) => f.stored),
  ...fixtures.editor.map((f) => f.stored),
];
describe('sanitizeMessageBody: the stored form of every fixture', () => {
  it.each(fixtures.hostile.map((f) => [f.input, f.stored]))('stores %j as %j', (input, stored) => {
    expect(sanitizeMessageBody(input)).toBe(stored);
  });
  it.each(fixtures.plainText.map((f) => [f.typed, f.sent, f.stored]))(
    'a plain-text sender: %j is sent as %j and stored as %j, and reads back as typed',
    (typed, sent, stored) => {
      expect(plainTextToMessageBody(typed)).toBe(sent);
      expect(sanitizeMessageBody(sent)).toBe(stored);
      expect(messagePlainText(stored)).toBe(typed);
    },
  );
  it.each(fixtures.editor.map((f) => [f.html, f.stored, f.typed]))(
    'the portal editor: %j is stored as %j and reads back as %j',
    (html, stored, typed) => {
      expect(sanitizeMessageBody(html)).toBe(stored);
      expect(messagePlainText(stored)).toBe(typed);
    },
  );
  it('a second pass changes nothing (the callable, then appendMessage)', () => {
    for (const stored of allStored) expect(sanitizeMessageBody(stored)).toBe(stored);
  });
  it('every < and > in a stored body belongs to an allowed tag, and every & starts an entity', () => {
    const allowedTag = /<\/?(?:b|strong|i|em|u|p|br|ul|ol|li|blockquote|a)(?: href="[^"<>]*")?(?: \/)?>/g;
    for (const stored of allStored) {
      const text = stored.replace(allowedTag, '');
      expect(text).not.toMatch(/[<>]/);
      expect(text).not.toMatch(/&(?!(?:amp|lt|gt|quot|#39);)/);
    }
  });
});
