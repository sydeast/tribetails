// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  bodyToContent,
  fieldNameOf,
  fromEmailContent,
  hasTextBlock,
  isLinkTarget,
  normalizeWebTarget,
  toEmailContent,
  tokensIn,
} from './emailContent';

describe('toEmailContent (editor HTML -> stored content)', () => {
  it('writes only the allowed elements and attributes, chips as tokens, list items without inner paragraphs', () => {
    const editorHtml =
      '<h2>T</h2><p>Hi <span data-merge-field="displayName" class="merge-chip" contenteditable="false">{{displayName}}</span></p>' +
      '<p><a href="{{link}}" class="button">Reset</a></p>' +
      '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://x.com/a?b=1&amp;c=2">x</a></p>' +
      '<ul><li><p>a</p></li><li><p></p></li></ul><ol><li><p>one</p><p>two</p></li></ol>' +
      '<blockquote><p>c</p></blockquote>' +
      '<p><img src="https://res.cloudinary.com/t/image/upload/a.png" alt="pup"></p><p><br></p><p></p>';
    expect(toEmailContent(editorHtml)).toBe(
      '<h2>T</h2><p>Hi {{displayName}}</p><p><a href="{{link}}" class="button">Reset</a></p>' +
        '<p><a href="https://x.com/a?b=1&amp;c=2">x</a></p><ul><li>a</li></ul><ol><li>one<br>two</li></ol>' +
        '<blockquote><p>c</p></blockquote><p><img src="https://res.cloudinary.com/t/image/upload/a.png" alt="pup"></p>',
    );
  });

  it('keeps nested marks and escapes text', () => {
    expect(toEmailContent('<p><strong><em>t</em></strong> a &lt; b &amp; c</p>')).toBe('<p><strong><em>t</em></strong> a &lt; b &amp; c</p>');
  });

  it('keeps the text of any element it does not allow', () => {
    expect(toEmailContent('<p><span style="color:red">red</span> <u>u</u></p>')).toBe('<p>red u</p>');
  });
});

describe('fromEmailContent (stored content -> editor HTML)', () => {
  it('turns text tokens into chips, and leaves hrefs and button labels alone', () => {
    expect(
      fromEmailContent(
        '<p>Hi {{displayName}}, {{ link }}</p><p><a href="{{link}}" class="button">Hi {{displayName}}</a></p><p><a href="{{link}}">go</a></p>',
      ),
    ).toBe(
      '<p>Hi <span data-merge-field="displayName"></span>, <span data-merge-field="link"></span></p>' +
        '<p><a href="{{link}}" class="button">Hi {{displayName}}</a></p><p><a href="{{link}}">go</a></p>',
    );
  });
});

describe('bodyToContent (old plain-text body -> paragraphs)', () => {
  it('splits on blank lines, keeps single line breaks, escapes, and keeps tokens as text', () => {
    expect(bodyToContent('Hi {{displayName}},\n\nClick {{link}}\nThanks & bye\r\n\r\n\n')).toBe(
      '<p>Hi {{displayName}},</p><p>Click {{link}}<br>Thanks &amp; bye</p>',
    );
  });
});

describe('targets and tokens', () => {
  it('fieldNameOf reads exactly one whole token', () => {
    expect(fieldNameOf('{{link}}')).toBe('link');
    expect(fieldNameOf(' {{ nextVisit.date }} ')).toBe('nextVisit.date');
    expect(fieldNameOf('https://x.com/{{id}}')).toBeNull();
  });

  it('isLinkTarget allows https, mailto and one token, and nothing else', () => {
    expect(isLinkTarget('https://tribetails.com')).toBe(true);
    expect(isLinkTarget('mailto:auntie@tribetails.com')).toBe(true);
    expect(isLinkTarget('{{link}}')).toBe(true);
    expect(isLinkTarget('http://tribetails.com')).toBe(false);
    expect(isLinkTarget('javascript:alert(1)')).toBe(false);
    expect(isLinkTarget('https://x.com/{{id}}')).toBe(false);
  });

  it('normalizeWebTarget adds https to a bare domain, refuses http, and takes email only where allowed', () => {
    expect(normalizeWebTarget('tribetails.com/help', false)).toBe('https://tribetails.com/help');
    expect(normalizeWebTarget('https://tribetails.com', false)).toBe('https://tribetails.com');
    expect(normalizeWebTarget('http://tribetails.com', false)).toBeNull();
    expect(normalizeWebTarget('auntie@tribetails.com', true)).toBe('mailto:auntie@tribetails.com');
    expect(normalizeWebTarget('auntie@tribetails.com', false)).toBeNull();
    expect(normalizeWebTarget('   ', true)).toBeNull();
  });

  it('normalizeWebTarget refuses a web address with a merge token mixed in (#953 C3)', () => {
    expect(normalizeWebTarget('tribetails.com/{{id}}', false)).toBeNull();
  });

  it('hasTextBlock is true for text or an image, false for blank paragraphs', () => {
    expect(hasTextBlock('<p> </p><p><br></p>')).toBe(false);
    expect(hasTextBlock('<p>{{x}}</p>')).toBe(true);
    expect(hasTextBlock('<p><img src="https://res.cloudinary.com/t/image/upload/a.png" alt=""></p>')).toBe(true);
  });

  it('tokensIn lists each field once, sorted', () => {
    expect(tokensIn('Hi {{b}}', '<a href="{{a}}">{{b}}</a>', '')).toEqual(['a', 'b']);
  });
});
