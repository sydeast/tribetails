import { Extension, Node, mergeAttributes, type Editor, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { CLOUDINARY_IMAGE, EACH_BLOCK_NAME, isLinkTarget } from '../../lib/emailContent';

/**
 * #953: the TipTap schema of the visual email editor. It can only express what
 * the server's content allowlist accepts: paragraphs, headings 2 and 3, lists,
 * bold, italic, links, the Callout (blockquote), and three nodes of our own.
 * Pasted markup the schema has no place for is dropped by the parse itself,
 * before `toEmailContent` ever sees it. Stored content the schema cannot hold
 * exactly (a Handlebars block other than a list's each-loop) is caught by the
 * round-trip check the editor screen runs before it opens a body for editing.
 */

export interface EmailButtonAttrs {
  label: string;
  href: string;
}
export interface EmailImageAttrs {
  src: string;
  alt: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mergeField: { insertMergeField: (name: string) => ReturnType };
    emailButton: {
      insertEmailButton: (attrs: EmailButtonAttrs) => ReturnType;
      updateEmailButton: (attrs: EmailButtonAttrs) => ReturnType;
    };
    emailImage: { insertEmailImage: (attrs: EmailImageAttrs) => ReturnType };
  }
}

/**
 * A merge field as one atomic inline chip. It is a single position in the
 * document, so it can be selected, moved and deleted only as a whole, and
 * `{{displayNa` can never be left behind. `fromEmailContent` makes the chip
 * elements; `toEmailContent` writes them back as `{{name}}`.
 */
export const MergeField = Node.create({
  name: 'mergeField',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-merge-field') ?? '',
        renderHTML: (attrs: { name: string }) => ({ 'data-merge-field': attrs.name }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-merge-field]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'merge-chip', contenteditable: 'false' }),
      `{{${node.attrs['name'] as string}}}`,
    ];
  },

  renderText({ node }) {
    return `{{${node.attrs['name'] as string}}}`;
  },

  addCommands() {
    return {
      insertMergeField:
        (name: string) =>
        ({ commands }) =>
          commands.insertContent([{ type: this.name, attrs: { name } }]),
    };
  },

  // ProseMirror leaves a plain Backspace/Delete inside text to the browser,
  // which is not guaranteed to treat a contenteditable=false chip as one unit.
  // Handling the key here makes it one unit everywhere, the way TipTap's own
  // Mention extension does.
  addKeyboardShortcuts() {
    const removeAdjacent = (direction: -1 | 1) => () => {
      const { state, view } = this.editor;
      const { selection } = state;
      if (!selection.empty) return false;
      const node = direction === -1 ? selection.$from.nodeBefore : selection.$from.nodeAfter;
      if (!node || node.type.name !== this.name) return false;
      const from = direction === -1 ? selection.from - node.nodeSize : selection.from;
      view.dispatch(state.tr.delete(from, from + node.nodeSize));
      return true;
    };
    return { Backspace: removeAdjacent(-1), Delete: removeAdjacent(1) };
  },
});

/**
 * A button: a label and a target, written as `<a href class="button">`. An
 * inline atom, inserted in a paragraph of its own. Its parse rule outranks the
 * Link mark (priority 1000 against Link's default), so a stored button never
 * loads as an ordinary link and loses its class on the next save.
 */
export const EmailButton = Node.create({
  name: 'emailButton',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => (el.textContent ?? '').trim(),
        renderHTML: () => ({}),
      },
      href: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('href') ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a.button', priority: 1000 }];
  },

  renderHTML({ node }) {
    return ['a', { href: node.attrs['href'] as string, class: 'button' }, node.attrs['label'] as string];
  },

  renderText({ node }) {
    return `${node.attrs['label'] as string}: ${node.attrs['href'] as string}`;
  },

  addCommands() {
    return {
      insertEmailButton:
        (attrs: EmailButtonAttrs) =>
        ({ commands }) =>
          commands.insertContent({ type: 'paragraph', content: [{ type: this.name, attrs }] }),
      updateEmailButton:
        (attrs: EmailButtonAttrs) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attrs),
    };
  },
});

/**
 * An image from our Cloudinary library. The parse rule refuses any other
 * source, so an image pasted from Gmail or a web page never enters the
 * document (the server would strip it on save anyway, with a warning).
 */
