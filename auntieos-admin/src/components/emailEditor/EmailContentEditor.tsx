import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { emailEditorExtensions, loopedListName, type EmailButtonAttrs } from './extensions';
import { fromEmailContent, toEmailContent } from '../../lib/emailContent';
import { FieldDialog, ImageDialog, TargetDialog } from './EmailEditorDialogs';
import './EmailContentEditor.css';

type Panel = null | 'link' | 'button' | 'image' | 'field';

export interface EmailContentEditorProps {
  /** Stored content. Read once, at mount; remount with a new `key` to replace it. */
  initialContent: string;
  /** Called with stored-shape content after every change the operator makes. */
  onChange: (content: string) => void;
  fields: readonly string[];
  fieldsState: 'loading' | 'ready' | 'error';
  fieldsNote?: string | undefined;
  disabled?: boolean | undefined;
}

interface Tool {
  label: string;
  glyph: string;
  pressed?: boolean;
  /** Off with the `disabled` attribute (nothing to act on yet). */
  off?: boolean;
  /** Off with `aria-disabled`, and its tooltip says why (a repeating list). */
  lockedBy?: string | null;
  onClick: () => void;
}

/**
 * #953: the visual email editor. TipTap set up the way the portal's Messages
 * composer is (`mytribe/web/src/screens/Messages.tsx`), with the schema from
 * `extensions.ts`. It reports stored content, never editor HTML, so the
 * screen that holds it never has to know the difference.
 */
