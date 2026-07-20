import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import {
  generateAssist,
  getMyConversation,
  mapGenerateError,
  mapSendMessageError,
  markThreadRead,
  sendKinfolkMessage,
  type GenerateAssistMode,
  type ThreadMessageDto,
} from '../api/messagesApi';
import { useConversationMessages } from '../lib/messagesListener';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav, type PortalNavTab } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import '../styles/messages.css';

/**
 * Message Auntie: two-way household conversation with the auntie. Ported
 * from MessageAuntieScreen.kt's layout (thread oldest-first, kinfolk's own
 * bubbles align right with a "Sent"/"Seen" receipt; the auntie's align
 * left) — no mockup exists for this screen, so the visual language below
 * (glass card, tribe-gradient send button, mono meta labels) is composed
 * from the same design tokens every other S3 screen uses, not invented.
 *
 * Data flow (new for S5, no Kotlin backend precedent to mirror 1:1):
 *   - getMyConversation seeds the thread AND marks every unread auntie
 *     message read server-side as a side effect (see messagesApi.ts).
 *   - useConversationMessages subscribes to the same Firestore path in
 *     realtime (lib/messagesListener.ts, same shape as breadcrumbs.ts) so a
 *     reply from the auntie appears live, no polling. Once the first
 *     snapshot arrives it becomes the render source of truth; before that,
 *     the query result is shown.
 *   - Mark-read for messages that arrive *after* the initial load (i.e.
 *     ones getMyConversation's own side effect never saw) is explicit:
 *     whenever the live list contains an unread auntie message and the tab
 *     is visible/focused, markThreadRead is called once (guarded by
 *     `markInFlightRef` so a burst of snapshots can't fire it twice, and by
 *     the readAt!==null check itself so a message already marked by either
 *     path is never re-marked).
 *
 * PortalNav has no 'messages' tab yet (nav wiring is the integrator's job
 * per this build's brief) — passed a value outside PortalNavTab's union so
 * no existing tab lights up as falsely active; add 'messages' to
 * PortalNavTab + NAV_LINKS/TAB_ITEMS when wiring the route.
 */
const MESSAGES_NAV_TAB = 'messages' as PortalNavTab;

type ToolbarActionId = 'bold' | 'italic' | 'underline' | 'bulletList' | 'orderedList' | 'blockquote' | 'link';

interface ToolbarActionDef {
  id: ToolbarActionId;
  label: string;
  glyph: string;
}

/**
 * Exactly the 7 formatting actions the backend allowlist supports
 * (functions/src/lib/richText.ts ALLOWED_TAGS: b/strong, i/em, u, ul/ol/li,
 * blockquote, a). Deliberately nothing else — no headings, images, colors,
 * or alignment, since the server would silently strip them anyway.
 */
export const TOOLBAR_ACTIONS: ToolbarActionDef[] = [
  { id: 'bold', label: 'Bold', glyph: 'B' },
  { id: 'italic', label: 'Italic', glyph: 'I' },
  { id: 'underline', label: 'Underline', glyph: 'U' },
  { id: 'bulletList', label: 'Bulleted list', glyph: '\u{2022}' },
  { id: 'orderedList', label: 'Numbered list', glyph: '1.' },
  { id: 'blockquote', label: 'Quote', glyph: '\u{201C}' },
  { id: 'link', label: 'Link', glyph: '\u{1F517}' },
];

/**
 * Normalizes a raw link-prompt string into an href the server will accept
 * (sanitizeRichText only keeps http/https/mailto). Bare domains/emails get
 * a scheme prefixed rather than silently dropped — better UX than telling a
 * kinfolk to type "https://" themselves. Returns null for blank/unusable
 * input so the caller can no-op instead of inserting a dead link.
 */
export function normalizeLinkHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

function applyToolbarAction(editor: Editor, id: ToolbarActionId, promptForLink: () => string | null): void {
  const chain = editor.chain().focus();
  switch (id) {
    case 'bold':
      chain.toggleBold().run();
      return;
    case 'italic':
      chain.toggleItalic().run();
      return;
    case 'underline':
      chain.toggleUnderline().run();
      return;
    case 'bulletList':
      chain.toggleBulletList().run();
      return;
    case 'orderedList':
      chain.toggleOrderedList().run();
      return;
    case 'blockquote':
      chain.toggleBlockquote().run();
      return;
    case 'link': {
      if (editor.isActive('link')) {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
        return;
      }
      const raw = promptForLink();
      if (raw === null) return;
      const href = normalizeLinkHref(raw);
      if (href === null) return;
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
      return;
    }
  }
}

function shortTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function Messages() {
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  const threadQuery = useQuery({
    queryKey: ['myConversation', kinfolkId],
    queryFn: () => getMyConversation(kinfolkId),
  });
  const liveMessages = useConversationMessages(kinfolkId ?? null);
  const messages: ThreadMessageDto[] = liveMessages ?? threadQuery.data?.messages ?? [];

  const [sendError, setSendError] = useState<string | null>(null);
  const sendMutation = useMutation({
    mutationFn: (body: string) => sendKinfolkMessage(body, kinfolkId),
  });

  // O-8 writing helper. One mutation for both modes — the pending mode
  // (assistMutation.variables) drives which button shows its busy label.
  // 'polish' sends the current draft; 'suggest_reply' sends no body at all,
  // the server reads the thread itself.
  const [assistError, setAssistError] = useState<string | null>(null);
  const assistMutation = useMutation({
    mutationFn: ({ mode, body }: { mode: GenerateAssistMode; body?: string }) =>
      generateAssist(mode, body, kinfolkId),
  });

  // Explicit mark-read for messages the realtime listener delivers after the
  // initial getMyConversation load (see the file-header comment). Guarded so
  // a burst of onSnapshot deliveries can't fire concurrent calls, and
  // naturally idempotent since it only fires while an unread auntie message
  // still has readAt === null.
  const markInFlightRef = useRef(false);
  useEffect(() => {
    if (!kinfolkId || liveMessages === null) return;
    const hasUnread = liveMessages.some((m) => m.senderRole === 'auntie' && m.readAt === null);
    if (!hasUnread || markInFlightRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    markInFlightRef.current = true;
    void markThreadRead(kinfolkId)
      .catch(() => {
        // best-effort — a failed mark-read never blocks reading the thread
      })
      .finally(() => {
        markInFlightRef.current = false;
      });
  }, [liveMessages, kinfolkId]);

  // Retry the same mark-read when the tab regains focus/visibility, in case
  // the effect above skipped a delivery that arrived while backgrounded.
  useEffect(() => {
    if (!kinfolkId || typeof document === 'undefined') return;
    function retryIfUnread() {
      if (document.hidden || markInFlightRef.current) return;
      const hasUnread = (liveMessages ?? []).some((m) => m.senderRole === 'auntie' && m.readAt === null);
      if (!hasUnread) return;
      markInFlightRef.current = true;
      void markThreadRead(kinfolkId)
        .catch(() => {})
        .finally(() => {
          markInFlightRef.current = false;
        });
    }
    document.addEventListener('visibilitychange', retryIfUnread);
    window.addEventListener('focus', retryIfUnread);
    return () => {
      document.removeEventListener('visibilitychange', retryIfUnread);
      window.removeEventListener('focus', retryIfUnread);
    };
  }, [liveMessages, kinfolkId]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  useEffect(() => {
    if (typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ block: 'end' });
    }
  }, [lastMessageId]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        code: false,
        link: false,
        underline: false,
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: false }),
    ],
    content: '',
    editorProps: {
      attributes: { 'aria-label': 'Message', class: 'msgs-editorbody-inner' },
    },
  });

  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      const e = ctx.editor;
      if (!e) return null;
      return {
        isEmpty: e.isEmpty,
        active: {
          bold: e.isActive('bold'),
          italic: e.isActive('italic'),
          underline: e.isActive('underline'),
          bulletList: e.isActive('bulletList'),
          orderedList: e.isActive('orderedList'),
          blockquote: e.isActive('blockquote'),
          link: e.isActive('link'),
        },
      };
    },
  });

  const { signOut, signingOut } = useSignOut();

  function handleSend() {
    if (!editor || !editorState || editorState.isEmpty || sendMutation.isPending) return;
    const html = editor.getHTML();
    sendMutation.mutate(html, {
      onSuccess: () => {
        setSendError(null);
        editor.commands.clearContent();
        // Belt-and-suspenders alongside the realtime listener: refetch the
        // query-backed thread too, so the new message still shows up even
        // if the Firestore listener hasn't delivered its next snapshot yet
        // (or never connects, e.g. rules/network hiccup).
        void queryClient.invalidateQueries({ queryKey: ['myConversation', kinfolkId] });
      },
      // Explicit onError here (not a silent no-op / relying on an unused
      // rejected promise) — this is exactly the bug KinTales' comment
      // composer had before its fix (see submitTop/submitReply in
      // KinTales.tsx): a failed post must surface inline, and the draft
      // must stay in the composer so "try again" is just a re-click.
      onError: (err) => {
        setSendError(mapSendMessageError(err));
      },
    });
  }

  function handleAssist(mode: GenerateAssistMode) {
    if (!editor || assistMutation.isPending) return;
    if (mode === 'polish' && (!editorState || editorState.isEmpty)) return;
    assistMutation.mutate(
      { mode, ...(mode === 'polish' ? { body: editor.getHTML() } : {}) },
      {
        onSuccess: (result) => {
          setAssistError(null);
          // result.html is constrained server-side to the same allowlist as
          // message bodies, so loading it into the composer is safe — and
          // the send path re-sanitizes anyway (see sendKinfolkMessage).
          editor.commands.setContent(result.html);
          editor.commands.focus();
        },
        // Same rule as handleSend's onError: a failed helper call surfaces
        // inline and never touches the draft, so "try again" is a re-click.
        onError: (err) => {
          setAssistError(mapGenerateError(err));
        },
      },
    );
  }

  const noThreadYet = messages.length === 0;
  const assistBusy = assistMutation.isPending;
  const assistPendingMode = assistBusy ? assistMutation.variables?.mode : undefined;

  return (
    <>
      <PortalNav active={MESSAGES_NAV_TAB} />

      <div className="wrap">
        <header className="pagehead">
          <div className="htext">
            <div className="kick">Direct line to your Auntie</div>
            <h1>
              Message <span>Auntie</span>
            </h1>
          </div>
        </header>

        <section className="glass msgs-card" aria-label="Conversation with your Auntie">
          <div className="msgs-thread" data-testid="msgs-thread">
            {threadQuery.isLoading && liveMessages === null ? (
              <p className="sub">Loading your messages…</p>
            ) : threadQuery.isError && liveMessages === null && noThreadYet ? (
              <LaunchError
                onRetry={() => void threadQuery.refetch()}
                retrying={threadQuery.isRefetching}
                onSignOut={signOut} signingOut={signingOut}
              />
            ) : noThreadYet ? (
              <div className="msgs-empty">
                <div className="ehug">{'\u{1F44B}'}</div>
                <h3>No messages yet</h3>
                <p>Say hello — your Auntie will see this and reply right here.</p>
              </div>
            ) : (
              messages.map((message) => <MessageBubble key={message.id} message={message} />)
            )}
            <div ref={bottomRef} />
          </div>

          {sendError && (
            <div className="msgs-senderror" role="alert">
              <span>{sendError}</span>
              <button type="button" className="msgs-dismiss" onClick={() => setSendError(null)} aria-label="Dismiss">
                {'\u{2715}'}
              </button>
            </div>
          )}

          {assistError && (
            <div className="msgs-senderror" role="alert">
              <span>{assistError}</span>
              <button
                type="button"
                className="msgs-dismiss"
                onClick={() => setAssistError(null)}
                aria-label="Dismiss"
              >
                {'\u{2715}'}
              </button>
            </div>
          )}

          <div className="msgs-composer">
            <div className="msgs-toolbar" data-testid="composer-toolbar" role="toolbar" aria-label="Formatting">
              {TOOLBAR_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={editorState?.active[action.id] ? 'on' : ''}
                  aria-label={action.label}
                  aria-pressed={editorState?.active[action.id] ?? false}
                  disabled={!editor}
                  onClick={() =>
                    editor && applyToolbarAction(editor, action.id, () => window.prompt('Link URL') ?? null)
                  }
                >
                  {action.glyph}
                </button>
              ))}
            </div>

            {editor ? (
              <EditorContent editor={editor} className="msgs-editorbody" data-testid="composer-editor" />
            ) : (
              <p className="sub">Loading composer…</p>
            )}

            <div className="msgs-composer-foot">
              <span className="sub">Your Auntie sees this as soon as you send it.</span>
              <button
                type="button"
                className="btn ghost"
                disabled={!editor || !editorState || editorState.isEmpty || assistBusy}
                onClick={() => handleAssist('polish')}
              >
                {assistPendingMode === 'polish' ? 'Polishing…' : 'Polish'}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={!editor || assistBusy || messages.length === 0}
                onClick={() => handleAssist('suggest_reply')}
              >
                {assistPendingMode === 'suggest_reply' ? 'Thinking…' : 'Suggest reply'}
              </button>
              <button
                type="button"
                className="btn grad"
                disabled={!editor || !editorState || editorState.isEmpty || sendMutation.isPending}
                onClick={handleSend}
              >
                {sendMutation.isPending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </section>

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}

