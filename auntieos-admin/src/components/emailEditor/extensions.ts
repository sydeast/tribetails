import { Extension, Node, mergeAttributes, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
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
  ];
}
