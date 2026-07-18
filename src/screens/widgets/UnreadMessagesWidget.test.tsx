// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConversationSummary } from '../../api/inbox';

let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const { listConversations } = vi.hoisted(() => ({ listConversations: vi.fn() }));
vi.mock('../../api/inbox', async (orig) => ({
  ...(await orig<typeof import('../../api/inbox')>()),
  listConversations,
}));

import { UnreadMessagesWidget } from './UnreadMessagesWidget';

function conv(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    lastMessagePreview: 'Hi Auntie',
    lastMessageAtMs: 1_760_000_000_000,
    lastSenderRole: 'kinfolk',
    unreadForAdmin: true,
    messageCount: 2,
    ...over,
  };
}

beforeEach(() => {
  listConversations.mockReset();
});

describe('UnreadMessagesWidget', () => {
  it('shows the unread total and rows, newest first', async () => {
    listConversations.mockResolvedValue([
      conv({ kinfolkId: 'a', kinfolkName: 'Older', lastMessageAtMs: 100, unreadForAdmin: true }),
      conv({ kinfolkId: 'b', kinfolkName: 'Newer', lastMessageAtMs: 300, unreadForAdmin: true }),
      conv({ kinfolkId: 'c', kinfolkName: 'Read', unreadForAdmin: false }),
    ]);
    render(<UnreadMessagesWidget />);

    expect(await screen.findByText('Newer')).toBeInTheDocument();
    // Headline counts only the two unread, not the read row.
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Older')).toBeInTheDocument();
    expect(screen.queryByText('Read')).not.toBeInTheDocument();

    // DOM order: 'Newer' (300ms) precedes 'Older' (100ms).
    const names = screen.getAllByText(/Newer|Older/).map((n) => n.textContent);
    expect(names).toEqual(['Newer', 'Older']);
  });

  it('shows the caught-up empty state (not an error) when nothing is unread', async () => {
    listConversations.mockResolvedValue([conv({ unreadForAdmin: false })]);
    render(<UnreadMessagesWidget />);
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it('caps the shown rows and reports the overflow', async () => {
    listConversations.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) =>
        conv({ kinfolkId: `k${i}`, kinfolkName: `H${i}`, lastMessageAtMs: i, unreadForAdmin: true }),
      ),
    );
    render(<UnreadMessagesWidget limit={5} />);
    expect(await screen.findByText(/\+2 more waiting/i)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('fails loud (names the callable) when the load rejects', async () => {
    listConversations.mockRejectedValue(new Error('permission-denied'));
    render(<UnreadMessagesWidget />);
    expect(
      await screen.findByText(/listConversations failed:.*permission-denied/i),
    ).toBeInTheDocument();
  });
});
