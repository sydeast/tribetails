// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type NotificationEntry } from '../api/notifications';

const { bulkMarkNotificationsRead } = vi.hoisted(() => ({ bulkMarkNotificationsRead: vi.fn() }));
vi.mock('../api/notifications', async (orig) => ({
  ...(await orig<typeof import('../api/notifications')>()),
  bulkMarkNotificationsRead,
}));

import { NotificationsDigest } from './NotificationsDigest';

function ts(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function entry(over: Partial<NotificationEntry>): NotificationEntry {
  return {
    _id: 'n1',
    key: 'kincare.booking.confirm',
    title: 'Booking confirmed',
    category: 'bookings',
    createdAt: ts('2026-07-16T09:30:00Z'),
    ...over,
  };
}

function ready(data: NotificationEntry[]): Async<NotificationEntry[]> {
  return { status: 'ready', data };
}

beforeEach(() => {
  bulkMarkNotificationsRead.mockReset().mockResolvedValue(1);
});

describe('NotificationsDigest', () => {
  /**
   * The meta line WAS `category · status`, and `status` was the dispatcher's own
   * pipeline state on a digest row (R5). What replaces it is the notification's
   * own subject, resolved server-side: kin, date, time. A digest exists to be
   * glanced at, and "bookings · dispatched" told an operator nothing about which
   * booking.
   */
  it('renders the unread rows with their human title and the entity summary', () => {
    render(
      <NotificationsDigest
        state={ready([entry({ detail: { kinName: 'Rex', bookingDate: 'Mon, Jun 15' } })])}
      />,
    );
    expect(screen.getByText('Booking confirmed')).toBeInTheDocument();
    expect(screen.getByText('bookings · Rex · Mon, Jun 15')).toBeInTheDocument();
  });
  it('falls back to the category alone when the server resolved no detail', () => {
    render(<NotificationsDigest state={ready([entry({})])} />);
    expect(screen.getByText('bookings')).toBeInTheDocument();
    expect(screen.queryByText(/dispatched/)).toBeNull();
  });

  it('falls back to the raw catalog key when a row has no title', () => {
    // Rows dispatched before AO-28 have no `title` AT ALL (absent, not
    // undefined), which is what exactOptionalPropertyTypes models here.
    const { title: _absent, ...untitled } = entry({});
    render(<NotificationsDigest state={ready([untitled])} />);
    expect(screen.getByText('kincare.booking.confirm')).toBeInTheDocument();
  });

  it('shows only unread rows: a read notification never reaches the digest', () => {
    render(
      <NotificationsDigest
        state={ready([
          entry({ _id: 'a', title: 'Unread alert' }),
          entry({ _id: 'b', title: 'Read alert', readAt: ts('2026-07-16T10:00:00Z') }),
        ])}
      />,
    );
    expect(screen.getByText('Unread alert')).toBeInTheDocument();
    expect(screen.queryByText('Read alert')).toBeNull();
  });

  it('never shows an archived row', () => {
    render(
      <NotificationsDigest
        state={ready([entry({ _id: 'a', title: 'Archived alert', archivedAt: ts('2026-07-16T10:00:00Z') })])}
      />,
    );
    expect(screen.queryByText('Archived alert')).toBeNull();
    expect(screen.getByText(/no unread notifications/i)).toBeInTheDocument();
  });

  it('caps the strip and says how many more are waiting', () => {
    const rows = Array.from({ length: 9 }, (_, i) => entry({ _id: `n${i}`, title: `Alert ${i}` }));
    render(<NotificationsDigest state={ready(rows)} limit={6} />);
    expect(screen.getByText('Alert 5')).toBeInTheDocument();
    expect(screen.queryByText('Alert 6')).toBeNull();
    expect(screen.getByText('+3 more unread in Notifications')).toBeInTheDocument();
  });

  it('surfaces a stream failure fail-loud, never an empty digest', () => {
    render(<NotificationsDigest state={{ status: 'error', message: 'permission-denied' }} />);
    expect(screen.getByText(/permission-denied/)).toBeInTheDocument();
    expect(screen.queryByText(/no unread notifications/i)).toBeNull();
  });

  it('says nothing about counts while the stream is still loading', () => {
    render(<NotificationsDigest state={{ status: 'loading' }} />);
    expect(screen.queryByText(/no unread notifications/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /mark read/i })).toBeNull();
  });

  it('shows the bulk action only once rows are selected, and reports the count', async () => {
    render(<NotificationsDigest state={ready([entry({ _id: 'a' }), entry({ _id: 'b' })])} />);
    expect(screen.queryByRole('button', { name: /mark read/i })).toBeNull();

    await userEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Mark read (1)' })).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('checkbox')[1] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Mark read (2)' })).toBeInTheDocument();
  });

  it('marks the selected ids read through bulkMarkNotificationsRead and clears the selection', async () => {
    bulkMarkNotificationsRead.mockResolvedValue(2);
    render(<NotificationsDigest state={ready([entry({ _id: 'a' }), entry({ _id: 'b' })])} />);
    await userEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    await userEvent.click(screen.getAllByRole('checkbox')[1] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Mark read (2)' }));

    await waitFor(() => expect(bulkMarkNotificationsRead).toHaveBeenCalledWith(['a', 'b']));
    await waitFor(() => expect(screen.queryByRole('button', { name: /mark read/i })).toBeNull());
  });

  it('surfaces a failed bulk mark-read instead of silently clearing the selection', async () => {
    bulkMarkNotificationsRead.mockRejectedValue(new Error('unauthenticated'));
    render(<NotificationsDigest state={ready([entry({ _id: 'a' })])} />);
    await userEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Mark read (1)' }));

    expect(await screen.findByText(/unauthenticated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark read (1)' })).toBeInTheDocument();
  });

  it('reports a partial batch when the server marked fewer than were asked', async () => {
    bulkMarkNotificationsRead.mockResolvedValue(1);
    render(<NotificationsDigest state={ready([entry({ _id: 'a' }), entry({ _id: 'b' })])} />);
    await userEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    await userEvent.click(screen.getAllByRole('checkbox')[1] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Mark read (2)' }));

    expect(await screen.findByText(/marked 1 of 2/i)).toBeInTheDocument();
  });
});