export function EmailContentEditor({
  initialContent,
  onChange,
  fields,
  fieldsState,
  fieldsNote,
  disabled = false,
}: EmailContentEditorProps) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const [panel, setPanel] = useState<Panel>(null);

  // useEditor below builds the editor once (no deps array), so a plain
  // closure over `disabled` inside editorProps would freeze at mount time,
  // same reasoning as onChangeRef above: keep the live value in a ref.
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  const editor = useEditor({
    extensions: emailEditorExtensions(),
    content: fromEmailContent(initialContent),
    editable: !disabled,
    onUpdate: ({ editor: e }) => onChangeRef.current(toEmailContent(e.getHTML())),
    editorProps: {
      attributes: { 'aria-label': 'Email content', role: 'textbox', 'aria-multiline': 'true', class: 'email-editor__doc' },
      handleDOMEvents: {
        // A locked body (bodyLocked, or `saving`) still renders real <a>
        // elements: ProseMirror's non-editable mode stops typing, not
        // navigation. Without this a click on a link or button in the body
        // follows the href out of the admin instead of doing nothing.
        click: (_view, event) => {
          if (!disabledRef.current) return false;
          const target = event.target as HTMLElement | null;
          if (target?.closest('a')) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });

  // Ruling C4: `false` so locking or unlocking emits no update. With the
  // default, opening a template would report the editor's serialization as an
  // edit before the operator touched anything.
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            link: e.isActive('link'),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            callout: e.isActive('blockquote'),
            button: e.isActive('emailButton'),
            loop: loopedListName(e.state),
            hasSelection: !e.state.selection.empty,
            linkHref: (e.getAttributes('link')['href'] as string | undefined) ?? '',
            buttonAttrs: e.getAttributes('emailButton') as Partial<EmailButtonAttrs>,
          }
        : null,
  });

  const loop = s?.loop ?? null;
  const run = (fn: (e: Editor) => void) => () => {
    if (editor) fn(editor);
  };
  // A block tool inside a repeating list would rebuild or split the list and
  // lose its loop (see LoopedListGuard), so it does nothing there.
  const block = (fn: (e: Editor) => void) => () => {
    if (editor && loop === null) fn(editor);
  };
  const close = () => setPanel(null);

  const tools: Tool[] = [
    { label: 'Bold', glyph: 'B', pressed: s?.bold ?? false, onClick: run((e) => e.chain().focus().toggleBold().run()) },
    { label: 'Italic', glyph: 'I', pressed: s?.italic ?? false, onClick: run((e) => e.chain().focus().toggleItalic().run()) },
    {
      label: 'Heading',
      glyph: 'H2',
      pressed: s?.h2 ?? false,
      lockedBy: loop,
      onClick: block((e) => e.chain().focus().toggleHeading({ level: 2 }).run()),
    },
    {
      label: 'Subheading',
      glyph: 'H3',
      pressed: s?.h3 ?? false,
      lockedBy: loop,
      onClick: block((e) => e.chain().focus().toggleHeading({ level: 3 }).run()),
    },
    {
      label: 'Bulleted list',
      glyph: '•',
      pressed: s?.bullet ?? false,
      lockedBy: loop,
      onClick: block((e) => e.chain().focus().toggleBulletList().run()),
    },
    {
      label: 'Numbered list',
      glyph: '1.',
      pressed: s?.ordered ?? false,
      lockedBy: loop,
      onClick: block((e) => e.chain().focus().toggleOrderedList().run()),
    },
    {
      label: 'Callout',
      glyph: '“',
      pressed: s?.callout ?? false,
      lockedBy: loop,
      onClick: block((e) => e.chain().focus().toggleBlockquote().run()),
    },
    { label: 'Link', glyph: 'Link', pressed: s?.link ?? false, off: !(s?.hasSelection || s?.link), onClick: () => setPanel('link') },
    { label: 'Button', glyph: 'Button', pressed: s?.button ?? false, onClick: () => setPanel('button') },
    { label: 'Image', glyph: 'Image', onClick: () => setPanel('image') },
    { label: 'Insert field', glyph: '{{ }}', onClick: () => setPanel('field') },
  ];

  function tooltip(t: Tool): string {
    if (t.lockedBy) return 'Not available inside a repeating list';
    if (t.label === 'Link' && t.off) return 'Select some text first';
    return t.label;
  }

  return (
    <div className="email-editor">
      <div className="email-editor__toolbar" role="toolbar" aria-label="Formatting">
        {tools.map((t) => (
          <button
            key={t.label}
            type="button"
            className="email-editor__tool"
            aria-label={t.label}
            title={tooltip(t)}
            {...(t.pressed !== undefined ? { 'aria-pressed': t.pressed } : {})}
            {...(t.lockedBy ? { 'aria-disabled': true } : {})}
            disabled={disabled || !editor || t.off === true}
            // Keep the editor's selection through the click, as Messages does.
            onMouseDown={(e) => e.preventDefault()}
            onClick={t.onClick}
          >
            {t.glyph}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} className="email-editor__content" />

      {panel === 'link' && editor ? (
        <TargetDialog
          title="Link"
          withLabel={false}
          allowMailto
          fields={fields}
          initial={{ label: '', href: s?.linkHref ?? '' }}
          onSubmit={({ href }) => {
            editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
            close();
          }}
          onRemove={
            s?.link
              ? () => {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run();
                  close();
                }
              : undefined
          }
          onClose={close}
        />
      ) : null}
      {panel === 'button' && editor ? (
        <TargetDialog
          title="Button"
          withLabel
          allowMailto={false}
          fields={fields}
          initial={{ label: s?.buttonAttrs.label ?? '', href: s?.buttonAttrs.href ?? '' }}
          onSubmit={(attrs) => {
            if (s?.button) editor.chain().focus().updateEmailButton(attrs).run();
            else editor.chain().focus().insertEmailButton(attrs).run();
            close();
          }}
          onClose={close}
        />
      ) : null}
      {panel === 'image' && editor ? (
        <ImageDialog
          onInsert={(img) => {
            editor.chain().focus().insertEmailImage(img).run();
            close();
          }}
          onClose={close}
        />
      ) : null}
      {panel === 'field' && editor ? (
        <FieldDialog
          fields={fields}
          state={fieldsState}
          note={fieldsNote}
          onPick={(name) => {
            editor.chain().focus().insertMergeField(name).run();
            close();
          }}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