export const EmailImage = Node.create({
  name: 'emailImage',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      src: { default: '', renderHTML: () => ({}) },
      alt: { default: '', renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (el: HTMLElement) => (CLOUDINARY_IMAGE.test(el.getAttribute('src') ?? '') ? null : false),
      },
    ];
  },

  renderHTML({ node }) {
    return ['img', { src: node.attrs['src'] as string, alt: node.attrs['alt'] as string }];
  },

  addCommands() {
    return {
      insertEmailImage:
        (attrs: EmailImageAttrs) =>
        ({ commands }) =>
          commands.insertContent({ type: 'paragraph', content: [{ type: this.name, attrs }] }),
    };
  },
});

/**
 * #953 Ruling C5(b): a list whose items repeat once per entry of a list field
 * (`{{#each visits}}…{{/each}}`, the booking and assignment confirmations).
 * `fromEmailContent` lifts the two block tags off the stored `<ul>` into
 * `data-each`, this attribute keeps the field name on the list node while the
 * operator edits the items, and `toEmailContent` writes the block tags back
 * around the items. The attribute itself never reaches the server.
 */
export const EachBlockList = Extension.create({
  name: 'eachBlockList',

  addGlobalAttributes() {
    return [
      {
        types: ['bulletList', 'orderedList'],
        attributes: {
          each: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const name = el.getAttribute('data-each');
              return name !== null && EACH_BLOCK_NAME.test(name) ? name : null;
            },
            renderHTML: (attrs: { each?: string | null }) => (attrs.each ? { 'data-each': attrs.each } : {}),
          },
        },
      },
    ];
  },
});

/**
 * #953 loop protection: the field a repeating list around the selection loops
 * over, or null. Either end of the selection counts, so a selection that only
 * reaches into the loop is treated as inside it.
 */
export function loopedListName(state: Editor['state']): string | null {
  for (const $pos of [state.selection.$from, state.selection.$to]) {
    for (let d = $pos.depth; d > 0; d--) {
      const node = $pos.node(d);
      const each = node.attrs['each'] as string | null | undefined;
      if ((node.type.name === 'bulletList' || node.type.name === 'orderedList') && each) return each;
    }
  }
  return null;
}

/** A bullet or numbered list that carries an each-loop. */
function isLoopedList(node: { type: { name: string }; attrs: Record<string, unknown> } | null | undefined): boolean {
  return (
    node !== null &&
    node !== undefined &&
    (node.type.name === 'bulletList' || node.type.name === 'orderedList') &&
    Boolean(node.attrs['each'])
  );
}

/**
 * #953 loop protection, keyboard half (the toolbar disables its own buttons).
 * TipTap's list toggles and lifts rebuild the list without `data-each`, which
 * deletes the loop, and a lift from the middle of a list splits it into two
 * loops, which sends every visit twice. Inside a repeating list these keys do
 * nothing, except Backspace at the start of a later item, which joins it to
 * the item above instead of lifting it out.
 *
 * The loop's edges are guarded too (fix round 1). Backspace at the start of
 * the first item would lift it out of the loop, Delete at the end of the last
 * item would pull the next paragraph in, and Backspace or Delete in the
 * paragraph right after or right before the list would join that paragraph
 * into (or an item out of) the loop. At those edges the key does nothing. An
 * empty paragraph beside the list is still removed as usual, which leaves the
 * loop whole. Priority above the StarterKit so these run first.
 */
export const LoopedListGuard = Extension.create({
  name: 'loopedListGuard',
  priority: 1000,

  addKeyboardShortcuts() {
    const inLoop = () => loopedListName(this.editor.state) !== null;
    const keys = ['Mod-Shift-7', 'Mod-Shift-8', 'Mod-Alt-2', 'Mod-Alt-3', 'Mod-Shift-b', 'Tab', 'Shift-Tab'];
    const shortcuts: Record<string, () => boolean> = Object.fromEntries(keys.map((k) => [k, inLoop]));

    // The list item holding the cursor: its depth, and whether it is the last
    // or the first item of its list.
    const item = () => {
      const { $from } = this.editor.state.selection;
      for (let d = $from.depth; d > 1; d--) {
        if ($from.node(d).type.name === 'listItem') {
          const index = $from.index(d - 1);
          return { depth: d, first: index === 0, last: index === $from.node(d - 1).childCount - 1 };
        }
      }
      return null;
    };

    // The block beside the cursor's (non-empty) textblock, one step before or
    // after it in the same parent, when that block is a looped list.
    const loopBeside = (direction: -1 | 1): boolean => {
      const { $from } = this.editor.state.selection;
      if ($from.depth < 1 || $from.parent.content.size === 0) return false;
      const parent = $from.node($from.depth - 1);
      const index = $from.index($from.depth - 1) + direction;
      return index >= 0 && index < parent.childCount && isLoopedList(parent.child(index));
    };

    shortcuts['Enter'] = () => {
      const { selection } = this.editor.state;
      if (!inLoop() || !selection.empty || selection.$from.parent.content.size > 0) return false;
      const li = item();
      // An empty last item leaves the list, which keeps the loop whole.
      return li !== null && !li.last;
    };

    shortcuts['Backspace'] = () => {
      const { selection } = this.editor.state;
      const { $from } = selection;
      if (!selection.empty || $from.parentOffset !== 0) return false;
      if (!inLoop()) return loopBeside(-1);
      const li = item();
      if (li === null || $from.index(li.depth) !== 0) return false;
      // The first item stays put; a later item joins the one above.
      if (li.first) return true;
      return this.editor.commands.joinTextblockBackward();
    };

    shortcuts['Delete'] = () => {
      const { selection } = this.editor.state;
      const { $from } = selection;
      if (!selection.empty || $from.parentOffset !== $from.parent.content.size) return false;
      if (!inLoop()) return loopBeside(1);
      const li = item();
      if (li === null) return false;
      // The end of the last item: nothing after the list joins the loop.
      return li.last && $from.index(li.depth) === $from.node(li.depth).childCount - 1;
    };

    return shortcuts;
  },
});

