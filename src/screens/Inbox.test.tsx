// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ConversationSummary } from '../api/inbox';

// TZ pinned to a west-of-UTC zone so the AO-18 day-grouping assertions below
// are meaningful on any CI runner (the identical rationale in
// lib/inboxFormat.test.ts / Sessions.test.tsx). Restored afterAll for any
// sibling test file sharing this worker.
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
vi.mock('../api/inbox', async (orig) => ({
  ...(await orig<typeof import('../api/inbox')>()),
  listConversations,
}));

import { Inbox } from './Inbox';

function thread(over: Partial<ConversationSummary>): ConversationSummary {
  return {
    kinfolkId: 'k1',
    kinfolkName: 'The Alvarez Household',
    lastMessagePreview: 'Thanks for the update!',
    lastMessageAtMs: Date.parse('2026-07-16T20:00:00.000Z'),
    lastSenderRole: 'kinfolk',
    unreadForAdmin: true,
    messageCount: 4,
    ...over,
  };
}

beforeEach(() => {
  listConversations.mockReset();
});

/**
 * Only the day-grouping/label tests fake the clock, and fake ONLY `Date`
 * (`toFake: ['Date']`), leaving `setTimeout`/`setInterval` real so RTL's
 * `findBy*`/`waitFor` polling (which the async `listConversations` load needs)
 * keeps working. This is the same split Sessions.test.tsx uses (there, fake
 * timers are avoided entirely for click-driven tests because full fake timers
 * don't mix with userEvent's own delays); faking only `Date` sidesteps that
 * tradeoff so this helper is safe to combine with `await screen.findByText`.
 */
async function withFixedToday(fixedNow: Date, run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixedNow);
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