function MessageBubble(props: { message: ThreadMessageDto }) {
  const { message } = props;
  // Role-based, not uid-based: matches MessageAuntieScreen.kt exactly — the
  // household thread is shared by every kinfolk member (primary + any
  // secondary with messaging_direct), so "mine" means "sent by our side",
  // not "sent by this exact signed-in uid".
  const mine = message.senderRole === 'kinfolk';

  return (
    <div className={`msgs-row ${mine ? 'mine' : 'theirs'}`} data-sender={message.senderRole}>
      <div className="msgs-bubble">
        <div className="msgs-meta">
          <b>{mine ? 'You' : 'Auntie'}</b>
          <time>{shortTime(message.createdAtMs)}</time>
        </div>
        {/*
          Trust boundary: message.body is sanitizeRichText'd server-side on
          every write path into this field (functions/src/lib/richText.ts),
          allowlisting only b/strong, i/em, u, p, br, ul, ol, li, blockquote,
          a[href]. Rendering it as HTML here is the intended behavior for
          THIS field only — no other field in this screen (or introduced by
          this build) uses dangerouslySetInnerHTML.
        */}
        <div className="msgs-body" dangerouslySetInnerHTML={{ __html: message.body }} />
        {mine && <div className="msgs-receipt">{message.readAt !== null ? 'Seen' : 'Sent'}</div>}
      </div>
    </div>
  );
}
