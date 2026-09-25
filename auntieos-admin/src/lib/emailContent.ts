/**
 * #953: the admin side of the visual email format.
 *
 * The editor holds a TipTap document; the template stores `content`, a small
 * HTML fragment the server's allowlist accepts (see the PR 2 sanitizer,
 * `mytribe/functions/src/lib/emailContent.ts`). These functions are the only
 * place in the admin that knows the stored shape:
 *
 *  - `fromEmailContent` turns stored content into editor HTML: each `{{name}}`
 *    in TEXT becomes a merge-field chip element. Attribute values (a `{{link}}`
 *    href) and button labels are left alone.
 *  - `toEmailContent` turns the editor's `getHTML()` back into stored content:
 *    allowed elements and attributes only, chips back to `{{name}}`, list items
 *    without their inner `<p>`, empty blocks dropped.
 *
 * Both run on DOMParser, so they work in the browser and in jsdom.
 */

export const MERGE_TOKEN_SOURCE = '\\{\\{\\s*([A-Za-z_][A-Za-z0-9_.]*)\\s*\\}\\}';
const SINGLE_TOKEN = new RegExp(`^${MERGE_TOKEN_SOURCE}$`);

/** The Cloudinary delivery path every email image must be served from. The server pins the cloud name. */
export const CLOUDINARY_IMAGE = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//;

/** The field name when `href` is exactly one merge token, else null. */
export function fieldNameOf(href: string): string | null {
  const m = SINGLE_TOKEN.exec(href.trim());
  return m ? (m[1] ?? null) : null;
}

/**
 * What a link may point at: https, mailto, or one merge token.
 *
 * #953 C3: a value that contains `{{` or `}}` at all is valid only when it IS
 * exactly one merge token -- never as part of a longer https/mailto string.
 * The server's sanitizer refuses `https://x.com/{{id}}` ("a link target must
 * be a web address or a single merge field, not both"), so the editor must
 * not offer that shape as valid either.
 */
export function isLinkTarget(href: string): boolean {
  const v = href.trim();
  if (v === '') return false;
  if (v.includes('{{') || v.includes('}}')) return fieldNameOf(v) !== null;
  return /^https:\/\/\S+$/i.test(v) || /^mailto:\S+$/i.test(v);
}

/**
 * Turns what the operator typed into a web target, or null when it cannot be
 * one. A bare domain gains `https://`. Plain `http://` is refused rather than
 * upgraded, because the server refuses it too and a silent rewrite could point
 * at a page that does not exist over https.
 *
 * #953 C3: same merge-token guard as `isLinkTarget`, first -- a value carrying
 * `{{`/`}}` is normalized only when it is exactly one token; typing
 * `tribetails.com/{{id}}` must come back null, not `https://tribetails.com/{{id}}`.
 */
