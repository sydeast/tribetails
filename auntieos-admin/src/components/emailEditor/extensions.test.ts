// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { LOAD_CONTENT_META, emailEditorExtensions, loopedListName } from './extensions';
import { fromEmailContent, toEmailContent } from '../../lib/emailContent';

let editor: Editor | null = null;
function open(content: string): Editor {
  editor = new Editor({ extensions: emailEditorExtensions(), content: fromEmailContent(content) });
  return editor;
}
const out = (e: Editor) => toEmailContent(e.getHTML());
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const EVERYTHING =
  '<p>Hi {{displayName}},</p><p>Someone asked to reset the password for {{email}}.</p>' +
  '<p><a href="{{link}}" class="button">Reset password</a></p><ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>' +
  '<h2>Head</h2><h3>Sub</h3><blockquote><p>Careful</p></blockquote>' +
  '<p>See <a href="https://tribetails.com/help?a=1&amp;b=2">help</a> or <a href="mailto:auntie@tribetails.com">write</a>, <strong>bold</strong> <em>it</em><br>next</p>' +
  '<p><img src="https://res.cloudinary.com/tribetails/image/upload/v1/pup.jpg" alt="Pup"></p>';

describe('round trip', () => {
  it('loads stored content and writes it back byte for byte', () => {
    expect(out(open(EVERYTHING))).toBe(EVERYTHING);
  });

  it('keeps a merge field inside a button label as text', () => {
    const html = '<p><a href="{{link}}" class="button">Hi {{displayName}}</a></p>';
    expect(out(open(html))).toBe(html);
  });
});

describe('merge-field chips', () => {
  it('insertMergeField drops a chip at the cursor, written as {{name}}', () => {
    const e = open('<p>ab</p>');
    e.commands.setTextSelection(3);
    e.commands.insertMergeField('link');
    expect(out(e)).toBe('<p>ab{{link}}</p>');
  });

  it('Backspace right after a chip removes the whole field in one keystroke', () => {
    const e = open('<p>Hi {{displayName}}</p>');
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    expect(e.commands.keyboardShortcut('Backspace')).toBe(true);
    expect(out(e)).toBe('<p>Hi </p>');
  });

  it('Delete right before a chip removes the whole field in one keystroke', () => {
    const e = open('<p>{{link}} x</p>');
    e.commands.setTextSelection(1);
    expect(e.commands.keyboardShortcut('Delete')).toBe(true);
    expect(out(e)).toBe('<p> x</p>');
  });
});

describe('pasting', () => {
  it('Gmail: keeps text, bold and https links; drops styles, http links and Gmail-hosted images', () => {
    const e = open('<p>x</p>');
    e.commands.setTextSelection(2);
    e.commands.insertContent(
      '<div dir="ltr"><span style="font-family:arial;color:#222">Hi <b>there</b></span><div><br></div>' +
        '<div><a href="https://x.com" target="_blank">site</a> and <a href="http://y.com">old</a></div>' +
        '<img src="https://mail.google.com/x.png"></div>',
    );
    expect(out(e)).toBe('<p>x</p><p>Hi <strong>there</strong></p><p><a href="https://x.com">site</a> and old</p>');
  });

  it('Word: styled spans, <o:p>, an h1 and a table become plain paragraphs', () => {
    const e = open('');
    e.commands.insertContent(
      '<p class="MsoNormal" style="margin:0"><span style="font-size:11pt;color:red">Hello<o:p></o:p></span></p>' +
        '<h1>Big</h1><table><tr><td>cell</td></tr></table>',
    );
    expect(out(e)).toBe('<p>Hello</p><p>Big</p><p>cell</p>');
  });
});

