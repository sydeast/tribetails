// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { emailEditorExtensions } from './extensions';
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
