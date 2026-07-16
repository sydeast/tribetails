// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { useEffect, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { Messages, TOOLBAR_ACTIONS, normalizeLinkHref } from './Messages';
import { mapGenerateError } from '../api/messagesApi';
import type { GetMyConversationResult, ThreadMessageDto } from '../api/messagesApi';
import { CallableTimeoutError } from '../lib/fns';

// ── mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getMyConversation: vi.fn(),
  sendKinfolkMessage: vi.fn(),
  markThreadRead: vi.fn(),
  generateAssist: vi.fn(),
  useConversationMessages: vi.fn(),
  useNavigate: vi.fn(),
  signOut: vi.fn(),
  useSignOut: vi.fn(),
}));

vi.mock('../api/messagesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/messagesApi')>('../api/messagesApi');
  return {
    ...actual,
    getMyConversation: mocks.getMyConversation,
    sendKinfolkMessage: mocks.sendKinfolkMessage,
    markThreadRead: mocks.markThreadRead,
    generateAssist: mocks.generateAssist,
    // mapGenerateError / mapSendMessageError stay REAL (via ...actual) so
    // the error-banner tests exercise the actual code-to-copy mapping.
  };
});

vi.mock('../lib/messagesListener', () => ({
  useConversationMessages: mocks.useConversationMessages,
}));

vi.mock('../lib/activeTribe', () => ({
  getActiveKinfolkId: () => 'k1',
}));

vi.mock('../lib/auth', () => ({
  signOut: mocks.signOut,
  useSignOut: () => ({ signOut: mocks.signOut, signingOut: false }),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: mocks.useNavigate,
}));

vi.mock('../components/PortalNav', () => ({
  PortalNav: () => null,
}));

/**
 * Fake TipTap editor: a real ProseMirror instance can't type-simulate
 * reliably in jsdom (no layout/selection engine), and that's not what this
 * screen's own code needs to prove anyway — we own the send/toolbar wiring,
 * not TipTap's internals. The fake tracks an HTML string tests can seed
 * directly (mimicking "the kinfolk already typed something") and records
 * every chain command invoked so toolbar-click tests can assert on intent.
 */
interface FakeChain {
  focus: () => FakeChain;
  toggleBold: () => FakeChain;
  toggleItalic: () => FakeChain;
  toggleUnderline: () => FakeChain;
  toggleBulletList: () => FakeChain;
  toggleOrderedList: () => FakeChain;
  toggleBlockquote: () => FakeChain;
  extendMarkRange: () => FakeChain;
  setLink: (attrs: { href: string }) => FakeChain;
  unsetLink: () => FakeChain;
  run: () => void;
}