describe('toolbar commands produce the allowed HTML', () => {
  it('bold and italic', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection({ from: 1, to: 5 });
    e.chain().focus().toggleBold().toggleItalic().run();
    expect(out(e)).toBe('<p><strong><em>word</em></strong></p>');
  });

  it('heading 2 and heading 3', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection(2);
    e.chain().focus().toggleHeading({ level: 2 }).run();
    expect(out(e)).toBe('<h2>word</h2>');
    e.chain().focus().toggleHeading({ level: 3 }).run();
    expect(out(e)).toBe('<h3>word</h3>');
  });

  it('bulleted and numbered lists', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection(2);
    e.chain().focus().toggleBulletList().run();
    expect(out(e)).toBe('<ul><li>word</li></ul>');
    e.chain().focus().toggleOrderedList().run();
    expect(out(e)).toBe('<ol><li>word</li></ol>');
  });

  it('callout is a blockquote', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection(2);
    e.chain().focus().toggleBlockquote().run();
    expect(out(e)).toBe('<blockquote><p>word</p></blockquote>');
  });

  it('link: https and a merge field are accepted, http is refused', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection({ from: 1, to: 5 });
    expect(e.chain().focus().setLink({ href: 'http://x.com' }).run()).toBe(false);
    expect(out(e)).toBe('<p>word</p>');
    e.chain().focus().setLink({ href: '{{link}}' }).run();
    expect(out(e)).toBe('<p><a href="{{link}}">word</a></p>');
  });

  it('button: inserts in its own paragraph and edits in place', () => {
    const e = open('<p>word</p>');
    e.commands.setTextSelection(5);
    e.commands.insertEmailButton({ label: 'Go', href: 'https://a.com' });
    expect(out(e)).toBe('<p>word</p><p><a href="https://a.com" class="button">Go</a></p>');
    e.commands.setNodeSelection(e.state.doc.child(0).nodeSize + 1);
    expect(e.isActive('emailButton')).toBe(true);
    e.commands.updateEmailButton({ label: 'Went', href: '{{link}}' });
    expect(out(e)).toBe('<p>word</p><p><a href="{{link}}" class="button">Went</a></p>');
  });

  it('image: inserts in its own paragraph; a non-Cloudinary image never loads', () => {
    const e = open('<p>word</p><p><img src="https://evil.example/x.png" alt="x"></p>');
    expect(out(e)).toBe('<p>word</p>');
    e.commands.setTextSelection(5);
    e.commands.insertEmailImage({ src: 'https://res.cloudinary.com/t/image/upload/a.png', alt: 'A' });
    expect(out(e)).toBe('<p>word</p><p><img src="https://res.cloudinary.com/t/image/upload/a.png" alt="A"></p>');
  });
});

/**
 * #953 Ruling C5(b): the two seeds whose body repeats a line per visit. Stored
 * content keeps the Handlebars block tags as bare text inside the `<ul>`; the
 * editor carries them as `data-each` on the list, and writing back puts them
 * where they were.
 */
