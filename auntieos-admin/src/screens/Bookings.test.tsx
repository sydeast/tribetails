// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type BookingEntry } from '../api/bookings';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

// This screen navigates from the detail sheet's kinfolk / KinTale links. No
// suite in this tree mounts a RouterProvider, so the hook is stubbed rather
// than the whole router stood up (the Schedule.test.tsx convention).
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

// The status transitions composed into the sheet call api/bookingsWrite. The
// module is mocked here the same way every other screen test mocks its api/
// module, to keep this file from ever touching the real Firebase client.
const {
  approveBooking,
  rejectBooking,
  cancelBooking,
  markBookingCompleted,
  rescheduleBooking,
} = vi.hoisted(() => ({
  approveBooking: vi.fn(),
  rejectBooking: vi.fn(),
  cancelBooking: vi.fn(),
  markBookingCompleted: vi.fn(),
  rescheduleBooking: vi.fn(),
}));
vi.mock('../api/bookingsWrite', () => ({
  approveBooking,
  rejectBooking,
  cancelBooking,
  markBookingCompleted,
  rescheduleBooking,
}));

/**
 * The detail sheet is stubbed, exactly as Schedule.test.tsx stubs it: its own
 * behaviour (fact rows, address read, the 3h note lock, reschedule, optimistic
 * assign) is covered directly in `components/BookingDetailModal.test.tsx`, and
 * mounting the real one here would drag this screen suite into mocking the
 * staff roster, the kinfolk profile read, and four more callables.
 *
 * The stub DOES render `props.actions` verbatim, because that slot is the one
 * part of the sheet this screen owns: the Approve / Reject / Cancel / Mark
 * Completed panel it composes in. Stubbing that too would leave nothing
 * asserting that the transitions survived the move off `BookingActions`.
 */
vi.mock('../components/BookingDetailModal', () => ({
  BookingDetailModal: (props: {
    entry: { _id: string; kinfolkId?: string | undefined };
    onClose: () => void;
    actions?: ReactNode;
    onOpenKinfolk?: (id: string) => void;
    onOpenKinTale?: (id: string) => void;
  }) => (
    <div role="dialog" data-testid="booking-detail-modal" data-entry-id={props.entry._id}>
      <button type="button" onClick={() => props.onOpenKinfolk?.(props.entry.kinfolkId ?? '')}>
        stub open kinfolk
      </button>
      <button type="button" onClick={() => props.onOpenKinTale?.('rep1')}>
        stub open kintale
      </button>
      <button type="button" onClick={props.onClose}>
        stub close
      </button>
      {props.actions}
    </div>
  ),
}));

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
  navigate.mockReset();
  approveBooking.mockReset().mockResolvedValue(undefined);
  rejectBooking.mockReset().mockResolvedValue(undefined);
  cancelBooking.mockReset().mockResolvedValue(undefined);
  markBookingCompleted.mockReset().mockResolvedValue(undefined);
  rescheduleBooking.mockReset().mockResolvedValue(undefined);
});

describe('Bookings screen', () => {
  it('renders a streamed row with its household, service, when, and status chip', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Bookings />);
    // Scope by the row container: the row is a real <button> now that Bookings
    // wires its own onSelectBooking default (opening BookingActions), see the
    // "opens BookingActions" tests below for the interactive assertions.
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

  it('clicking a row calls an externally-supplied onSelectBooking with the booking id, instead of opening the built-in overlay', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'ses-42' })] });
    const onSelectBooking = vi.fn();
    render(<Bookings onSelectBooking={onSelectBooking} />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(onSelectBooking).toHaveBeenCalledWith('ses-42');
    // The screen's own BookingActions overlay must NOT also render: the
    // external caller owns detail UI once it supplies its own handler.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking a row with no external onSelectBooking opens the FULL detail sheet for that booking, not a thin action dialog', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'ses-42', kinfolkName: 'The Whitfields' })],
    });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(screen.getByTestId('booking-detail-modal')).toHaveAttribute('data-entry-id', 'ses-42');
  });

  it('closing the sheet returns to the plain list, with no lingering dialog', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'ses-42', kinfolkName: 'The Whitfields' })],
    });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'stub close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says the booking is unavailable when the selected id stops resolving, rather than opening an empty sheet', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'ses-42', kinfolkName: 'The Whitfields' })],
    });
    const { rerender } = render(<Bookings />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(screen.getByTestId('booking-detail-modal')).toBeInTheDocument();

    // The row leaves the bounded stream (deleted, or pushed past the 200 cap).
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    rerender(<Bookings />);
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
  });

  it('the sheet carries this screen\'s status transitions: a pending booking still offers Approve and Reject', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'ses-42', status: 'PENDING' })],
    });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    const sheet = screen.getByTestId('booking-detail-modal');
    expect(within(sheet).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('a scheduled booking still offers Mark Completed and Cancel, the pair BookingActions offered', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'ses-42', status: 'SCHEDULED' })],
    });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    const sheet = screen.getByTestId('booking-detail-modal');
    expect(within(sheet).getByRole('button', { name: 'Mark Completed' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('approving from the sheet confirms first, then writes, then closes the sheet', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'ses-42', status: 'PENDING' })],
    });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approveBooking).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Approve booking' }));
    expect(approveBooking).toHaveBeenCalledWith('ses-42');
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
  });

  it('the sheet\'s kinfolk and KinTale links reach the router', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'ses-42', kinfolkId: 'kf-9' })],
    });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('button', { name: /The Whitfields/i }));
    await userEvent.click(screen.getByRole('button', { name: 'stub open kinfolk' }));
    expect(navigate).toHaveBeenCalledWith({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'kf-9' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'stub open kintale' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/kintales', search: { kinTaleId: 'rep1' } });
  });
});
