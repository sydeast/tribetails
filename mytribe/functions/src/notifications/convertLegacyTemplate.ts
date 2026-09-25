import { parseDocument, DomUtils } from 'htmlparser2';
import render from 'dom-serializer';
import type { Element } from 'domhandler';
import { sanitizeEmailContent } from '../lib/emailContent';

/**
 * #953: an old-format template (the seeds' shared frame, or a stored copy of
 * one) as headline + content. Never guesses: without the frame's header and
 * content box it answers `unreadable`, and the editor starts from the plain
 * text body instead.
 */
export type ConvertResult = { ok: true; headline: string; content: string } | { ok: false; reason: 'unreadable' };

const hasClass = (el: Element, c: string) => (el.attribs['class'] ?? '').split(/\s+/).includes(c);

// Tags whose surrounding whitespace is layout noise (the seeds' indentation),
// never meaningful content. A run of whitespace between two INLINE tags
// (`<strong>a</strong> <em>b</em>`) is a real space and must survive.
const BLOCK_ADJACENT_TAGS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote']);
// A blockquote body that already starts with a block element (typically a
// <p>, from an alert-box the old template hand-wrote one into) is left
// alone; only a bare-text/inline body gets a <p> added around it.
const STARTS_WITH_BLOCK_RE = /^<(p|h2|h3|ul|ol|blockquote)\b/i;

function wrapBareBlockquoteBodies(html: string): string {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (whole: string, inner: string) =>
    STARTS_WITH_BLOCK_RE.test(inner.trim()) ? whole : `<blockquote><p>${inner}</p></blockquote>`,
  );
}

function collapseBlockAdjacentWhitespace(html: string): string {
  // The tag on the right of the gap is a lookahead, not part of the match,
  // so it isn't consumed and stays available as the LEFT tag of the next
  // gap. A consuming match here (`(tag)(ws)(tag)`) can only ever collapse
  // every other gap in a chain like `<p>\n  <strong>x</strong>\n</p>` --
  // once `<p>` is consumed as the right side of the first gap, it can't
  // also open the next one, leaking whitespace around it.
  return html.replace(
    /(<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>)(\s+)(?=<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>)/g,
    (whole: string, tagA: string, nameA: string, _ws: string, nameB: string) =>
      BLOCK_ADJACENT_TAGS.has(nameA.toLowerCase()) || BLOCK_ADJACENT_TAGS.has(nameB.toLowerCase()) ? tagA : whole,
  );
}

export function convertLegacyTemplate(html: string, cloudName: string): ConvertResult {
  const doc = parseDocument(html);
  const header = DomUtils.findOne((el) => el.name === 'div' && hasClass(el, 'header'), doc.children, true);
  const box = DomUtils.findOne((el) => el.name === 'div' && hasClass(el, 'content'), doc.children, true);
  const h2 = header && DomUtils.findOne((el) => el.name === 'h2', header.children, true);
  const headline = h2 ? DomUtils.textContent(h2).trim() : '';
  if (!box || !headline) return { ok: false, reason: 'unreadable' };

  for (const el of DomUtils.findAll((e) => e.name === 'div' && hasClass(e, 'alert-box'), box.children)) {
    el.name = 'blockquote';
    el.attribs = {};
  }
  // No manual pre-wrap of bare inline children here: sanitizeEmailContent's
  // own wrapBareTopLevelRuns already wraps a whole contiguous run of bare
  // text/inline content (the reset seed's button, or `Hi <strong>x</strong>,
  // welcome`) in a single <p>. Pre-wrapping each inline child here split that
  // run into one <p> per child instead of one <p> per run.

  const { content, issues } = sanitizeEmailContent(render(box.children, { encodeEntities: false }), cloudName);
  const blocking = issues.filter((i) => !i.startsWith('Removed an image'));
  if (blocking.length) return { ok: false, reason: 'unreadable' };
  // Alert boxes held inline text directly; give it a paragraph inside the
  // callout -- but only when it doesn't already have one (an alert-box body
  // that was already a <p>, just indented on its own line, must not become
  // <p><p>...</p></p>).
  const tidy = collapseBlockAdjacentWhitespace(wrapBareBlockquoteBodies(content)).trim();
  return { ok: true, headline, content: tidy };
}