describe('each-block lists', () => {
  const seedsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../mytribe/seeds/notificationTemplates');
  const seed = (key: string) => readFileSync(join(seedsDir, key, 'content.html'), 'utf8').trimEnd();

  // The only two differences the round trip makes, named here so nothing else
  // can hide behind them:
  //  1. the whitespace the converter left after `{{#each visits}}` and after
  //     `{{/each}}` goes (it is insignificant inside a <ul>, and the text part
  //     trims each block-tag line anyway);
  //  2. a button's attributes are written href first (`toEmailContent`'s one
  //     order; the same holds for the six other seeds written class first).
  const LOOP_WHITESPACE = /(\{\{#each visits\}\}|\{\{\/each\}\})\n +/g;
  const expectedStored = (stored: string) =>
    stored.replace(LOOP_WHITESPACE, '$1').replace(/<a class="button" href="([^"]*)">/g, '<a href="$1" class="button">');

  it.each(['assignment.assigned', 'kincare.booking.confirm'])('%s opens and writes back unchanged', (key) => {
    const stored = seed(key);
    expect(stored).toContain('<ul>{{#each visits}}\n');
    const saved = out(open(stored));
    expect(saved).toBe(expectedStored(stored));
    expect(saved).toContain('<ul>{{#each visits}}<li>{{this.weekday}}, {{this.date}} at {{this.time}}</li>{{/each}}</ul>');
    // And the second trip is exact.
    editor?.destroy();
    expect(out(open(saved))).toBe(saved);
  });

  it('holds the loop as an attribute of the list, with the visit line as its only item', () => {
    const e = open(seed('kincare.booking.confirm'));
    const lists: Array<{ each: unknown; items: number; markerText: boolean }> = [];
    e.state.doc.descendants((node) => {
      if (node.type.name === 'bulletList') {
        lists.push({ each: node.attrs['each'], items: node.childCount, markerText: /#each|\/each/.test(node.textContent) });
      }
      return true;
    });
    expect(lists).toEqual([{ each: 'visits', items: 1, markerText: false }]);
  });

  it('editing the visit line keeps the loop markers around it', () => {
    const e = open(seed('assignment.assigned'));
    let end = -1;
    e.state.doc.descendants((node, pos) => {
      if (node.type.name === 'listItem') end = pos + node.nodeSize - 2; // inside the item's paragraph, at its end
      return true;
    });
    expect(end).toBeGreaterThan(0);
    e.chain().insertContentAt(end, ' (confirmed)').run();
    expect(out(e)).toContain(
      '<ul>{{#each visits}}<li>{{this.weekday}}, {{this.date}} at {{this.time}} (confirmed)</li>{{/each}}</ul>',
    );
  });

  it('a second line added inside the loop repeats with it', () => {
    const e = open('<ul>{{#each visits}}<li>{{this.date}}</li>{{/each}}</ul>');
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    e.chain().splitListItem('listItem').insertContent('Bring the leash').run();
    expect(out(e)).toBe('<ul>{{#each visits}}<li>{{this.date}}</li><li>Bring the leash</li>{{/each}}</ul>');
  });

  it('a plain list gains no loop', () => {
    expect(out(open('<ul><li>a</li></ul><ol><li>b</li></ol>'))).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });
});
describe('the keyboard cannot break a repeating list (#953 loop protection)', () => {
  const LOOP = '<p>x</p><ul>{{#each visits}}<li>a</li><li>b</li><li>c</li>{{/each}}</ul><p>y</p>';
  function at(e: Editor, text: string): number {
    let found = -1;
    e.state.doc.descendants((node, pos) => {
      if (found === -1 && node.isText && node.text === text) found = pos;
    });
    return found;
  }
  it('loopedListName names the loop around the selection, and nothing outside it', () => {
    const e = open(LOOP);
    e.commands.setTextSelection(at(e, 'b') + 1);
    expect(loopedListName(e.state)).toBe('visits');
    e.commands.setTextSelection(1);
    expect(loopedListName(e.state)).toBeNull();
    e.commands.setTextSelection({ from: 1, to: at(e, 'a') + 1 });
    expect(loopedListName(e.state)).toBe('visits');
  });
  it.each([
    ['Mod-Shift-7', 'numbered list'],
    ['Mod-Shift-8', 'bulleted list'],
    ['Mod-Alt-2', 'heading'],
    ['Mod-Alt-3', 'subheading'],
    ['Mod-Shift-b', 'callout'],
    ['Tab', 'indent'],
    ['Shift-Tab', 'outdent'],
  ])('%s (%s) inside the loop leaves it whole', (key) => {
    const e = open(LOOP);
    e.commands.setTextSelection(at(e, 'b') + 1);
    e.commands.keyboardShortcut(key);
    expect(out(e)).toBe(LOOP);
  });
  it('the same keys still work outside the loop', () => {
    const e = open(LOOP);
    e.commands.setTextSelection(at(e, 'y') + 1);
    e.commands.keyboardShortcut('Mod-Shift-7');
    expect(out(e)).toBe('<p>x</p><ul>{{#each visits}}<li>a</li><li>b</li><li>c</li>{{/each}}</ul><ol><li>y</li></ol>');
  });
  it('Backspace at the start of a later item joins it to the one above, keeping one loop', () => {
    const e = open(LOOP);
    e.commands.setTextSelection(at(e, 'b'));
    e.commands.keyboardShortcut('Backspace');
    expect(out(e)).toBe('<p>x</p><ul>{{#each visits}}<li>ab</li><li>c</li>{{/each}}</ul><p>y</p>');
  });
  it('Enter on an empty item in the middle does not split the loop in two', () => {
    const e = open(LOOP);
    e.commands.setTextSelection(at(e, 'b') + 1);
    e.commands.keyboardShortcut('Enter');
    e.commands.keyboardShortcut('Enter');
    expect(out(e).match(/\{\{#each/g)).toHaveLength(1);
    expect(out(e)).toBe(LOOP);
  });
  // Fix round 1: the loop's edges.
  it.each([
    ['Backspace', 'the start of the first item', 'a', 0],
    ['Delete', 'the end of the last item', 'c', 1],
    ['Backspace', 'the start of the paragraph after the list', 'y', 0],
    ['Delete', 'the end of the paragraph before the list', 'x', 1],
  ] as const)('%s at %s leaves the loop and its neighbours as they were', (key, _where, text, offset) => {
    const e = open(LOOP);
    e.commands.setTextSelection(at(e, text) + offset);
    e.commands.keyboardShortcut(key);
    expect(out(e)).toBe(LOOP);
  });
  it('Backspace or Delete in an empty paragraph beside the loop removes that paragraph only', () => {
    const before = '<p>x</p><ul>{{#each visits}}<li>a</li><li>c</li>{{/each}}</ul><p></p><p>y</p>';
    const e = open(before);
    let pos = -1;
    e.state.doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph' && node.content.size === 0) pos = offset + 1;
    });
    e.commands.setTextSelection(pos);
    e.commands.keyboardShortcut('Backspace');
    expect(out(e)).toBe('<p>x</p><ul>{{#each visits}}<li>a</li><li>c</li>{{/each}}</ul><p>y</p>');
    expect(e.state.doc.childCount).toBe(3);
  });
  it('Delete at the end of a middle item still joins the next item into it', () => {
    const e = open(LOOP);
    e.commands.setTextSelection(at(e, 'b') + 1);
    e.commands.keyboardShortcut('Delete');
    expect(out(e)).toBe('<p>x</p><ul>{{#each visits}}<li>a</li><li>bc</li>{{/each}}</ul><p>y</p>');
  });
  it('a plain list keeps the usual Backspace and Delete at its edges', () => {
    const PLAIN = '<p>x</p><ul><li>a</li><li>c</li></ul><p>y</p>';
    let e = open(PLAIN);
    e.commands.setTextSelection(at(e, 'a'));
    e.commands.keyboardShortcut('Backspace');
    expect(out(e)).toBe('<p>x</p><p>a</p><ul><li>c</li></ul><p>y</p>');
    e = open(PLAIN);
    e.commands.setTextSelection(at(e, 'c') + 1);
    e.commands.keyboardShortcut('Delete');
    expect(out(e)).toBe('<p>x</p><ul><li>a</li><li>c</li><li>y</li></ul>');
    e = open(PLAIN);
    e.commands.setTextSelection(at(e, 'y'));
    e.commands.keyboardShortcut('Backspace');
    expect(out(e)).toBe('<p>x</p><ul><li>a</li><li>c<br>y</li></ul>');
    e = open(PLAIN);
    e.commands.setTextSelection(at(e, 'x') + 1);
    e.commands.keyboardShortcut('Delete');
    expect(out(e)).toBe('<p>x</p><p>a</p><ul><li>c</li></ul><p>y</p>');
  });

  it('Enter twice at the end of the last item leaves the list, loop intact', () => {
    const e = open(LOOP);
    e.commands.setTextSelection(at(e, 'c') + 1);
    e.commands.keyboardShortcut('Enter');
    e.commands.keyboardShortcut('Enter');
    e.commands.insertContent('z');
    expect(out(e)).toBe('<p>x</p><ul>{{#each visits}}<li>a</li><li>b</li><li>c</li>{{/each}}</ul><p>z</p><p>y</p>');
  });
});
describe('no edit can break a repeating list (#953 fix round 2, structural guard)', () => {
  const seedsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../mytribe/seeds/notificationTemplates');
  const seed = (key: string) => readFileSync(join(seedsDir, key, 'content.html'), 'utf8').trimEnd();
  const SYNTHETIC = '<p>Before</p><ul>{{#each visits}}<li>one</li><li>two</li><li>three</li>{{/each}}</ul><p>After</p>';
  // Each document with: the text of its last item's first text node, and the
  // stored content once that text is deleted.
  const docs: Array<[string, string, (base: string) => string]> = [
    ['synthetic 3-item loop', SYNTHETIC, (b) => b.replace('<li>three</li>', '<li></li>').replace('<li></li>', '')],
    ['assignment.assigned', seed('assignment.assigned'), (b) => b.replace('{{this.weekday}}, {{this.date}}', '{{this.weekday}}{{this.date}}')],
    ['kincare.booking.confirm', seed('kincare.booking.confirm'), (b) => b.replace('{{this.weekday}}, {{this.date}}', '{{this.weekday}}{{this.date}}')],
  ];
  /** The looped list's position and size, and the text of its last item. */
  function loop(e: Editor) {
    let pos = -1;
    let size = 0;
    e.state.doc.descendants((node, p) => {
      if (pos === -1 && node.attrs['each']) {
        pos = p;
        size = node.nodeSize;
      }
      return pos === -1;
    });
    expect(pos).toBeGreaterThan(0);
    return { pos, size, after: pos + size };
  }
  function lastItemFirstText(e: Editor, list: { pos: number; size: number }) {
    let found: { pos: number; text: string } | null = null;
    const listNode = e.state.doc.nodeAt(list.pos);
    const lastItemPos = list.pos + list.size - 1 - (listNode?.lastChild?.nodeSize ?? 0);
    e.state.doc.nodesBetween(lastItemPos, list.pos + list.size - 1, (node, p) => {
      if (found === null && node.isText) found = { pos: p, text: node.text ?? '' };
      return found === null;
    });
    if (found === null) throw new Error('no text in the last item');
    return found as { pos: number; text: string };
  }
  describe.each(docs)('%s', (_name, content, deleteInside) => {
    it('a selection from the paragraph before into the first item, deleted, changes nothing', () => {
      const e = open(content);
      const base = out(e);
      const l = loop(e);
      e.commands.setTextSelection({ from: l.pos - 2, to: l.pos + 4 });
      e.commands.deleteSelection();
      expect(out(e)).toBe(base);
    });
    it('a selection from the last item into the paragraph after, deleted, changes nothing', () => {
      const e = open(content);
      const base = out(e);
      const l = loop(e);
      e.commands.setTextSelection({ from: l.after - 4, to: l.after + 3 });
      e.commands.deleteSelection();
      expect(out(e)).toBe(base);
    });
    it('select all, then delete, changes nothing', () => {
      const e = open(content);
      const base = out(e);
      e.commands.selectAll();
      e.commands.deleteSelection();
      expect(out(e)).toBe(base);
    });
    it('select all, then typing, changes nothing', () => {
      const e = open(content);
      const base = out(e);
      e.commands.selectAll();
      e.commands.insertContent('x');
      expect(out(e)).toBe(base);
    });
    it('a selection wholly inside one item deletes normally', () => {
      const e = open(content);
      const base = out(e);
      const t = lastItemFirstText(e, loop(e));
      e.commands.setTextSelection({ from: t.pos, to: t.pos + t.text.length });
      e.commands.deleteSelection();
      expect(out(e)).toBe(deleteInside(base));
      expect(out(e)).toContain('{{#each visits}}');
    });
    it('a selection wholly outside the list deletes normally', () => {
      const e = open(content);
      const base = out(e);
      const l = loop(e);
      const start = l.after + 1;
      const gone = e.state.doc.textBetween(start, start + 4);
      e.commands.setTextSelection({ from: start, to: start + 4 });
      e.commands.deleteSelection();
      expect(out(e)).toBe(base.replace(`</ul><p>${gone}`, '</ul><p>'));
    });
    it('typing inside an item works', () => {
      const e = open(content);
      const base = out(e);
      const l = loop(e);
      e.commands.setTextSelection(l.after - 3);
      e.commands.insertContent(' (confirmed)');
      expect(out(e)).toBe(base.replace('</li>{{/each}}', ' (confirmed)</li>{{/each}}'));
    });
    it('a content load carrying the load flag replaces the document, loop and all', () => {
      const e = open('<p>old</p>');
      e.chain().setMeta(LOAD_CONTENT_META, true).setContent(fromEmailContent(content), { emitUpdate: false }).run();
      expect(out(e)).toBe(out(open(content)));
      expect(out(e)).toContain('{{#each visits}}');
    });
  });
  it('a transaction that would remove the loop is refused, even through setContent', () => {
    const e = open(SYNTHETIC);
    e.commands.setContent('<p>plain</p>');
    expect(out(e)).toBe(SYNTHETIC);
    e.chain().setMeta(LOAD_CONTENT_META, true).setContent('<p>plain</p>').run();
    expect(out(e)).toBe('<p>plain</p>');
  });
  it('setting or clearing data-each by attributes is refused', () => {
    const e = open(SYNTHETIC);
    const l = loop(e);
    e.commands.command(({ tr }) => {
      tr.setNodeMarkup(l.pos, undefined, { each: null });
      return true;
    });
    expect(out(e)).toBe(SYNTHETIC);
    const plain = open('<ul><li>a</li></ul>');
    plain.commands.command(({ tr }) => {
      tr.setNodeMarkup(0, undefined, { each: 'visits' });
      return true;
    });
    expect(out(plain)).toBe('<ul><li>a</li></ul>');
  });
});
describe('pastes and moves cannot break a repeating list (#953 fix round 3)', () => {
  const seedsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../mytribe/seeds/notificationTemplates');
  const seed = (key: string) => readFileSync(join(seedsDir, key, 'content.html'), 'utf8').trimEnd();
  const SYNTHETIC = '<p>Before</p><ul>{{#each visits}}<li>one</li><li>two</li><li>three</li>{{/each}}</ul><p>After</p>';
  const WITH_CHIP = '<p>Before</p><ul>{{#each visits}}<li>{{this.date}} one</li><li>two</li>{{/each}}</ul><p>After</p>';
  /** A real paste event on the editor's DOM, with the given clipboard. */
  function paste(e: Editor, html: string, text: string): boolean {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
        types: ['text/html', 'text/plain'],
        files: [],
      },
    });
    e.view.dom.dispatchEvent(event);
    return event.defaultPrevented;
  }
  function loop(e: Editor) {
    let pos = -1;
    let size = 0;
    e.state.doc.descendants((node, p) => {
      if (pos === -1 && node.attrs['each']) {
        pos = p;
        size = node.nodeSize;
      }
      return pos === -1;
    });
    expect(pos).toBeGreaterThan(0);
    return { pos, size, after: pos + size };
  }
  /** Position just after the first character of the first text node inside the last item. */
  function midLastItem(e: Editor) {
    const l = loop(e);
    const list = e.state.doc.nodeAt(l.pos);
    const lastItem = l.after - 1 - (list?.lastChild?.nodeSize ?? 0);
    let at = -1;
    e.state.doc.nodesBetween(lastItem, l.after - 1, (node, p) => {
      if (at === -1 && node.isText) at = p + 1;
      return at === -1;
    });
    expect(at).toBeGreaterThan(0);
    return at;
  }
  // [name, content, where the paste lands inside the last item: before -> after]
  const docs: Array<[string, string, string, string]> = [
    ['synthetic 3-item loop', SYNTHETIC, '<li>three</li>', '<li>t%%hree</li>'],
    ['assignment.assigned', seed('assignment.assigned'), '{{this.weekday}}, {{this.date}}', '{{this.weekday}},%% {{this.date}}'],
    ['kincare.booking.confirm', seed('kincare.booking.confirm'), '{{this.weekday}}, {{this.date}}', '{{this.weekday}},%% {{this.date}}'],
  ];
  const landed = (base: string, find: string, into: string, pasted: string) => base.replace(find, into.replace('%%', pasted));
  describe.each(docs)('%s', (_name, content, find, into) => {
    it('a list, a paragraph and a list pasted mid-item land as text inside that item', () => {
      const e = open(content);
      const base = out(e);
      e.commands.setTextSelection(midLastItem(e));
      expect(paste(e, '<ul><li>A</li></ul><p>X</p><ul><li>B</li></ul>', 'A\nX\nB')).toBe(true);
      expect(out(e)).toBe(landed(base, find, into, 'A<br>X<br>B'));
      expect(out(e).match(/\{\{#each/g)).toHaveLength(1);
    });
    it('with no plain-text flavour, the pasted markup is flattened to its text', () => {
      const e = open(content);
      const base = out(e);
      e.commands.setTextSelection(midLastItem(e));
      paste(e, '<ul><li>A</li></ul><p>X</p><ul><li>B</li></ul>', '');
      expect(out(e)).toBe(landed(base, find, into, 'A<br>X<br>B'));
    });
    it('two pasted paragraphs become one item with a line break', () => {
      const e = open(content);
      const base = out(e);
      e.commands.setTextSelection(midLastItem(e));
      paste(e, '<p>X</p><p>Y</p>', 'X\n\nY');
      expect(out(e)).toBe(landed(base, find, into, 'X<br>Y'));
    });
    it('a paste over a selection from before the list into it changes nothing', () => {
      const e = open(content);
      const base = out(e);
      const l = loop(e);
      e.commands.setTextSelection({ from: l.pos - 2, to: l.pos + 4 });
      paste(e, `<ul data-each="visits"><li><p>Z</p></li></ul>${e.getHTML()}`, 'Z');
      expect(out(e)).toBe(base);
    });
    it('a same-name loop put over the list, or over a selection into it, is refused', () => {
      const e = open(content);
      const base = out(e);
      const l = loop(e);
      e.commands.insertContentAt({ from: l.pos, to: l.after }, '<ul data-each="visits"><li><p>Z</p></li></ul>');
      expect(out(e)).toBe(base);
      e.commands.insertContentAt({ from: l.pos - 2, to: l.pos + 4 }, '<ul data-each="visits"><li><p>Z</p></li></ul>');
      expect(out(e)).toBe(base);
      // The whole editor HTML put over that selection, past the paste handler.
      e.commands.insertContentAt({ from: l.pos - 2, to: l.pos + 4 }, e.getHTML());
      expect(out(e)).toBe(base);
    });
    it('a list pasted outside the loop still lands as a list', () => {
      const e = open(content);
      const base = out(e);
      const l = loop(e);
      // An empty paragraph right after the list, where the list is pasted.
      e.chain().insertContentAt(l.after, { type: 'paragraph' }).setTextSelection(l.after + 1).run();
      paste(e, '<ul><li>P</li><li>Q</li></ul>', 'P\nQ');
      const after = out(e);
      expect(after).toBe(base.replace('{{/each}}</ul>', '{{/each}}</ul><ul><li>P</li><li>Q</li></ul>'));
    });
  });
  it.each([
    ['a synthetic loop with a chip', WITH_CHIP, 'this.date'],
    ['assignment.assigned', seed('assignment.assigned'), 'this.weekday'],
    ['kincare.booking.confirm', seed('kincare.booking.confirm'), 'this.weekday'],
  ])('%s: moving a {{this…}} chip out of the loop in one transaction is refused', (_name, content, field) => {
    const e = open(content);
    const base = out(e);
    let chip = -1;
    e.state.doc.descendants((node, p) => {
      if (chip === -1 && node.type.name === 'mergeField' && node.attrs['name'] === field) chip = p;
      return chip === -1;
    });
    expect(chip).toBeGreaterThan(0);
    e.commands.command(({ tr }) => {
      const node = tr.doc.nodeAt(chip);
      if (!node) return false;
      tr.delete(chip, chip + 1);
      tr.insert(1, node);
      return true;
    });
    expect(out(e)).toBe(base);
  });
  it('typing a {{this…}} token outside the loop is refused; inside it is fine', () => {
    const e = open(SYNTHETIC);
    e.commands.insertContentAt(1, '{{this.date}} ');
    expect(out(e)).toBe(SYNTHETIC);
    e.commands.insertContentAt(midLastItem(e), '{{this.date}}');
    expect(out(e)).toBe(SYNTHETIC.replace('<li>three</li>', '<li>t{{this.date}}hree</li>'));
  });
  it('a stored {{this…}} already outside a loop does not freeze the editor', () => {
    const e = open('<p>{{this.date}}</p><ul>{{#each visits}}<li>a</li>{{/each}}</ul>');
    e.commands.insertContentAt(1, 'x');
    expect(out(e)).toBe('<p>x{{this.date}}</p><ul>{{#each visits}}<li>a</li>{{/each}}</ul>');
  });
});

describe('EmailButton refuses an unsafe stored href on load', () => {
  function hasEmailButtonNode(e: Editor): boolean {
    let found = false;
    e.state.doc.descendants((node) => {
      if (node.type.name === 'emailButton') found = true;
    });
    return found;
  }

  it('a stored `javascript:` button href does not load as a button node', () => {
    const e = open('<p><a href="javascript:alert(1)" class="button">Go</a></p>');
    expect(hasEmailButtonNode(e)).toBe(false);
    expect(out(e)).not.toContain('javascript:');
  });

  it('a valid https button href still loads as a button node', () => {
    const e = open('<p><a href="https://a.com" class="button">Go</a></p>');
    expect(hasEmailButtonNode(e)).toBe(true);
  });

  it('a valid single {{token}} button href still loads as a button node', () => {
    const e = open('<p><a href="{{link}}" class="button">Go</a></p>');
    expect(hasEmailButtonNode(e)).toBe(true);
  });
});