/**
 * #953 fix round 2: the meta flag that lets a transaction replace looped lists
 * wholesale. Only a content load sets it (`setContent` of a whole template);
 * the component's own load is the editor's initial content, which is no
 * transaction at all.
 */
export const LOAD_CONTENT_META = 'emailEditorLoad';

interface LoopedSpan {
  each: string;
  /** The list node's own position, before its opening token. */
  pos: number;
  /** First and last position inside the list (its content range). */
  start: number;
  end: number;
}

function loopedSpans(doc: PMNode): LoopedSpan[] {
  const spans: LoopedSpan[] = [];
  doc.descendants((node, pos) => {
    if (isLoopedList(node)) {
      spans.push({ each: node.attrs['each'] as string, pos, start: pos + 1, end: pos + node.nodeSize - 1 });
    }
    return true;
  });
  return spans;
}

const insideSpan = (span: LoopedSpan, x: number) => x >= span.start && x <= span.end;

/** True when exactly one end of [from, to] lies inside the list's content. */
function crosses(span: LoopedSpan, from: number, to: number): boolean {
  return insideSpan(span, from) !== insideSpan(span, to);
}

/** True when the range holds no text and no atom (a merge field, button, image). */
function holdsNothing(doc: PMNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.isText || node.isAtom) found = true;
    return !found;
  });
  return !found;
}

/** A loop-local token: `{{this}}` or `{{this.something}}`. */
const LOOP_TOKEN = /\{\{\s*this(?:\.[A-Za-z0-9_.]*)?\s*\}\}/;

function mentionsLoopToken(node: PMNode): boolean {
  if (node.type.name === 'mergeField') {
    const name = node.attrs['name'] as string;
    if (name === 'this' || name.startsWith('this.')) return true;
  }
  if (node.isText && LOOP_TOKEN.test(node.text ?? '')) return true;
  for (const value of Object.values(node.attrs)) {
    if (typeof value === 'string' && LOOP_TOKEN.test(value)) return true;
  }
  return node.marks.some((mark) =>
    Object.values(mark.attrs).some((value) => typeof value === 'string' && LOOP_TOKEN.test(value)),
  );
}

/** How many nodes carry a loop-local token outside every looped list. */
function orphanedLoopTokens(doc: PMNode): number {
  let count = 0;
  const walk = (node: PMNode, inLoop: boolean) => {
    node.forEach((child) => {
      if (!inLoop && mentionsLoopToken(child)) count++;
      walk(child, inLoop || isLoopedList(child));
    });
  };
  walk(doc, false);
  return count;
}

/**
 * Identity (fix round 3): every looped list before the change must still be
 * there after it, as the same list. Its position mapped through the change
 * must land on a looped list with the same field name, and no looped list may
 * appear that is not one of those. The mapped end must match the list's new
 * end, except when all that lies between them is empty blocks (Enter on an
 * empty last item leaving the list), so a loop that was cut in two, or that
 * swallowed what came after it, is refused.
 */
function keepsLoopIdentity(tr: Transaction, before: LoopedSpan[], after: LoopedSpan[]): boolean {
  const kept = new Set<number>();
  for (const span of before) {
    const start = tr.mapping.mapResult(span.pos, 1);
    if (start.deleted) return false;
    const node = tr.doc.nodeAt(start.pos);
    if (!node || !isLoopedList(node) || node.attrs['each'] !== span.each) return false;
    const newEnd = start.pos + node.nodeSize;
    const mappedEnd = tr.mapping.map(span.end + 1, -1);
    if (newEnd !== mappedEnd) {
      const [lo, hi] = newEnd < mappedEnd ? [newEnd, mappedEnd] : [mappedEnd, newEnd];
      if (!holdsNothing(tr.doc, lo, hi)) return false;
    }
    kept.add(start.pos);
  }
  return after.every((span) => kept.has(span.pos));
}

