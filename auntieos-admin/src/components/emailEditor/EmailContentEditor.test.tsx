// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';

vi.mock('../../api/emailImageUpload', async (orig) => ({
  ...(await orig<typeof import('../../api/emailImageUpload')>()),
  uploadEmailImage: vi.fn().mockResolvedValue('https://res.cloudinary.com/t/image/upload/pup.png'),
}));

import { EmailContentEditor } from './EmailContentEditor';
import { toEmailContent } from '../../lib/emailContent';

function setup(initialContent = '<p>word</p>', fields: string[] = ['displayName', 'link']) {
  const onChange = vi.fn();
  const view = render(
    <EmailContentEditor initialContent={initialContent} onChange={onChange} fields={fields} fieldsState="ready" />,
  );
  const dom = screen.getByRole('textbox', { name: 'Email content' }) as HTMLElement & { editor: Editor };
  const editor = dom.editor;
  const last = () => onChange.mock.calls.at(-1)?.[0] as string;
  return { editor, dom, onChange, last, view };
}
const tool = (name: string) => screen.getByRole('button', { name });
const selectWord = (editor: Editor) =>
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
  });
/** The document position just before the first text node that reads `text`. */
function posOf(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text === text) found = pos;
  });
  if (found === -1) throw new Error(`no text node "${text}"`);
  return found;
}

const LOOP = '<p>Your visits:</p><ul>{{#each visits}}<li>{{this.date}} at {{this.time}}</li>{{/each}}</ul><p>See you</p>';

