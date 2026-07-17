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
 * Sanitizes a free-text field before it's persisted somewhere another user
 * will render it (messages, KinTale comments, booking notes). Today's
 * clients render this as plain text, so this is a no-op for ordinary
 * input — it only bites if someone submits real markup, which it reduces
 * to the safe subset above (disallowed tags are unwrapped, their text
 * content kept; `<script>`, `<style>`, and event-handler attributes are
 * dropped entirely).
 */
export function sanitizeRichText(body: string): string {
  const sanitized = sanitizeHtml(body, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
  });
  return decodeEntities(sanitized).trim();
}

/**
 * Strips ALL markup — for fields that are never allowed to carry even the
 * rich-text subset (guest names, previews, notification/SMS text). A guest
 * name of `<a href="evil.example">tap here</a>` must never render as a live
 * link anywhere it's shown.
 */
export function sanitizePlainText(text: string): string {
  const sanitized = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
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
