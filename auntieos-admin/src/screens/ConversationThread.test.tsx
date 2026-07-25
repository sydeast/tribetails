// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ThreadMessage } from '../api/inboxThread';

let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const { getConversationThread, replyToConversation } = vi.hoisted(() => ({
  getConversationThread: vi.fn(),
  replyToConversation: vi.fn(),
}));
vi.mock('../api/inboxThread', async (orig) => ({
  ...(await orig<typeof import('../api/inboxThread')>()),
  getConversationThread,
  replyToConversation,
}));

import { ConversationThread } from './ConversationThread';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return { id: 'm1', senderRole: 'kinfolk', senderUid: 'k1', body: 'hello', createdAtMs: 1_760_000_000_000, readAt: null, ...over };
}

beforeEach(() => {
  getConversationThread.mockReset();
  replyToConversation.mockReset();
});

describe('ConversationThread', () => {
  it('loads and renders the thread, kinfolk + auntie messages', async () => {
    getConversationThread.mockResolvedValue([
      msg({ id: 'm1', senderRole: 'kinfolk', body: 'Is Tuesday ok?' }),
      msg({ id: 'm2', senderRole: 'auntie', body: 'Yes, see you then' }),
    ]);
    render(<ConversationThread kinfolkId="k1" kinfolkName="The Alvarez Household" onBack={vi.fn()} />);
    expect(await screen.findByText('Is Tuesday ok?')).toBeInTheDocument();
    expect(screen.getByText('Yes, see you then')).toBeInTheDocument();
    expect(getConversationThread).toHaveBeenCalledWith('k1');
  });

  it('sends a reply, then reloads the thread', async () => {
    getConversationThread.mockResolvedValue([msg({ body: 'hi' })]);
    replyToConversation.mockResolvedValue('m_new');
    render(<ConversationThread kinfolkId="k1" kinfolkName="Alvarez" onBack={vi.fn()} />);
    await screen.findByText('hi');

    await userEvent.type(screen.getByLabelText(/reply to this household/i), 'On my way');
    await userEvent.click(screen.getByRole('button', { name: /send reply/i }));

    await waitFor(() => expect(replyToConversation).toHaveBeenCalledWith('k1', 'On my way'));
    // initial load + reload after send
    await waitFor(() => expect(getConversationThread).toHaveBeenCalledTimes(2));
  });

  it('disables Send for an empty draft', async () => {
    getConversationThread.mockResolvedValue([]);
    render(<ConversationThread kinfolkId="k1" kinfolkName="Alvarez" onBack={vi.fn()} />);
    await screen.findByRole('button', { name: /send reply/i });
    expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled();
  });

  it('fails loud (names the callable) when a reply rejects, and does not clear the draft', async () => {
    getConversationThread.mockResolvedValue([]);
    replyToConversation.mockRejectedValue(new Error('permission-denied'));
    render(<ConversationThread kinfolkId="k1" kinfolkName="Alvarez" onBack={vi.fn()} />);
    await screen.findByRole('button', { name: /send reply/i });

    await userEvent.type(screen.getByLabelText(/reply to this household/i), 'test');
    await userEvent.click(screen.getByRole('button', { name: /send reply/i }));

    expect(await screen.findByText(/replyToConversation failed:.*permission-denied/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/reply to this household/i)).toHaveValue('test');
  });

  it('surfaces a load failure fail-loud, not an empty state', async () => {
    getConversationThread.mockRejectedValue(new Error('deadline-exceeded'));
    render(<ConversationThread kinfolkId="k1" kinfolkName="Alvarez" onBack={vi.fn()} />);
    expect(await screen.findByText(/getConversationThread failed:.*deadline-exceeded/i)).toBeInTheDocument();
  });

  it('calls onBack from the Back control', async () => {
    getConversationThread.mockResolvedValue([]);
    const onBack = vi.fn();
    render(<ConversationThread kinfolkId="k1" kinfolkName="Alvarez" onBack={onBack} />);
    await userEvent.click(await screen.findByRole('button', { name: /back to inbox/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
/**
 * Archive parity (Conversations.kt#replyBlocker): the over-long reply is caught
 * client-side with a real sentence, so the operator never sees the callable's
 * raw "replyToConversation validation failed" for a case the UI could have
 * named itself.
 */
describe('ConversationThread reply guards', () => {
  it('blocks an over-long reply before it reaches replyToConversation', async () => {
    getConversationThread.mockResolvedValue([msg()]);
    render(<ConversationThread kinfolkId="k1" kinfolkName="The Alvarez Household" onBack={vi.fn()} />);
    await screen.findByText('hello');
    // fireEvent.change, not userEvent.type: typing 5001 characters keystroke
    // by keystroke is needlessly slow, and the guard reads the VALUE anyway.
    fireEvent.change(screen.getByLabelText(/reply to this household/i), {
      target: { value: 'x'.repeat(5001) },
    });
    expect(await screen.findByText(/Message is too long \(5000 character max\)\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled();
    expect(replyToConversation).not.toHaveBeenCalled();
  });
  it('keeps the Send control disabled for a whitespace-only draft', async () => {
    getConversationThread.mockResolvedValue([msg()]);
    render(<ConversationThread kinfolkId="k1" kinfolkName="The Alvarez Household" onBack={vi.fn()} />);
    await screen.findByText('hello');
    await userEvent.type(screen.getByLabelText(/reply to this household/i), '   ');
    expect(screen.getByRole('button', { name: /send reply/i })).toBeDisabled();
    expect(replyToConversation).not.toHaveBeenCalled();
  });
  it('sends a reply that sits exactly on the server maximum', async () => {
    getConversationThread.mockResolvedValue([msg()]);
    replyToConversation.mockResolvedValue('m-new');
    render(<ConversationThread kinfolkId="k1" kinfolkName="The Alvarez Household" onBack={vi.fn()} />);
    await screen.findByText('hello');
    const body = 'x'.repeat(5000);
    fireEvent.change(screen.getByLabelText(/reply to this household/i), { target: { value: body } });
    await userEvent.click(screen.getByRole('button', { name: /send reply/i }));
    await waitFor(() => expect(replyToConversation).toHaveBeenCalledWith('k1', body));
  });
});