describe('EmailContentEditor toolbar', () => {
  it('Bold and Italic wrap the selection and report pressed', async () => {
    const { editor, last } = setup();
    selectWord(editor);
    await userEvent.click(tool('Bold'));
    await userEvent.click(tool('Italic'));
    expect(last()).toBe('<p><strong><em>word</em></strong></p>');
    expect(tool('Bold')).toHaveAttribute('aria-pressed', 'true');
    expect(tool('Italic')).toHaveAttribute('aria-pressed', 'true');
    expect(tool('Heading')).toHaveAttribute('aria-pressed', 'false');
  });

  it('Ctrl+B and Ctrl+I work from the keyboard', () => {
    const { editor, dom, last } = setup();
    selectWord(editor);
    fireEvent.keyDown(dom, { key: 'b', code: 'KeyB', keyCode: 66, ctrlKey: true });
    fireEvent.keyDown(dom, { key: 'i', code: 'KeyI', keyCode: 73, ctrlKey: true });
    expect(last()).toBe('<p><strong><em>word</em></strong></p>');
    expect(tool('Bold')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Heading and Subheading make h2 and h3', async () => {
    const { editor, last } = setup();
    selectWord(editor);
    await userEvent.click(tool('Heading'));
    expect(last()).toBe('<h2>word</h2>');
    await userEvent.click(tool('Subheading'));
    expect(last()).toBe('<h3>word</h3>');
    expect(tool('Subheading')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Bulleted list, Numbered list and Callout', async () => {
    const { editor, last } = setup();
    selectWord(editor);
    await userEvent.click(tool('Bulleted list'));
    expect(last()).toBe('<ul><li>word</li></ul>');
    await userEvent.click(tool('Numbered list'));
    expect(last()).toBe('<ol><li>word</li></ol>');
    await userEvent.click(tool('Numbered list'));
    await userEvent.click(tool('Callout'));
    expect(last()).toBe('<blockquote><p>word</p></blockquote>');
    expect(tool('Callout')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Link is off until text is selected, then links it to a merge field', async () => {
    const { editor, last } = setup();
    expect(tool('Link')).toBeDisabled();
    selectWord(editor);
    await userEvent.click(tool('Link'));
    await userEvent.click(screen.getByLabelText('A merge field'));
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'link');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(last()).toBe('<p><a href="{{link}}">word</a></p>');
  });

  it('Link to a web address, then Remove link takes it off', async () => {
    const { editor, last } = setup();
    selectWord(editor);
    await userEvent.click(tool('Link'));
    await userEvent.type(screen.getByLabelText('Address'), 'tribetails.com/help');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(last()).toBe('<p><a href="https://tribetails.com/help">word</a></p>');
    act(() => {
      editor.commands.setTextSelection(3);
    });
    expect(tool('Link')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(tool('Link'));
    expect(screen.getByLabelText('Address')).toHaveValue('https://tribetails.com/help');
    await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(last()).toBe('<p>word</p>');
  });

  it('Button inserts a button', async () => {
    const { editor, last } = setup();
    act(() => {
      editor.commands.setTextSelection(5);
    });
    await userEvent.click(tool('Button'));
    await userEvent.type(screen.getByLabelText('Button text'), 'Reset password');
    await userEvent.click(screen.getByLabelText('A merge field'));
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'link');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(last()).toBe('<p>word</p><p><a href="{{link}}" class="button">Reset password</a></p>');
  });

  it('Button on a selected button edits it in place', async () => {
    const { editor, last } = setup('<p>word</p><p><a href="{{link}}" class="button">Go</a></p>');
    act(() => {
      editor.commands.setNodeSelection(7);
    });
    expect(tool('Button')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(tool('Button'));
    const text = screen.getByLabelText('Button text');
    expect(text).toHaveValue('Go');
    await userEvent.clear(text);
    await userEvent.type(text, 'Went');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(last()).toBe('<p>word</p><p><a href="{{link}}" class="button">Went</a></p>');
  });

  it('Image uploads and inserts', async () => {
    const { editor, last } = setup();
    act(() => {
      editor.commands.setTextSelection(5);
    });
    await userEvent.click(tool('Image'));
    await userEvent.upload(screen.getByLabelText('Image file'), new File(['x'], 'pup.png', { type: 'image/png' }));
    await userEvent.type(screen.getByLabelText('Description'), 'Pup');
    await userEvent.click(screen.getByRole('button', { name: 'Upload and insert' }));
    await vi.waitFor(() =>
      expect(last()).toBe('<p>word</p><p><img src="https://res.cloudinary.com/t/image/upload/pup.png" alt="Pup"></p>'),
    );
  });

  it('Insert field drops a chip that reads as the token', async () => {
    const { editor, last } = setup();
    act(() => {
      editor.commands.setTextSelection(5);
    });
    await userEvent.click(tool('Insert field'));
    await userEvent.click(screen.getByRole('button', { name: '{{displayName}}' }));
    expect(last()).toBe('<p>word{{displayName}}</p>');
    expect(screen.getByRole('textbox', { name: 'Email content' }).querySelector('.merge-chip')).toHaveTextContent(
      '{{displayName}}',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel on a dialog closes it and changes nothing', async () => {
    const { editor, onChange } = setup();
    act(() => {
      editor.commands.setTextSelection(5);
    });
    await userEvent.click(tool('Insert field'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a paste from Gmail lands as clean paragraphs, bold and https links kept', () => {
    const { editor, dom, last } = setup('<p>x</p>');
    act(() => {
      editor.commands.setTextSelection(2);
    });
    const html =
      '<div dir="ltr"><span style="font-family:arial;color:#222">Hi <b>there</b></span><div><br></div>' +
      '<div><a href="https://x.com" target="_blank">site</a> and <a href="http://y.com">old</a></div>' +
      '<img src="https://mail.google.com/x.png"><table><tr><td>cell<o:p></o:p></td></tr></table></div>';
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? 'Hi there site and old cell' : ''), types: ['text/html', 'text/plain'], files: [] },
    });
    act(() => {
      dom.dispatchEvent(paste);
    });
    expect(paste.defaultPrevented).toBe(true);
    // The first pasted paragraph joins the one the cursor is in, as any paste does.
    expect(last()).toBe('<p>xHi <strong>there</strong></p><p><a href="https://x.com">site</a> and old</p><p>cell</p>');
  });
  it('every tool has a name and a tooltip', () => {
    setup();
    const names = screen
      .getByRole('toolbar', { name: 'Formatting' })
      .querySelectorAll('button');
    expect(Array.from(names).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Bold',
      'Italic',
      'Heading',
      'Subheading',
      'Bulleted list',
      'Numbered list',
      'Callout',
      'Link',
      'Button',
      'Image',
      'Insert field',
    ]);
    for (const b of Array.from(names)) expect(b.getAttribute('title')).toBeTruthy();
  });

  it('loads stored content with chips and buttons in place', () => {
    setup('<p>Hi {{displayName}}</p><p><a href="{{link}}" class="button">Go</a></p>');
    const doc = screen.getByRole('textbox', { name: 'Email content' });
    expect(doc.querySelector('[data-merge-field="displayName"]')).not.toBeNull();
    expect(doc.querySelector('a.button')).toHaveTextContent('Go');
  });

  it('disabled locks the toolbar and the document', () => {
    render(<EmailContentEditor initialContent="<p>x</p>" onChange={vi.fn()} fields={[]} fieldsState="ready" disabled />);
    expect(tool('Bold')).toBeDisabled();
    expect(tool('Insert field')).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Email content' })).toHaveAttribute('contenteditable', 'false');
  });
});

describe('EmailContentEditor reports only real changes (ruling C4)', () => {
  it('mounting with stored content reports no change', () => {
    const { onChange } = setup(LOOP);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('locking and unlocking reports no change', () => {
    const onChange = vi.fn();
    const props = { initialContent: LOOP, onChange, fields: [], fieldsState: 'ready' as const };
    const { rerender } = render(<EmailContentEditor {...props} disabled />);
    rerender(<EmailContentEditor {...props} disabled={false} />);
    rerender(<EmailContentEditor {...props} disabled />);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Email content' })).toHaveAttribute('contenteditable', 'false');
  });
});

describe('EmailContentEditor and a repeating list', () => {
  it('marks the looped list with the field it repeats for', () => {
    const { dom } = setup(LOOP);
    expect(dom.querySelector('ul')).toHaveAttribute('data-each', 'visits');
  });

  it('inside the loop the list and block tools are off, and clicking them keeps the loop', async () => {
    const { editor, onChange } = setup(LOOP);
    act(() => {
      editor.commands.setTextSelection(posOf(editor, ' at ') + 1);
    });
    for (const name of ['Bulleted list', 'Numbered list', 'Heading', 'Subheading', 'Callout']) {
      expect(tool(name)).toHaveAttribute('aria-disabled', 'true');
      expect(tool(name).getAttribute('title')).toBe('Not available inside a repeating list');
      await userEvent.click(tool(name));
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(toEmailContent(editor.getHTML())).toBe(LOOP);
    // Text formatting still works inside the loop.
    expect(tool('Bold')).not.toHaveAttribute('aria-disabled');
  });

  it('outside the loop the list tools come back', () => {
    const { editor } = setup(LOOP);
    act(() => {
      editor.commands.setTextSelection(2);
    });
    expect(tool('Numbered list')).not.toHaveAttribute('aria-disabled');
    expect(tool('Numbered list')).toBeEnabled();
  });

  it('a selection that reaches into the loop counts as inside it', () => {
    const { editor } = setup(LOOP);
    act(() => {
      editor.commands.setTextSelection({ from: 2, to: posOf(editor, ' at ') + 2 });
    });
    expect(tool('Numbered list')).toHaveAttribute('aria-disabled', 'true');
  });

  it('Ctrl+Shift+7 inside the loop does not turn it into a numbered list', () => {
    const { editor, dom, onChange } = setup(LOOP);
    act(() => {
      editor.commands.setTextSelection(posOf(editor, ' at ') + 1);
    });
    fireEvent.keyDown(dom, { key: '7', code: 'Digit7', keyCode: 55, ctrlKey: true, shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(toEmailContent(editor.getHTML())).toBe(LOOP);
  });
});

describe('EmailContentEditor.css', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'EmailContentEditor.css'), 'utf8').replace(
    /\s+/g,
    ' ',
  );

  it('styles the Callout exactly as the email frame does (ruling C7)', () => {
    const rule = /\.email-editor__doc blockquote \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('border-left: 4px solid #df8431');
    expect(rule).toContain('background: #fff5f5');
    expect(rule).toContain('padding: 15px 20px');
    expect(rule).toContain('margin: 20px 0');
    expect(rule).toContain('border-radius: 0 4px 4px 0');
  });

  it('labels a looped list with the field it repeats for', () => {
    expect(css).toMatch(/ul\[data-each\]::before, \.email-editor__doc ol\[data-each\]::before \{[^}]*content: 'Repeats for each ' attr\(data-each\)/);
  });
});
