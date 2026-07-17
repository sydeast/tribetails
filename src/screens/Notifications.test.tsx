// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type NotificationEntry } from '../api/notifications';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { markNotificationRead, markNotificationUnread, bulkMarkNotificationsRead } = vi.hoisted(() => ({
  markNotificationRead: vi.fn(),
  markNotificationUnread: vi.fn(),
  bulkMarkNotificationsRead: vi.fn(),
}));
vi.mock('../api/notifications', async (orig) => ({
  ...(await orig<typeof import('../api/notifications')>()),
  markNotificationRead,
  markNotificationUnread,
  bulkMarkNotificationsRead,
}));

import { Notifications } from './Notifications';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function entry(over: Partial<NotificationEntry>): NotificationEntry {
  return {
    _id: 'n1',
    key: 'kincare.booking.confirm',
    category: 'bookings',
    recipientUid: 'u1',
    status: 'dispatched',
    mode: 'trigger',
    channels: ['email', 'sms'],
    createdAt: fakeTs('2026-07-16T09:30:00Z'),
    targetType: 'booking',
    targetId: 'b1',
    ...over,
  };
}

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<NotificationEntry[]>);
  markNotificationRead.mockReset().mockResolvedValue(undefined);
  markNotificationUnread.mockReset().mockResolvedValue(undefined);
  bulkMarkNotificationsRead.mockReset().mockResolvedValue(1);
});

describe('Notifications screen', () => {
  it('renders streamed rows grouped by day, with key/category/mode/channels/status', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Notifications />);
    expect(screen.getByText('2026-07-16')).toBeInTheDocument();
    expect(screen.getByText('kincare.booking.confirm')).toBeInTheDocument();
    expect(screen.getByText('bookings · trigger')).toBeInTheDocument();
    expect(screen.getByText('channels: email, sms')).toBeInTheDocument();
    expect(screen.getByText('dispatched')).toBeInTheDocument();
  });

  it('shows an unread badge counting only unread rows', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'n1' }), entry({ _id: 'n2', readAt: fakeTs('2026-07-16T10:00:00Z') })],
    });
    render(<Notifications />);
    expect(screen.getByText('1 unread')).toBeInTheDocument();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'insufficient permissions' });
    render(<Notifications />);
    expect(screen.getByText(/insufficient permissions/i)).toBeInTheDocument();
    expect(screen.queryByText(/no notifications yet/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'deadline-exceeded', retry: vi.fn() });
    render(<Notifications />);
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('marks an unread row read via markNotificationRead', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /mark read/i }));
    expect(markNotificationRead).toHaveBeenCalledWith('n1');
    expect(markNotificationUnread).not.toHaveBeenCalled();
  });

  it('marks a read row unread via markNotificationUnread', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'n1', readAt: fakeTs('2026-07-16T10:00:00Z') })],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /mark unread/i }));
    expect(markNotificationUnread).toHaveBeenCalledWith('n1');
  });

  it('disables the row button while the call is in flight', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    let release!: () => void;
    markNotificationRead.mockReturnValue(
      new Promise<void>((r) => {
        release = () => r();
      }),
    );
    render(<Notifications />);
    const btn = screen.getByRole('button', { name: /mark read/i });
    await userEvent.click(btn);
    expect(btn).toBeDisabled();
    release();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it('fails loud (dismissible banner) when a single mark-read call rejects', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    markNotificationRead.mockRejectedValue(new Error('permission-denied'));
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /mark read/i }));
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    // the row button re-enables so the operator can retry
    await waitFor(() => expect(screen.getByRole('button', { name: /mark read/i })).not.toBeDisabled());
  });

  it('selecting rows shows the bulk bar and bulk-marks read via bulkMarkNotificationsRead', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'n1' }), entry({ _id: 'n2' })],
    });
    render(<Notifications />);
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[0]!);
    await userEvent.click(checkboxes[1]!);
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /mark selected read/i }));
    expect(bulkMarkNotificationsRead).toHaveBeenCalledWith(['n1', 'n2']);
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
  });

  it('keeps the selection and fails loud when the bulk call rejects', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    bulkMarkNotificationsRead.mockRejectedValue(new Error('boom'));
    render(<Notifications />);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /mark selected read/i }));
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('Clear empties the selection without calling the backend', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(screen.queryByText('1 selected')).toBeNull();
    expect(bulkMarkNotificationsRead).not.toHaveBeenCalled();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Notifications />);
    expect(screen.getByText(/no notifications yet/i)).toBeInTheDocument();
  });
});