export function normalizeWebTarget(raw: string, allowMailto: boolean): string | null {
  const v = raw.trim();
  if (v === '') return null;
  if (v.includes('{{') || v.includes('}}')) return fieldNameOf(v) !== null ? v : null;
  if (/^https:\/\/\S+$/i.test(v)) return v;
  if (/^http:\/\//i.test(v)) return null;
  if (allowMailto && /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(v)) return v;
  if (allowMailto && /^[^\s@/]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  if (/^[^\s/@:]+\.[^\s@]+$/.test(v)) return `https://${v}`;
  return null;
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

function parseFragment(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const SHOW_TEXT = 4;

/**
 * #953 Ruling C5(b): the field name a list's each-loop repeats over. The same
 * shape as a merge field's name, so `this.visits` or `booking.days` work too.
 */
export const EACH_BLOCK_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const EACH_OPEN = /^\s*\{\{#each\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}\s*$/;
const EACH_CLOSE = /^\s*\{\{\/each\s*\}\}\s*$/;
/**
 * A stored loop is `<ul>{{#each visits}}<li>…</li>{{/each}}</ul>`: the block
 * tags are bare text directly inside the list, which ProseMirror would wrap in
 * list items of their own. When a list is exactly that shape -- the open tag
 * first, the close tag last, only `<li>`s (and whitespace) between -- the tags
 * move onto the list as `data-each`, and `write` puts them back. Any other
 * placement is left as it is for the editor's round-trip check to catch.
 */
function liftEachBlocks(doc: Document): void {
  for (const list of Array.from(doc.body.querySelectorAll('ul, ol'))) {
    const kids = Array.from(list.childNodes).filter(
      (n) => !(n.nodeType === TEXT_NODE && (n as Text).data.trim() === ''),
    );
    const first = kids[0];
    const last = kids[kids.length - 1];
    if (kids.length < 2 || first?.nodeType !== TEXT_NODE || last?.nodeType !== TEXT_NODE) continue;
    const open = EACH_OPEN.exec((first as Text).data);
    if (!open || !EACH_CLOSE.test((last as Text).data)) continue;
    const items = kids.slice(1, -1);
    if (!items.every((n) => n.nodeType === ELEMENT_NODE && (n as Element).tagName.toLowerCase() === 'li')) continue;
    first.remove();
    last.remove();
    list.setAttribute('data-each', open[1] ?? '');
  }
}
export function fromEmailContent(content: string): string {
  const doc = parseFragment(content);
  liftEachBlocks(doc);
  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    // A button's label is a plain string attribute of the Button node, so its
    // tokens stay text; a chip inside it would be lost when the node parses.
    if (t.parentElement?.closest('a.button')) continue;
    const value = t.data;
    const matches = [...value.matchAll(new RegExp(MERGE_TOKEN_SOURCE, 'g'))];
    if (matches.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      frag.append(value.slice(last, m.index));
      const chip = doc.createElement('span');
      chip.setAttribute('data-merge-field', m[1] ?? '');
      frag.append(chip);
      last = (m.index ?? 0) + m[0].length;
    }
    frag.append(value.slice(last));
    t.replaceWith(frag);
  }
  return doc.body.innerHTML;
}

const isBlank = (html: string) => html.replace(/<br>/g, '').trim() === '';

function inner(el: Element): string {
  return Array.from(el.childNodes).map(write).join('');
}

/**
 * A TipTap list item is `<li><p>…</p></li>`; email wants `<li>…</li>`. Two
 * paragraphs join with `<br>`. Non-`<p>` children (bare text, a nested list)
 * pass through `write` untouched, so a loop's bare `{{#each …}}` text node
 * inside a `<li>` (or directly inside a `<ul>`/`<ol>`, via `inner`) is never
 * stripped -- Task 3/C5 depends on lists carrying more than just `<li>`.
 */
function listItem(el: Element): string {
  let out = '';
  let prevWasText = false;
  for (const child of Array.from(el.childNodes)) {
    const isP = child.nodeType === ELEMENT_NODE && (child as Element).tagName.toLowerCase() === 'p';
    const html = isP ? inner(child as Element) : write(child);
    if (html === '') continue;
    if (isP && prevWasText) out += '<br>';
    out += html;
    prevWasText = isP;
  }
  return out;
}

function write(node: ChildNode): string {
  if (node.nodeType === TEXT_NODE) return escapeText((node as Text).data);
  if (node.nodeType !== ELEMENT_NODE) return '';
  const el = node as Element;
  const field = el.getAttribute('data-merge-field');
  if (field !== null) return `{{${field}}}`;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'br':
      return '<br>';
    case 'img': {
      const src = el.getAttribute('src') ?? '';
      return src === '' ? '' : `<img src="${escapeAttr(src)}" alt="${escapeAttr(el.getAttribute('alt') ?? '')}">`;
    }
    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const body = inner(el);
      if (href === '' || body === '') return body;
      const cls = el.classList.contains('button') ? ' class="button"' : '';
      return `<a href="${escapeAttr(href)}"${cls}>${body}</a>`;
    }
    case 'li': {
      const body = listItem(el);
      return isBlank(body) ? '' : `<li>${body}</li>`;
    }
    case 'strong':
    case 'em': {
      const body = inner(el);
      return body === '' ? '' : `<${tag}>${body}</${tag}>`;
    }
    case 'ul':
    case 'ol': {
      const body = inner(el);
      if (isBlank(body)) return '';
      // #953 C5(b): the editor's `data-each` goes back to the stored block tags.
      const each = el.getAttribute('data-each');
      const loop = each !== null && EACH_BLOCK_NAME.test(each);
      return loop ? `<${tag}>{{#each ${each}}}${body}{{/each}}</${tag}>` : `<${tag}>${body}</${tag}>`;
    }
    case 'p':
    case 'h2':
    case 'h3':
    case 'blockquote': {
      const body = inner(el);
      return isBlank(body) ? '' : `<${tag}>${body}</${tag}>`;
    }
    default:
      return inner(el);
  }
}

export function toEmailContent(editorHtml: string): string {
  return inner(parseFragment(editorHtml).body);
}

/**
 * An old template's plain-text body as content, for the "couldn't read the old
 * layout" path: blank lines separate paragraphs, single newlines become `<br>`.
 */
export function bodyToContent(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${block.split('\n').map((line) => escapeText(line.trim())).join('<br>')}</p>`)
    .join('');
}

/** Mirrors the server's "content must hold something" rule: any text, or an image. */
export function hasTextBlock(content: string): boolean {
  const body = parseFragment(content).body;
  return (body.textContent ?? '').trim() !== '' || body.querySelector('img') !== null;
}

/** Every merge field named anywhere in `parts`, once each, sorted. */
export function tokensIn(...parts: string[]): string[] {
  const names = new Set<string>();
  for (const part of parts) {
    for (const m of part.matchAll(new RegExp(MERGE_TOKEN_SOURCE, 'g'))) if (m[1]) names.add(m[1]);
  }
  return [...names].sort();
}