/**
 * #953 fix round 2, the structural guard (controller ruling), widened in fix
 * round 3. The keymaps in LoopedListGuard handle a collapsed cursor; this
 * catches everything else, such as a selection across the list's edge
 * followed by Delete, cut, typing or a paste. A document change is refused
 * when:
 *  - a looped list does not survive as itself (see keepsLoopIdentity): one
 *    removed, replaced, cut in two or grown over its neighbour, a new one
 *    added (even one with the same field name), or `data-each` set, cleared
 *    or renamed;
 *  - a replace step's range has exactly one end inside a looped list, which
 *    moves text into or out of the loop. A structural step that only moves
 *    empty blocks across the edge (Enter on an empty last item leaving the
 *    list) is still allowed, since it moves nothing that is sent;
 *  - a structural step's kept block (its gap) has exactly one end inside a
 *    looped list, which lifts part of the loop out or wraps outside content in;
 *  - it leaves more `{{this…}}` tokens outside every loop than before (a
 *    visit field moved out of its loop means nothing when the email is sent).
 * A change wholly inside one list's items, or wholly outside every looped
 * list, passes. So does a transaction carrying LOAD_CONTENT_META.
 *
 * The paste half: a paste that lands in or across a looped list goes in as
 * plain text, its lines joined by line breaks inside the item, so pasted
 * block structure (a list, several paragraphs) never lands in the loop.
 */
export const LoopedListIntegrity = Extension.create({
  name: 'loopedListIntegrity',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('loopedListIntegrity'),
        filterTransaction: (tr, state) => {
          if (!tr.docChanged || tr.getMeta(LOAD_CONTENT_META) === true) return true;
          const before = loopedSpans(state.doc);
          const after = loopedSpans(tr.doc);
          if (before.length === 0 && after.length === 0) return true;
          if (!keepsLoopIdentity(tr, before, after)) return false;
          for (let i = 0; i < tr.steps.length; i++) {
            const step = tr.steps[i];
            const doc = tr.docs[i];
            if (!doc) continue;
            const spans = i === 0 ? before : loopedSpans(doc);
            if (step instanceof ReplaceAroundStep) {
              if (spans.some((s) => crosses(s, step.gapFrom, step.gapTo))) return false;
              if (spans.some((s) => crosses(s, step.from, step.to)) && !holdsNothing(doc, step.gapFrom, step.gapTo)) {
                return false;
              }
            } else if (step instanceof ReplaceStep) {
              if (spans.some((s) => crosses(s, step.from, step.to))) return false;
            }
          }
          return orphanedLoopTokens(tr.doc) <= orphanedLoopTokens(state.doc);
        },
      }),
      new Plugin({
        key: new PluginKey('loopedListPaste'),
        props: {
          handlePaste: (view, event, slice) => {
            const { state } = view;
            const { from, to } = state.selection;
            const touches = loopedSpans(state.doc).some(
              (s) => insideSpan(s, from) || insideSpan(s, to) || (from < s.start && to > s.end),
            );
            if (!touches) return false;
            const plain =
              event.clipboardData?.getData('text/plain') ||
              slice.content.textBetween(0, slice.content.size, '\n', (leaf) =>
                leaf.type.name === 'mergeField' ? `{{${leaf.attrs['name'] as string}}}` : leaf.type.name === 'hardBreak' ? '\n' : '',
              );
            const lines = plain.split(/\r?\n/).filter((line) => line.trim() !== '');
            const hardBreak = state.schema.nodes['hardBreak'];
            const nodes: PMNode[] = [];
            lines.forEach((line, index) => {
              if (index > 0 && hardBreak) nodes.push(hardBreak.create());
              nodes.push(state.schema.text(line));
            });
            if (nodes.length > 0) view.dispatch(state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});

/** The full extension list. One function, so the component and the tests build the same schema. */
export function emailEditorExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      codeBlock: false,
      code: false,
      strike: false,
      underline: false,
      horizontalRule: false,
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
      HTMLAttributes: { target: null, rel: null, class: null },
      isAllowedUri: (url) => isLinkTarget(url),
    }),
    MergeField,
    EmailButton,
    EmailImage,
    EachBlockList,
    LoopedListGuard,
    LoopedListIntegrity,
  ];
}
