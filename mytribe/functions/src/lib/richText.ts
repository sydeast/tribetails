import sanitizeHtml from 'sanitize-html';

/**
 * Allowlist for the rich-text subset MyTribe supports on kinfolk-authored
 * free text (messages, KinTale comments, booking notes). Deliberately small:
 * enough for a TipTap-style basic editor (S5), nothing that can carry script
 * or styling-based attacks. No `style`/`class` on any tag, no `img`/`iframe`.
 */
const ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'blockquote', 'a'];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  a: ['href'],
};

/**
 * Reverses the HTML-entity escaping sanitize-html applies to text content
 * (it must produce valid HTML, so a bare "&"/"<"/">" in ordinary prose gets
 * escaped even when there's no tag anywhere near it). Undoing that after
 * sanitizing is safe — not just cosmetic — because sanitize-html's parser
 * only ever emits a literal `<tag>` in its output for markup it genuinely
 * parsed as an element; text a user typed *as* entities (e.g. literally
 * typing "&lt;script&gt;") is treated as inert text throughout and
 * re-escaped on the way out, never converted into a live tag. So decoding
 * post-sanitize can restore "Bob & Sue" without ever resurrecting a tag
 * sanitize-html decided to strip. Order matters: decode `&amp;` last, or
 * "&amp;lt;" would wrongly become "<" instead of the literal "&lt;".
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * A `<` that is not the start of a whole tag is just a less-than sign.
 * sanitize-html's parser would otherwise take `<b and more words` (or `x <y`)
 * as an unterminated tag and drop it and everything after it, so the typed
 * text is lost before it is ever stored. This rewrites such a `<` as `&lt;`
 * so the parser keeps it as text (and decodeEntities hands the `<` back).
 *
 * A `<` stays as it is only when it opens a complete tag: `<` + `/`? + a
 * letter, then no `<` or `>` up to a closing `>`. For one of the allowed
 * formatting tags the shape must also be exactly what the editor writes
 * (attributes only as `name=value` pairs, a self-closing slash only on
 * `br`), so a sentence such as `a <b and more words>` is not read as a tag.
 * Every other complete tag is left for sanitize-html to strip, as before,
 * unless `otherTagsAreText` is set: a message body (sanitizeMessageBody) keeps
 * `<script>`, `<pawsome@hanasamku.com>` or `<side gate>` as the text typed.
 */
const ALLOWED_TAG_SET: ReadonlySet<string> = new Set(ALLOWED_TAGS);
const COMPLETE_TAG = /^<(\/?)([A-Za-z][A-Za-z0-9]*)([^<>]*)>/;
const NAMED_ATTRS = /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))*\s*$/;

function startsWholeTag(text: string, at: number, otherTagsAreText: boolean): boolean {
  const m = COMPLETE_TAG.exec(text.slice(at, at + 4096));
  if (!m) return false;
  const closing = m[1] === '/';
  const name = (m[2] ?? '').toLowerCase();
  const rest = m[3] ?? '';
  if (!ALLOWED_TAG_SET.has(name)) return !otherTagsAreText;
  if (closing) return rest.trim() === '';
  const selfClosed = rest.trimEnd().endsWith('/');
  const attrs = selfClosed ? rest.trimEnd().slice(0, -1) : rest;
  if (selfClosed && name !== 'br') return false;
  if (attrs.trim() === '') return true;
  return NAMED_ATTRS.test(attrs);
}

export function escapeStrayLessThan(text: string, otherTagsAreText = false): string {
  if (!text.includes('<')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    out += c === '<' && !startsWholeTag(text, i, otherTagsAreText) ? '&lt;' : c;
  }
  return out;
}

/**
 * Sanitizes a free-text field before it's persisted somewhere another user
 * will render it (messages, KinTale comments, booking notes). Today's
 * clients render this as plain text, so this is a no-op for ordinary
 * input — it only bites if someone submits real markup, which it reduces
 * to the safe subset above (disallowed tags are unwrapped, their text
 * content kept; `<script>`, `<style>`, and event-handler attributes are
 * dropped entirely).
 */
export function sanitizeRichText(body: string): string {
  return sanitizeRich(escapeStrayLessThan(body));
}
function sanitizeRich(escaped: string): string {
  const sanitized = sanitizeHtml(escaped, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
  });
  return decodeEntities(sanitized).trim();
}
/**
 * Sanitizes a conversation message body (#1873). Same formatting subset and
 * attribute rules as sanitizeRichText, but every `<` that does not open one of
 * the twelve formatting tags is a character someone typed and is kept as text,
 * never stripped with the words after it. The admin web, admin Android,
 * desktop console and MyTribe Android all send plain text, and the portal
 * editor sends typed signs as entities that the first of the two write passes
 * (the callable, then appendMessage) decodes, so stripping "tags" here would
 * drop words. Every client draws the stored body from a fixed tag list, so a
 * kept `<script>` is only ever shown as those characters.
 *
 * Idempotent on its own output, which the two write passes rely on.
 */
export function sanitizeMessageBody(body: string): string {
  return sanitizeRich(escapeStrayLessThan(body, true));
}
/** Plain text of a stored message body, with the same rule: every word typed stays. */
export function messagePlainText(body: string): string {
  const sanitized = sanitizeHtml(escapeStrayLessThan(body, true), { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(sanitized).trim();
}
/** messagePlainText, cut to maxLength, for the messages list and the new-message notice. */
export function messagePreview(body: string, maxLength: number): string {
  const plain = messagePlainText(body);
  return plain.length <= maxLength ? plain : plain.slice(0, maxLength);
}

/**
 * Strips ALL markup — for fields that are never allowed to carry even the
 * rich-text subset (guest names, previews, notification/SMS text). A guest
 * name of `<a href="evil.example">tap here</a>` must never render as a live
 * link anywhere it's shown.
 */
export function sanitizePlainText(text: string): string {
  const sanitized = sanitizeHtml(escapeStrayLessThan(text), { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(sanitized).trim();
}

/**
 * Plain-text projection of an already-sanitized rich-text body, for
 * previews/notifications that must not truncate mid-tag or carry markup
 * into an SMS/push payload. Safe to call on either raw or already-sanitized
 * input.
 */
export function toPlainTextPreview(richText: string, maxLength: number): string {
  const plain = sanitizePlainText(richText);
  return plain.length <= maxLength ? plain : plain.slice(0, maxLength);
}
