// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type RecentSend } from '../api/communicate';

// TZ pinned to a west-of-UTC zone so the AO-18 day-grouping assertions below
// are meaningful on any CI runner (the identical rationale in
// lib/communicateFormat.test.ts / Inbox.test.tsx). Restored afterAll for any
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

const { listRecentSends } = vi.hoisted(() => ({ listRecentSends: vi.fn() }));
vi.mock('../api/communicate', async (orig) => ({
  ...(await orig<typeof import('../api/communicate')>()),
  listRecentSends,
}));

import { Communicate } from './Communicate';

function send(over: Partial<RecentSend>): RecentSend {
  return {
    id: 's1',
    channel: 'email',
    recipientRedacted: 'j***@example.com',
    subject: 'Your visit recap',
    sentAtMs: Date.parse('2026-07-16T20:00:00.000Z'),
    counts: { delivered: 1, opened: 0, clicked: 0, bounced: 0, failed: 0 },
    lastEvent: 'delivered',
    ...over,
  };
}

beforeEach(() => {
  listRecentSends.mockReset();
});

async function withFixedToday(fixedNow: Date, run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixedNow);
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

describe('Communicate screen', () => {
  it('loads and renders a send row with channel, recipient, subject, and engagement summary', async () => {
    listRecentSends.mockResolvedValue([send({})]);
    render(<Communicate />);
    expect(await screen.findByText('Email · j***@example.com')).toBeInTheDocument();
    expect(screen.getByText('Your visit recap')).toBeInTheDocument();
    expect(screen.getByText('1 delivered')).toBeInTheDocument();
  });

  it('shows an honest "awaiting delivery events" summary when nothing has landed yet', async () => {
    listRecentSends.mockResolvedValue([
      send({ counts: { delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 } }),
    ]);
    render(<Communicate />);
    expect(await screen.findByText('Sent · awaiting delivery events')).toBeInTheDocument();
  });

  it('omits the subject line entirely when the row has none (defensive read, no blank line)', async () => {
    listRecentSends.mockResolvedValue([send({ subject: null })]);
    render(<Communicate />);
    await screen.findByText('Email · j***@example.com');
    expect(screen.queryByText('Your visit recap')).toBeNull();
  });

  it('falls back to an honest placeholder when recipientRedacted is blank (defensive read)', async () => {
    listRecentSends.mockResolvedValue([send({ recipientRedacted: '' })]);
    render(<Communicate />);
    expect(await screen.findByText('Email · (recipient not on file)')).toBeInTheDocument();
  });

  it('surfaces a load failure naming the callable, never a false empty list', async () => {
    listRecentSends.mockRejectedValueOnce(new Error('permission-denied'));
    render(<Communicate />);
    expect(await screen.findByText(/listRecentSends failed: permission-denied/)).toBeInTheDocument();
    expect(screen.queryByText(/no external sends yet/i)).toBeNull();
  });

  it('retries the load on demand via AsyncRegion', async () => {
    listRecentSends.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([send({})]);
    render(<Communicate />);
    await screen.findByText(/listRecentSends failed/i);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Email · j***@example.com')).toBeInTheDocument();
    expect(listRecentSends).toHaveBeenCalledTimes(2);
  });

  it('renders the proven-empty state only when the load is ready and genuinely empty', async () => {
    listRecentSends.mockResolvedValue([]);
    render(<Communicate />);
    expect(await screen.findByText(/no external sends yet/i)).toBeInTheDocument();
  });

  it('reloads the list via the Reload button', async () => {
    listRecentSends.mockResolvedValue([send({})]);
    render(<Communicate />);
    await screen.findByText('Email · j***@example.com');
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(listRecentSends).toHaveBeenCalledTimes(2);
  });

  it('shows an "N failed" badge counting only failed sends, never during loading', async () => {
    listRecentSends.mockResolvedValue([
      send({ id: 's-failed', counts: { delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 1 } }),
      send({ id: 's-ok' }),
    ]);
    render(<Communicate />);
    // Not present while loading (asyncScalar-style: a claim only once ready).
    expect(screen.queryByText('1 failed', { selector: '.communicate__badge' })).toBeNull();
    // Scoped to the badge selector: a per-row engagement summary can say
    // "1 failed" too (a different claim, about a different send), so this
    // must not match that text ambiguously.
    expect(await screen.findByText('1 failed', { selector: '.communicate__badge' })).toBeInTheDocument();
  });

  it('the Email filter tab shows only email sends, scoped by row container', async () => {
    listRecentSends.mockResolvedValue([
      send({ id: 's-email', channel: 'email', recipientRedacted: 'email-recipient@example.com' }),
      send({ id: 's-sms', channel: 'sms', recipientRedacted: '+1***5551212' }),
    ]);
    render(<Communicate />);
    await screen.findByText('Email · email-recipient@example.com');
    expect(screen.getByText('Text · +1***5551212')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Email' }));
    expect(screen.getByText('Email · email-recipient@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Text · +1***5551212')).toBeNull();
  });

  it('the All tab is selected by default and Email becomes selected on click', async () => {
    listRecentSends.mockResolvedValue([send({})]);
    render(<Communicate />);
    await screen.findByText('Email · j***@example.com');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(screen.getByRole('tab', { name: 'Email' }));
    expect(screen.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows "Nothing matches this filter" rather than the top-level empty state when a filter empties the list', async () => {
    listRecentSends.mockResolvedValue([send({ channel: 'sms', recipientRedacted: '+1***5551212' })]);
    render(<Communicate />);
    await screen.findByText('Text · +1***5551212');
    await userEvent.click(screen.getByRole('tab', { name: 'Email' }));
    expect(screen.getByText('Nothing matches this filter.')).toBeInTheDocument();
    expect(screen.queryByText(/no external sends yet/i)).toBeNull();
  });

  it('groups a late-evening local send under its LOCAL day, not the UTC-next day a raw slice would give (AO-18)', async () => {
    await withFixedToday(new Date(2026, 6, 16, 12, 0, 0), async () => {
      // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips to this UTC
      // instant, the same shape the send-path's timestamp would produce for
      // an 8pm-local send. A raw `new Date(ms).toISOString().slice(0, 10)`
      // would wrongly group it under 2026-07-17.
      listRecentSends.mockResolvedValue([send({ sentAtMs: Date.parse('2026-07-17T01:00:00.000Z') })]);
      render(<Communicate />);
      expect(await screen.findByText('Today', { selector: '.communicate__day-header' })).toBeInTheDocument();
      expect(screen.queryByText('Tomorrow', { selector: '.communicate__day-header' })).toBeNull();
    });
  });

  it('shows the LOCAL clock time in the row, not the UTC hour', async () => {
    listRecentSends.mockResolvedValue([send({ sentAtMs: Date.parse('2026-07-17T01:00:00.000Z') })]);
    render(<Communicate />);
    expect(await screen.findByText('20:00')).toBeInTheDocument();
  });

  it('groups two sends on different LOCAL days under separate headers, newest day first', async () => {
    await withFixedToday(new Date(2026, 6, 20, 12, 0, 0), async () => {
      listRecentSends.mockResolvedValue([
        send({
          id: 's-earlier',
          recipientRedacted: 'earlier@example.com',
          sentAtMs: Date.parse('2026-07-16T20:00:00.000Z'),
        }),
        send({
          id: 's-later',
          recipientRedacted: 'later@example.com',
          sentAtMs: Date.parse('2026-07-18T20:00:00.000Z'),
        }),
      ]);
      render(<Communicate />);
      await screen.findByText('Email · later@example.com');
      // Both dates are >1 day from the fixed "today" (2026-07-20), so both
      // render as "Weekday, Mon DD" labels, never Today/Tomorrow/Yesterday,
      // newest first per groupSendsByDay.
      const headers = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
      expect(headers).toEqual(['Sat, Jul 18', 'Thu, Jul 16']);
    });
  });

  it('scopes the engagement-state pill to its own row (multiple rows, no cross-row leakage)', async () => {
    listRecentSends.mockResolvedValue([
      send({ id: 's-failed', recipientRedacted: 'a@example.com', counts: { delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 1 } }),
      send({ id: 's-delivered', recipientRedacted: 'b@example.com', counts: { delivered: 1, opened: 0, clicked: 0, bounced: 0, failed: 0 } }),
    ]);
    render(<Communicate />);
    const failedRow = (await screen.findByText('Email · a@example.com')).closest('.communicate__row');
    const deliveredRow = screen.getByText('Email · b@example.com').closest('.communicate__row');
    expect(failedRow).not.toBeNull();
    expect(deliveredRow).not.toBeNull();
    expect(within(failedRow as HTMLElement).getByText('Failed')).toBeInTheDocument();
    expect(within(deliveredRow as HTMLElement).getByText('Delivered')).toBeInTheDocument();
  });
});
