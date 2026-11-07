/**
 * Parser for the rich-text subset the server keeps on kinfolk-authored free
 * text (`mytribe/functions/src/lib/richText.ts` `sanitizeRichText`: b, strong,
 * i, em, u, p, br, ul, ol, li, blockquote, a[href] with http/https/mailto).
 *
 * The output is a plain node tree, never an HTML string. The screen turns the
 * tree into React elements from a fixed tag list, so nothing a message carries
 * can become a live element, attribute or handler: unknown tags are unwrapped
 * (their text stays), script-like tags are dropped with their content, every
 * attribute but `href` is dropped, and an `href` outside the three schemes is
 * dropped. This is the second gate behind the server sanitizer, and it holds
 * on its own for a body stored before the sanitizer existed.
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
/** Elements whose entire content is dropped, not unwrapped. */
const DROP_CONTENT_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
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

/** Index of the `>` closing the tag that opens at `openIdx`, skipping quoted attribute values. */
function findTagEnd(html: string, openIdx: number): number {
  let quote: string | null = null;
  for (let i = openIdx + 1; i < html.length; i++) {
    const c = html[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function extractHref(tagBody: string): string | undefined {
  const m = /href\s*=\s*"([^"]*)"/i.exec(tagBody) ?? /href\s*=\s*'([^']*)'/i.exec(tagBody);
  if (!m) return undefined;
  const href = decodeEntities(m[1] ?? '').trim();
  return ALLOWED_HREF.test(href) ? href : undefined;
}

function parseTag(inner: string): Token {
  const trimmed = inner.trim();
  if (trimmed.startsWith('/')) return { t: 'close', tag: trimmed.slice(1).trim().toLowerCase() };
  const selfClosing = trimmed.endsWith('/');
  const body = selfClosing ? trimmed.slice(0, -1).trim() : trimmed;
  const m = /^[^\s/]+/.exec(body);
  const name = (m ? m[0] : '').toLowerCase();
  if (name === 'br' || selfClosing) return { t: 'void', tag: name };
  return { t: 'open', tag: name, href: name === 'a' ? extractHref(body) : undefined };
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < html.length) {
    if (html.charAt(i) === '<') {
      const end = findTagEnd(html, i);
      if (end === -1) {
        tokens.push({ t: 'text', raw: html.slice(i) });
        break;
      }
      const inner = html.slice(i + 1, end);
      // A comment or declaration carries nothing to show.
      if (!inner.startsWith('!') && !inner.startsWith('?')) tokens.push(parseTag(inner));
      i = end + 1;
    } else {
      const next = html.indexOf('<', i);
      const stop = next === -1 ? html.length : next;
      tokens.push({ t: 'text', raw: html.slice(i, stop) });
      i = stop;
    }
  }
  return tokens;
}

/** True when the body carries at least one tag. A plain-text reply has none and keeps its own line breaks. */
export function hasMarkup(body: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(body);
}

export function parseRichText(html: string): RichNode[] {
  const root: RichNode[] = [];
  const stack: { tag: string; children: RichNode[] }[] = [];
  let dropDepth = 0;
  let dropTag = '';
  const current = (): RichNode[] => (stack[stack.length - 1]?.children ?? root);

  for (const tok of tokenize(html)) {
    if (dropDepth > 0) {
      if (tok.t === 'open' && tok.tag === dropTag) dropDepth++;
      else if (tok.t === 'close' && tok.tag === dropTag) dropDepth--;
      continue;
    }
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
        if (DROP_CONTENT_TAGS.has(tok.tag)) {
          dropDepth = 1;
          dropTag = tok.tag;
          break;
        }
        const parent = current();
        if (ALLOWED_TAGS.has(tok.tag)) {
          const children: RichNode[] = [];
          const el: RichElement = { kind: 'el', tag: tok.tag as RichTag, children };
          if (tok.tag === 'a' && tok.href) el.href = tok.href;
          parent.push(el);
          stack.push({ tag: tok.tag, children });
        } else {
          // Unknown tag: unwrap. Its text lands in the parent's list.
          stack.push({ tag: tok.tag, children: parent });
        }
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
