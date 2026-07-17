// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type BookingEntry } from '../api/bookings';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

import { Bookings } from './Bookings';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function entry(over: Partial<BookingEntry>): BookingEntry {
  return {
    _id: 'ses1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    serviceType: 'Dog Walking',
    status: 'SCHEDULED',
    startTime: '2026-07-16T09:00:00',
    completedAt: '',
    departedAt: '',
    notes: '',
    kinfolkNotes: '',
    createdAt: fakeTs('2026-07-15T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<BookingEntry[]>);
});

describe('Bookings screen', () => {
  it('renders a streamed row with its household, service, when, and status chip', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Bookings />);
    // Scope by the row container, not the button, the row is only a <button>
    // once a detail route wires onSelectBooking; here (unwired) it renders static.
    const row = screen.getByText('The Whitfields').closest('.bookings__row') as HTMLElement;
    expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
    expect(within(row).getByText(/Dog Walking/)).toBeInTheDocument();
    expect(within(row).getByText(/Jul 16, 9:00 AM/)).toBeInTheDocument();
    expect(within(row).getByText('SCHEDULED')).toBeInTheDocument();
  });

  it('an unnamed kinfolk renders "Unnamed Kinfolk" rather than a blank row', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ kinfolkName: '' })] });
    render(<Bookings />);
    expect(screen.getByText('Unnamed Kinfolk')).toBeInTheDocument();
  });

  it('a blank serviceType renders "Visit" rather than a blank field', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ serviceType: '' })] });
    render(<Bookings />);
    expect(screen.getByText(/Visit ·/)).toBeInTheDocument();
  });

  it('folds CANCELLED / CANCELED / REJECTED into one CANCELLED chip', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', status: 'CANCELLED' }),
        entry({ _id: 'b', status: 'CANCELED' }),
        entry({ _id: 'c', status: 'REJECTED' }),
      ],
    });
    render(<Bookings />);
    expect(screen.getAllByText('CANCELLED')).toHaveLength(3);
  });

  it('an unrecognized status renders its own honest UNKNOWN chip, never a fabricated known state', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'WEIRD_STATUS' })] });
    render(<Bookings />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<Bookings />);
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.queryByText(/no bookings yet/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'deadline-exceeded', retry: vi.fn() });
    render(<Bookings />);
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Bookings />);
    expect(screen.getByText(/no bookings yet/i)).toBeInTheDocument();
  });

  it('filter tabs narrow the visible rows without hiding the others behind a false empty', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', kinfolkName: 'Row A', status: 'DRAFT' }),
        entry({ _id: 'b', kinfolkName: 'Row B', status: 'SCHEDULED' }),
      ],
    });
    render(<Bookings />);
    expect(screen.getByText('Row A')).toBeInTheDocument();
    expect(screen.getByText('Row B')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Draft' }));
    expect(screen.getByText('Row A')).toBeInTheDocument();
    expect(screen.queryByText('Row B')).toBeNull();
  });

  it('shows a "nothing matches" hint (not the top-level empty state) when a filter excludes every row', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: 'SCHEDULED' })],
    });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('tab', { name: 'Cancelled' }));
    expect(screen.getByText(/nothing matches this filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/no bookings yet/i)).toBeNull();
  });

  it('the Pending stat combines DRAFT and PENDING, mirroring BookingScreen.kt\'s "Pending approval"', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', status: 'DRAFT' }),
        entry({ _id: 'b', status: 'PENDING' }),
        entry({ _id: 'c', status: 'SCHEDULED' }),
      ],
    });
    render(<Bookings />);
    // "Pending" is ambiguous by plain text, the same word also labels the
    // filter tab, so this scopes to the stat card's own label span.
    const pending = screen
      .getByText('Pending', { selector: '.den-stat-label' })
      .closest('.den-stat, button.den-stat--button');
    expect(pending).not.toBeNull();
    expect(within(pending as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('clicking a row calls onSelectBooking with the booking id', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'ses-42' })] });
    const onSelectBooking = vi.fn();
    render(<Bookings onSelectBooking={onSelectBooking} />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(onSelectBooking).toHaveBeenCalledWith('ses-42');
  });

  it('renders rows STATIC (not a live no-op button) when onSelectBooking is unwired, the router mounts this screen propless', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Bookings />);
    // The content renders, but the row is NOT an interactive button when unwired:
    // a handler-less <button> still carries the implicit ARIA button role, so we
    // assert against the role, not just the explicit attributes.
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /The Whitfields/i })).toBeNull();
  });
});
