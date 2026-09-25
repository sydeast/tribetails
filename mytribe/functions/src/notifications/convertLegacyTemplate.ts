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
  // A bare inline element directly in the box (the reset seed's button) gets its own paragraph.
  box.children = box.children.map((child) => {
    if (child.type === 'tag' && ['a', 'strong', 'em', 'span'].includes((child as Element).name)) {
      const p = parseDocument('<p></p>').children[0] as Element;
      p.children = [child];
      child.parent = p;
      return p;
    }
    return child;
  });

  const { content, issues } = sanitizeEmailContent(render(box.children, { encodeEntities: false }), cloudName);
  const blocking = issues.filter((i) => !i.startsWith('Removed an image'));
  if (blocking.length) return { ok: false, reason: 'unreadable' };
  // Alert boxes held inline text directly; give it a paragraph inside the callout.
  const tidy = content
    .replace(/<blockquote>(?!<p>)([\s\S]*?)<\/blockquote>/g, '<blockquote><p>$1</p></blockquote>')
    .replace(/>\s+</g, '><')
    .trim();
  return { ok: true, headline, content: tidy };
}