describe('Inbox screen', () => {
  it('loads and renders a thread row with household, preview, and count', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox />);
    expect(await screen.findByText('The Alvarez Household')).toBeInTheDocument();
    expect(screen.getByText('Thanks for the update!')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('prefixes the preview with "You:" only when the last sender was the auntie', async () => {
    listConversations.mockResolvedValue([thread({ lastSenderRole: 'auntie', lastMessagePreview: 'On my way!' })]);
    render(<Inbox />);
    expect(await screen.findByText('You: On my way!')).toBeInTheDocument();
  });

  it('does not prefix "You:" for a kinfolk-sent message', async () => {
    listConversations.mockResolvedValue([thread({ lastSenderRole: 'kinfolk', lastMessagePreview: 'When can you come by?' })]);
    render(<Inbox />);
    expect(await screen.findByText('When can you come by?')).toBeInTheDocument();
    expect(screen.queryByText(/^You:/)).toBeNull();
  });

  it('falls back to the kinfolkId when kinfolkName is blank (defensive read)', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k-blank', kinfolkName: '' })]);
    render(<Inbox />);
    expect(await screen.findByText('k-blank')).toBeInTheDocument();
  });

  it('shows a placeholder rather than a blank line for an empty preview', async () => {
    listConversations.mockResolvedValue([thread({ lastMessagePreview: '' })]);
    render(<Inbox />);
    expect(await screen.findByText('(no message yet)')).toBeInTheDocument();
  });

  it('surfaces a load failure naming the callable, never a false empty list', async () => {
    listConversations.mockRejectedValueOnce(new Error('permission-denied'));
    render(<Inbox />);
    expect(await screen.findByText(/listConversations failed: permission-denied/)).toBeInTheDocument();
    expect(screen.queryByText(/no messages yet/i)).toBeNull();
  });

  it('retries the load on demand via AsyncRegion', async () => {
    listConversations.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([thread({})]);
    render(<Inbox />);
    await screen.findByText(/listConversations failed/i);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('The Alvarez Household')).toBeInTheDocument();
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it('renders the proven-empty state only when the load is ready and genuinely empty', async () => {
    listConversations.mockResolvedValue([]);
    render(<Inbox />);
    expect(await screen.findByText(/no messages yet/i)).toBeInTheDocument();
  });

  it('reloads the list via the Reload button', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it('shows an "N unread" badge counting only unread threads, never during loading', async () => {
    listConversations.mockResolvedValue([
      thread({ kinfolkId: 'k1', unreadForAdmin: true }),
      thread({ kinfolkId: 'k2', unreadForAdmin: false }),
    ]);
    render(<Inbox />);
    // Not present while loading (asyncScalar-style: a claim only once ready).
    expect(screen.queryByText(/unread/)).toBeNull();
    expect(await screen.findByText('1 unread')).toBeInTheDocument();
  });

  it('the Unread filter tab shows only unread threads, scoped by row container', async () => {
    listConversations.mockResolvedValue([
      thread({ kinfolkId: 'k1', kinfolkName: 'Unread Household', unreadForAdmin: true }),
      thread({ kinfolkId: 'k2', kinfolkName: 'Read Household', unreadForAdmin: false }),
    ]);
    render(<Inbox />);
    await screen.findByText('Unread Household');
    expect(screen.getByText('Read Household')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByText('Unread Household')).toBeInTheDocument();
    expect(screen.queryByText('Read Household')).toBeNull();
  });

  it('the All tab is selected by default and Unread becomes selected on click', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Unread' })).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByRole('tab', { name: 'Unread' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows "Nothing matches this filter" rather than the top-level empty state when a filter empties the list', async () => {
    listConversations.mockResolvedValue([thread({ unreadForAdmin: false })]);
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByText('Nothing matches this filter.')).toBeInTheDocument();
    expect(screen.queryByText(/no messages yet/i)).toBeNull();
  });

  it('groups a late-evening local thread under its LOCAL day, not the UTC-next day a raw slice would give (AO-18)', async () => {
    await withFixedToday(new Date(2026, 6, 16, 12, 0, 0), async () => {
      // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips to this UTC
      // instant, the same shape appendMessage/Date.now() would produce for an
      // 8pm-local message. A raw `new Date(ms).toISOString().slice(0, 10)`
      // would wrongly group it under 2026-07-17.
      listConversations.mockResolvedValue([thread({ lastMessageAtMs: Date.parse('2026-07-17T01:00:00.000Z') })]);
      render(<Inbox />);
      expect(await screen.findByText('Today', { selector: '.inbox__day-header' })).toBeInTheDocument();
      expect(screen.queryByText('Tomorrow', { selector: '.inbox__day-header' })).toBeNull();
    });
  });

  it('shows the LOCAL clock time in the row, not the UTC hour', async () => {
    listConversations.mockResolvedValue([thread({ lastMessageAtMs: Date.parse('2026-07-17T01:00:00.000Z') })]);
    render(<Inbox />);
    expect(await screen.findByText('20:00')).toBeInTheDocument();
  });

  it('groups two threads on different LOCAL days under separate headers, newest day first', async () => {
    await withFixedToday(new Date(2026, 6, 20, 12, 0, 0), async () => {
      listConversations.mockResolvedValue([
        thread({
          kinfolkId: 'k-earlier',
          kinfolkName: 'Earlier Household',
          lastMessageAtMs: Date.parse('2026-07-16T20:00:00.000Z'),
        }),
        thread({
          kinfolkId: 'k-later',
          kinfolkName: 'Later Household',
          lastMessageAtMs: Date.parse('2026-07-18T20:00:00.000Z'),
        }),
      ]);
      render(<Inbox />);
      await screen.findByText('Later Household');
      // Both dates are >1 day from the fixed "today" (2026-07-20), so both
      // render as "Weekday, Mon DD" labels, never Today/Tomorrow/Yesterday,
      // newest first per groupThreadsByDay.
      const headers = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
      expect(headers).toEqual(['Sat, Jul 18', 'Thu, Jul 16']);
    });
  });

  it('calls onSelectThread with the kinfolkId when a row is activated', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1' })]);
    const onSelectThread = vi.fn();
    render(<Inbox onSelectThread={onSelectThread} />);
    await userEvent.click(await screen.findByText('The Alvarez Household'));
    expect(onSelectThread).toHaveBeenCalledWith('k1');
  });

  it('renders a row STATIC (not a live no-op button) when onSelectThread is unwired, matching the propless-mount dead-control rule', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    const row = screen.getByText('The Alvarez Household').closest('.inbox__row-main');
    expect(row).not.toBeNull();
    expect(row?.tagName).toBe('DIV');
    expect(row).not.toHaveAttribute('role', 'button');
    // Scoped to the row container, not a bare button lookup: no button role
    // reaches this row at all when unwired.
    expect(within(row as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('renders a real <button> row once onSelectThread IS wired', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox onSelectThread={vi.fn()} />);
    await screen.findByText('The Alvarez Household');
    const row = screen.getByText('The Alvarez Household').closest('.inbox__row-main');
    expect(row?.tagName).toBe('BUTTON');
  });
});
