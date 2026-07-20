// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