function makeFakeEditor(initialHtml = '') {
  let html = initialHtml;
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  function notify() {
    listeners.forEach((l) => l());
  }
  const chain = (): FakeChain => {
    const c: FakeChain = {
      focus: () => (calls.push('focus'), c),
      toggleBold: () => (calls.push('toggleBold'), c),
      toggleItalic: () => (calls.push('toggleItalic'), c),
      toggleUnderline: () => (calls.push('toggleUnderline'), c),
      toggleBulletList: () => (calls.push('toggleBulletList'), c),
      toggleOrderedList: () => (calls.push('toggleOrderedList'), c),
      toggleBlockquote: () => (calls.push('toggleBlockquote'), c),
      extendMarkRange: () => (calls.push('extendMarkRange'), c),
      setLink: (attrs) => (calls.push(`setLink:${attrs.href}`), c),
      unsetLink: () => (calls.push('unsetLink'), c),
      run: () => calls.push('run'),
    };
    return c;
  };
  return {
    calls,
    setHtml: (next: string) => {
      html = next;
      notify();
    },
    getHTML: () => html,
    get isEmpty() {
      return html.trim().length === 0 || html === '<p></p>';
    },
    isActive: () => false,
    chain,
    commands: {
      clearContent: () => {
        html = '';
        notify();
      },
      setContent: (next: string) => {
        calls.push(`setContent:${next}`);
        html = next;
        notify();
      },
      focus: () => {
        calls.push('commands.focus');
      },
    },
    // Test-only: mirrors TipTap's real editor emitting 'transaction' events,
    // which is what makes the real useEditorState hook reactive. Without
    // this, mutating the fake editor's html wouldn't trigger a re-render and
    // the Send button's disabled state would never update in tests.
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

let fakeEditor: ReturnType<typeof makeFakeEditor>;

vi.mock('@tiptap/react', () => ({
  useEditor: () => fakeEditor as unknown as Editor,
  useEditorState: (opts: { editor: Editor | null; selector: (ctx: { editor: Editor | null }) => unknown }) => {
    const [, forceRender] = useState(0);
    useEffect(() => {
      const e = opts.editor as unknown as { subscribe?: (fn: () => void) => () => void } | null;
      return e?.subscribe?.(() => forceRender((n) => n + 1));
    }, [opts.editor]);
    return opts.editor ? opts.selector({ editor: opts.editor }) : null;
  },
  EditorContent: (props: { 'data-testid'?: string }) => (
    <div data-testid={props['data-testid'] ?? 'composer-editor'} />
  ),
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => 'starter-kit-configured' },
}));
vi.mock('@tiptap/extension-underline', () => ({ default: 'underline-extension' }));
vi.mock('@tiptap/extension-link', () => ({
  default: { configure: () => 'link-extension-configured' },
}));

// ── fixtures ─────────────────────────────────────────────────────────────

function message(overrides: Partial<ThreadMessageDto>): ThreadMessageDto {
  return {
    id: 'm1',
    senderRole: 'auntie',
    senderUid: 'auntie-uid',
    body: '<p>hi</p>',
    createdAtMs: 1_700_000_000_000,
    deliveredAt: 1_700_000_000_000,
    readAt: null,
    ...overrides,
  };
}

function conversationResult(messages: ThreadMessageDto[]): GetMyConversationResult {
  return { ok: true, kinfolkId: 'k1', messages };
}

function renderScreen(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<Messages />, { wrapper: Wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeEditor = makeFakeEditor();
  mocks.useConversationMessages.mockReturnValue(null);
  mocks.useNavigate.mockReturnValue(vi.fn());
  mocks.markThreadRead.mockResolvedValue({ ok: true, kinfolkId: 'k1', markedCount: 0 });
});

afterEach(() => {
  cleanup();
});

// ── tests ────────────────────────────────────────────────────────────────

describe('Messages thread', () => {
  it('renders messages oldest-first and renders an allowed tag (<strong>) as real HTML, not literal text', async () => {
    mocks.getMyConversation.mockResolvedValue(
      conversationResult([
        message({ id: 'm1', senderRole: 'auntie', body: '<p>First</p>', createdAtMs: 1 }),
        message({ id: 'm2', senderRole: 'kinfolk', body: '<p>Hello <strong>world</strong></p>', createdAtMs: 2 }),
      ]),
    );

    renderScreen();

    await screen.findByText('First');
    const bolded = await screen.findByText('world');
    expect(bolded.tagName).toBe('STRONG');
    expect(screen.queryByText('<strong>world</strong>', { exact: false })).not.toBeInTheDocument();

    // oldest-first: "First" (auntie, createdAtMs 1) must appear before "Hello" (kinfolk, createdAtMs 2)
    const thread = screen.getByTestId('msgs-thread');
    const text = thread.textContent ?? '';
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Hello'));
  });

  it('shows an empty state when the thread has no messages', async () => {
    mocks.getMyConversation.mockResolvedValue(conversationResult([]));
    renderScreen();
    await screen.findByText('No messages yet');
  });

  it('shows "Sent" on a kinfolk bubble with no readAt, "Seen" once readAt is set, and neither on an auntie bubble', async () => {
    mocks.getMyConversation.mockResolvedValue(
      conversationResult([
        message({ id: 'm1', senderRole: 'kinfolk', body: '<p>unread by auntie</p>', readAt: null, createdAtMs: 1 }),
        message({ id: 'm2', senderRole: 'kinfolk', body: '<p>read by auntie</p>', readAt: 999, createdAtMs: 2 }),
        message({ id: 'm3', senderRole: 'auntie', body: '<p>from auntie</p>', readAt: null, createdAtMs: 3 }),
      ]),
    );
    renderScreen();

    await screen.findByText('unread by auntie');
    expect(screen.getAllByText('Sent')).toHaveLength(1);
    expect(screen.getAllByText('Seen')).toHaveLength(1);

    // the auntie's own bubble never gets a Sent/Seen receipt
    const auntieBubble = screen.getByText('from auntie').closest('.msgs-bubble');
    expect(auntieBubble?.textContent).not.toMatch(/Sent|Seen/);
  });
});

describe('Messages composer', () => {
  it('exposes exactly the 7 allowed formatting actions and nothing else', () => {
    expect(TOOLBAR_ACTIONS.map((a) => a.id)).toEqual([
      'bold',
      'italic',
      'underline',
      'bulletList',
      'orderedList',
      'blockquote',
      'link',
    ]);

    mocks.getMyConversation.mockResolvedValue(conversationResult([]));
    renderScreen();
    const toolbar = screen.getByTestId('composer-toolbar');
    const buttons = toolbar.querySelectorAll('button');
    expect(buttons).toHaveLength(7);
  });

  it('sends via sendKinfolkMessage with the composer HTML and clears the draft on success', async () => {
    mocks.getMyConversation.mockResolvedValue(conversationResult([]));
    mocks.sendKinfolkMessage.mockResolvedValue({ ok: true, kinfolkId: 'k1', messageId: 'new-1' });
    renderScreen();

    await screen.findByText('No messages yet');
    act(() => fakeEditor.setHtml('<p>Hello there</p>'));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mocks.sendKinfolkMessage).toHaveBeenCalledWith('<p>Hello there</p>', 'k1'));
    await waitFor(() => expect(fakeEditor.getHTML()).toBe(''));
  });

  it('surfaces a distinct inline error on a rejected send instead of failing silently', async () => {
    mocks.getMyConversation.mockResolvedValue(conversationResult([]));
    mocks.sendKinfolkMessage.mockRejectedValue(new FirebaseError('functions/failed-precondition', 'chat_disabled'));
    renderScreen();

    await screen.findByText('No messages yet');
    act(() => fakeEditor.setHtml('<p>Hello</p>'));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('Messaging is turned off right now. Please reach out another way.');
    // the draft is not silently cleared on a failed send — the kinfolk can just retry
    expect(fakeEditor.getHTML()).toBe('<p>Hello</p>');
  });

  it('maps message_too_long and rate_limited to distinct, non-generic copy', async () => {
    mocks.getMyConversation.mockResolvedValue(conversationResult([]));
    renderScreen();
    await screen.findByText('No messages yet');

    mocks.sendKinfolkMessage.mockRejectedValueOnce(
      new FirebaseError('functions/invalid-argument', 'message_too_long'),
    );
    act(() => fakeEditor.setHtml('<p>Long</p>'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('That message is too long. Trim it a little and try sending again.');

    mocks.sendKinfolkMessage.mockRejectedValueOnce(new FirebaseError('functions/resource-exhausted', 'rate_limited'));
    act(() => fakeEditor.setHtml('<p>Again</p>'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText("You're sending messages a little too fast. Wait a bit and try again.");
  });
});

describe('Messages writing helper (O-8)', () => {
  it('polishes the draft: calls generateAssist with the composer HTML and loads the result back in', async () => {
    mocks.getMyConversation.mockResolvedValue(conversationResult([]));
    mocks.generateAssist.mockResolvedValue({
      ok: true,
      mode: 'polish',
      html: '<p>Polished draft</p>',
      text: 'Polished draft',
    });
    renderScreen();

    await screen.findByText('No messages yet');
    act(() => fakeEditor.setHtml('<p>rough draft</p>'));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Polish' }));

    await waitFor(() => expect(mocks.generateAssist).toHaveBeenCalledWith('polish', '<p>rough draft</p>', 'k1'));
    await waitFor(() => expect(fakeEditor.calls).toContain('setContent:<p>Polished draft</p>'));
    expect(fakeEditor.getHTML()).toBe('<p>Polished draft</p>');
    expect(fakeEditor.calls).toContain('commands.focus');
  });

  it('suggests a reply with an empty draft: sends no body (the server reads the thread itself)', async () => {
    mocks.getMyConversation.mockResolvedValue(
      conversationResult([message({ id: 'm1', senderRole: 'auntie', body: '<p>How is Biscuit?</p>' })]),
    );
    mocks.generateAssist.mockResolvedValue({
      ok: true,
      mode: 'suggest_reply',
      html: '<p>Biscuit is doing great.</p>',
      text: 'Biscuit is doing great.',
    });
    renderScreen();

    await screen.findByText('How is Biscuit?');
    expect(fakeEditor.isEmpty).toBe(true);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Suggest reply' }));

    await waitFor(() => expect(mocks.generateAssist).toHaveBeenCalledWith('suggest_reply', undefined, 'k1'));
    await waitFor(() => expect(fakeEditor.getHTML()).toBe('<p>Biscuit is doing great.</p>'));
  });

  it('surfaces the rate-limit copy in an inline alert and keeps the draft when generateAssist rejects', async () => {
    mocks.getMyConversation.mockResolvedValue(conversationResult([]));
    mocks.generateAssist.mockRejectedValue(new FirebaseError('functions/resource-exhausted', 'rate_limited'));
    renderScreen();

    await screen.findByText('No messages yet');
    act(() => fakeEditor.setHtml('<p>my draft</p>'));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Polish' }));

    await screen.findByText("You've used the writing helper a lot this hour. Please try again later.");
    // the draft is never touched by a failed helper call — retry is a re-click
    expect(fakeEditor.getHTML()).toBe('<p>my draft</p>');
  });

  it('disables Polish while the draft is empty, and Suggest reply while the thread is empty', async () => {
    mocks.getMyConversation.mockResolvedValue(conversationResult([]));
    renderScreen();
    await screen.findByText('No messages yet');

    expect(screen.getByRole('button', { name: 'Polish' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Suggest reply' })).toBeDisabled();

    act(() => fakeEditor.setHtml('<p>now there is a draft</p>'));
    expect(screen.getByRole('button', { name: 'Polish' })).toBeEnabled();
    // still nothing to reply to
    expect(screen.getByRole('button', { name: 'Suggest reply' })).toBeDisabled();
  });
});

describe('mapGenerateError', () => {
  it('passes a CallableTimeoutError message through as-is', () => {
    const err = new CallableTimeoutError('generate');
    expect(mapGenerateError(err)).toBe(err.message);
  });

  it('maps resource-exhausted to the hourly-cap copy', () => {
    expect(mapGenerateError(new FirebaseError('functions/resource-exhausted', 'rate_limited'))).toBe(
      "You've used the writing helper a lot this hour. Please try again later.",
    );
  });

  it('maps failed-precondition (thread_empty) to the nothing-to-reply-to copy', () => {
    expect(mapGenerateError(new FirebaseError('functions/failed-precondition', 'thread_empty'))).toBe(
      'There are no messages to reply to yet.',
    );
  });

  it('maps unavailable (ai_unavailable / ai_empty_result) to the helper-down copy', () => {
    expect(mapGenerateError(new FirebaseError('functions/unavailable', 'ai_unavailable'))).toBe(
      "The writing helper isn't available right now. Please try again in a moment.",
    );
    expect(mapGenerateError(new FirebaseError('functions/unavailable', 'ai_empty_result'))).toBe(
      "The writing helper isn't available right now. Please try again in a moment.",
    );
  });

  it('falls back to generic copy for anything unrecognized', () => {
    expect(mapGenerateError(new Error('boom'))).toBe("The writing helper couldn't finish that. Please try again.");
    expect(mapGenerateError(new FirebaseError('functions/internal', 'kaboom'))).toBe(
      "The writing helper couldn't finish that. Please try again.",
    );
  });
});

describe('normalizeLinkHref', () => {
  it('accepts http/https/mailto unchanged', () => {
    expect(normalizeLinkHref('https://example.com')).toBe('https://example.com');
    expect(normalizeLinkHref('http://example.com')).toBe('http://example.com');
    expect(normalizeLinkHref('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('prefixes a bare domain with https:// and a bare email with mailto:', () => {
    expect(normalizeLinkHref('example.com')).toBe('https://example.com');
    expect(normalizeLinkHref('a@b.com')).toBe('mailto:a@b.com');
  });

  it('returns null for blank input', () => {
    expect(normalizeLinkHref('   ')).toBeNull();
  });
});
