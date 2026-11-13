/**
 * Parser for the rich-text subset the server keeps on kinfolk-authored free
 * text (`functions/src/lib/richText.ts` `sanitizeRichText`: b, strong,
 * i, em, u, p, br, ul, ol, li, blockquote, a[href] with http/https/mailto).
 *
 * The output is a plain node tree, never an HTML string. The screen turns the
 * tree into React elements from a fixed tag list, so nothing a message carries
 * can become a live element, attribute or handler: every attribute but `href`
 * is dropped and an `href` outside the three schemes is dropped. Only the twelve tags above are read as tags: any other `<` is text
 * and is drawn as typed (a `<` is a tag only when it opens a whole allowed
 * tag; see `readTag`). This is the second gate behind the server sanitizer.
 */

export type RichTag = 'b' | 'strong' | 'i' | 'em' | 'u' | 'p' | 'br' | 'ul' | 'ol' | 'li' | 'blockquote' | 'a';

export interface RichText {
  kind: 'text';
  text: string;
}
export interface RichElement {
  kind: 'el';
  tag: RichTag;
  href?: string;
  children: RichNode[];
}
export type RichNode = RichText | RichElement;

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'blockquote', 'a',
]);

const ALLOWED_HREF = /^(https?:\/\/|mailto:)/i;

/** Same order as the server's `decodeEntities`: `&amp;` last, so `&amp;lt;` stays the literal text `&lt;`. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

type Token =
  | { t: 'open'; tag: string; href?: string | undefined }
  | { t: 'close'; tag: string }
  | { t: 'void'; tag: string }
  | { t: 'text'; raw: string };

const QUOTED_ATTRS = /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'))*$/;
const TAG_AT = /^<(\/?)([A-Za-z][A-Za-z0-9]*)([^<>]*)>/;

/**
 * Reads the tag that starts at `openIdx`, or returns null when that `<` is
 * just a less-than sign. A tag is `<` or `</`, one of the allowed tag names,
 * and a closing `>` with no other `<` or `>` in between. The server never
 * stores any other element and never keeps an attribute except a quoted one
 * on `a`, so anything else (`5 < 6`, `a <b and more words`, `<script>`) is
 * text and is drawn exactly as typed. Reading a `<` as the start of a tag
 * and cutting to the next `>` is what dropped words from a message (#1873).
 */
function readTag(html: string, openIdx: number): { end: number; token: Token } | null {
  const m = TAG_AT.exec(html.slice(openIdx, openIdx + 4096));
  if (!m) return null;
  const closing = m[1] === '/';
  const name = (m[2] ?? '').toLowerCase();
  const rest = m[3] ?? '';
  if (!ALLOWED_TAGS.has(name)) return null;
  const end = openIdx + m[0].length - 1;
  if (closing) return rest.trim() === '' ? { end, token: { t: 'close', tag: name } } : null;
  const selfClosing = rest.trimEnd().endsWith('/');
  const attrs = selfClosing ? rest.trimEnd().slice(0, -1) : rest;
  if (selfClosing && name !== 'br') return null;
  if (attrs.trim() !== '' && !(name === 'a' && QUOTED_ATTRS.test(attrs.trimEnd()))) return null;
  if (name === 'br') return { end, token: { t: 'void', tag: 'br' } };
  return { end, token: { t: 'open', tag: name, href: name === 'a' ? extractHref(attrs) : undefined } };
}

function extractHref(tagBody: string): string | undefined {
  const m = /href\s*=\s*"([^"]*)"/i.exec(tagBody) ?? /href\s*=\s*'([^']*)'/i.exec(tagBody);
  if (!m) return undefined;
  const href = decodeEntities(m[1] ?? '').trim();
  return ALLOWED_HREF.test(href) ? href : undefined;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let textStart = 0;
  let i = 0;
  while (i < html.length) {
    if (html.charAt(i) === '<') {
      const tag = readTag(html, i);
      if (tag) {
        if (i > textStart) tokens.push({ t: 'text', raw: html.slice(textStart, i) });
        tokens.push(tag.token);
        i = tag.end + 1;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  if (textStart < html.length) tokens.push({ t: 'text', raw: html.slice(textStart) });
  return tokens;
}

/** True when the body carries at least one real tag. A plain-text reply has none and keeps its own line breaks. */
export function hasMarkup(body: string): boolean {
  for (let i = body.indexOf('<'); i !== -1; i = body.indexOf('<', i + 1)) {
    if (readTag(body, i)) return true;
  }
  return false;
}

export function parseRichText(html: string): RichNode[] {
  const root: RichNode[] = [];
  const stack: { tag: string; children: RichNode[] }[] = [];
  const current = (): RichNode[] => (stack[stack.length - 1]?.children ?? root);

  for (const tok of tokenize(html)) {
    switch (tok.t) {
      case 'text': {
        const text = decodeEntities(tok.raw);
        if (text !== '') current().push({ kind: 'text', text });
        break;
      }
      case 'void':
        if (tok.tag === 'br') current().push({ kind: 'el', tag: 'br', children: [] });
        break;
      case 'open': {
        const children: RichNode[] = [];
        const el: RichElement = { kind: 'el', tag: tok.tag as RichTag, children };
        if (tok.tag === 'a' && tok.href) el.href = tok.href;
        current().push(el);
        stack.push({ tag: tok.tag, children });
        break;
      }
      case 'close': {
        let idx = -1;
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k]?.tag === tok.tag) {
            idx = k;
            break;
          }
        }
        if (idx >= 0) stack.length = idx;
        break;
      }
    }
  }
  return root;
}
