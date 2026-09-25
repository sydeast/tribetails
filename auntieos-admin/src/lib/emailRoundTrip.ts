import { Editor } from '@tiptap/core';
import { emailEditorExtensions } from '../components/emailEditor/extensions';
import { fromEmailContent, toEmailContent } from './emailContent';

/**
 * #953 Ruling C5(a): the safety net under the visual editor.
 *
 * The editor can only hold what its schema knows. Stored content it cannot
 * reproduce (a Handlebars block the editor would wrap in list items of its own,
 * say) would be rewritten the moment the operator saves. So before the screen
 * lets the body be edited, it loads the stored content into a headless editor
 * with the same extensions, writes it back, and compares the two.
 *
 * The comparison is on the DOM, not the raw strings: the editor writes a
 * button's `href` before its `class` and drops the whitespace a converter left
 * between tags, and neither changes the email. Comparing raw strings would lock
 * seven seeds for no reason.
 *
 * Kept out of `EmailContentEditor.tsx` on purpose: the screen tests replace
 * that module with a textarea, and this check must still run there. Kept out
 * of `emailContent.ts` too, because `extensions.ts` imports from it.
 */
export function editorCanRoundTrip(content: string): boolean {
  const editor = new Editor({ extensions: emailEditorExtensions(), content: fromEmailContent(content) });
  try {
    return canonicalContent(toEmailContent(editor.getHTML())) === canonicalContent(content);
  } finally {
    editor.destroy();
  }
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Elements whose direct text children are layout whitespace, not words: the
 * fragment root, the lists and the callout. A text run directly inside one of
 * them is trimmed (a loop's `{{#each visits}}` keeps its words and loses the
 * newline and indent after it), and one that trims to nothing is dropped.
 */
const CONTAINERS = new Set(['body', 'ul', 'ol', 'blockquote']);

function canonicalNode(node: ChildNode, parentTag: string): string {
  if (node.nodeType === TEXT_NODE) {
    let text = (node as Text).data.replace(/\s+/g, ' ');
    if (CONTAINERS.has(parentTag)) text = text.trim();
    return text === '' ? '' : `#text(${text})`;
  }
  if (node.nodeType !== ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const attrs = Array.from(el.attributes)
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort()
    .join(' ');
  return `<${tag}${attrs ? ` ${attrs}` : ''}>${canonicalChildren(el, tag)}</${tag}>`;
}

function canonicalChildren(el: Element, tag: string): string {
  // Adjacent text nodes are one run of text, however the parser split them.
  el.normalize();
  return Array.from(el.childNodes)
    .map((child) => canonicalNode(child, tag))
    .join('');
}

/**
 * Stored content as a structure string: element names, attributes sorted by
 * name, text with runs of whitespace collapsed, layout whitespace between
 * blocks dropped. Two fragments that render the same email compare equal.
 */
export function canonicalContent(content: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${content}</body></html>`, 'text/html');
  return canonicalChildren(doc.body, 'body');
}

const EACH_OPENER = /\{\{~?\s*#each\b/g;
const EACH_CLOSER = /\{\{~?\s*\/each\b/g;

function count(re: RegExp, s: string): number {
  return (s.match(re) ?? []).length;
}

/**
 * #953: the last check before a visual save. The editor keeps a repeating
 * list whole, but if the edited content ever carries a different number of
 * `{{#each …}}` openers or `{{/each}}` closers than the stored content, a list
 * was lost, split or closed early. That changes who gets which line, so the
 * save is refused rather than guessed at.
 */
export const LOOP_CHANGED_ERROR =
  'This change would remove or split a repeating list ({{#each}}). Undo it, or edit the list items only.';

export function loopGuardError(stored: string, edited: string): string | null {
  if (count(EACH_OPENER, stored) !== count(EACH_OPENER, edited)) return LOOP_CHANGED_ERROR;
  if (count(EACH_CLOSER, stored) !== count(EACH_CLOSER, edited)) return LOOP_CHANGED_ERROR;
  return null;
}
