// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  batchUpdateBookings,
} = vi.hoisted(() => ({
  approveBooking: vi.fn(),
  rejectBooking: vi.fn(),
  cancelBooking: vi.fn(),
  markBookingCompleted: vi.fn(),
  rescheduleBooking: vi.fn(),
  batchUpdateBookings: vi.fn(),
}));
vi.mock('../api/bookingsWrite', () => ({
  approveBooking,
  rejectBooking,
  cancelBooking,
  markBookingCompleted,
  rescheduleBooking,
  batchUpdateBookings,
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
  batchUpdateBookings
    .mockReset()
    .mockResolvedValue({ ok: true, action: 'APPROVE', updated: 0, failed: [] });
});

/** Turn Select on, then tick the checkbox for each named household. */
async function pick(...names: string[]) {
  await userEvent.click(screen.getByRole('button', { name: 'Select' }));
  for (const name of names) {
    await userEvent.click(screen.getByRole('checkbox', { name: new RegExp(`Select ${name}`) }));
  }
}

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
/**
 * The mock's Select toggle + floating bulk bar. What these own is the SCREEN's
 * half: selection state, when the bar appears, which ids reach which write, and
 * that a partial failure is rendered per booking. The decision logic behind it
 * (which rows a transition applies to, how the two legs' results fold together)
 * has its own direct suite in `lib/bookingBulk.test.ts`.
 */
describe('Bookings bulk actions', () => {
  const pendingPair = [
    entry({ _id: 's1', kinfolkName: 'Household One', status: 'PENDING', kinCareVisitId: 'v1' }),
    entry({ _id: 's2', kinfolkName: 'Household Two', status: 'PENDING', kinCareVisitId: 'v2' }),
  ];
  it('shows no checkboxes until Select is turned on', () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
  it('Select reveals one checkbox per row, and the bar stays hidden until something is picked', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).toBeNull();
  });
  it('the bar appears with the live count once rows are picked', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One');
    const bar = screen.getByRole('group', { name: 'Bulk actions' });
    expect(within(bar).getByText('1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /Select Household Two/ }));
    expect(within(bar).getByText('2')).toBeInTheDocument();
  });
  it('unticking a row takes it back out of the count', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('checkbox', { name: /Select Household Two/ }));
    expect(within(screen.getByRole('group', { name: 'Bulk actions' })).getByText('1')).toBeInTheDocument();
  });
  it('Clear empties the selection and hides the bar, leaving Select on', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });
  it('leaving Select mode drops the checkboxes and the selection with them', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One');
    await userEvent.click(screen.getByRole('button', { name: 'Done selecting' }));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).toBeNull();
  });
  it('asks before it writes, naming how many, and writes nothing until confirmed', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByText(/Approve 2 bookings\?/)).toBeInTheDocument();
    expect(approveBooking).not.toHaveBeenCalled();
    expect(batchUpdateBookings).not.toHaveBeenCalled();
  });
  it('Back leaves the selection intact and still writes nothing', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(rejectBooking).not.toHaveBeenCalled();
    expect(within(screen.getByRole('group', { name: 'Bulk actions' })).getByText('2')).toBeInTheDocument();
  });
  it('writes the flat session row for every picked booking, one call per id', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    await waitFor(() => expect(approveBooking).toHaveBeenCalledTimes(2));
    expect(approveBooking.mock.calls.map((c) => c[0]).sort()).toEqual(['s1', 's2']);
  });
  it('calls batchUpdateBookings with the ENVELOPE visit ids, never the session doc ids', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    // 'v1'/'v2', not 's1'/'s2'. The callable resolves ids through
    // collectionGroup('kinCares'), where a kin_care_sessions doc id resolves to
    // nothing at all, so sending those would be a guaranteed silent no-op.
    await waitFor(() => expect(batchUpdateBookings).toHaveBeenCalledTimes(1));
    const [ids, action] = batchUpdateBookings.mock.calls[0] as [string[], string];
    expect(ids.slice().sort()).toEqual(['v1', 'v2']);
    expect(action).toBe('APPROVE');
  });
  it('skips the callable entirely when no picked row has an envelope counterpart', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'legacy', kinfolkName: 'Legacy Household', status: 'PENDING' })],
    });
    render(<Bookings />);
    await pick('Legacy Household');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 1/ }));
    await waitFor(() => expect(approveBooking).toHaveBeenCalledWith('legacy'));
    // `ids: []` is rejected by the callable's own zod contract (min 1).
    expect(batchUpdateBookings).not.toHaveBeenCalled();
  });
  it('cancels scheduled visits through cancelBooking and the CANCEL transition', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 's9', kinfolkName: 'Booked Household', status: 'SCHEDULED', kinCareVisitId: 'v9' })],
    });
    render(<Bookings />);
    await pick('Booked Household');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, cancel 1/ }));
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('s9'));
    expect(batchUpdateBookings).toHaveBeenCalledWith(['v9'], 'CANCEL');
  });
  it('reports the outcome per booking, naming each household, never one generic error', async () => {
    approveBooking.mockImplementation((id: string) =>
      id === 's2' ? Promise.reject(new Error('permission-denied')) : Promise.resolve(undefined),
    );
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    expect(await screen.findByText('Approved 1 of 2 selected bookings.')).toBeInTheDocument();
    const failure = screen.getByText('Household Two', { selector: 'li strong' }).closest('li');
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toMatch(/permission-denied/);
    // The one that landed is not listed as a failure.
    expect(screen.queryByText('Household One', { selector: 'li strong' })).toBeNull();
  });
  it('surfaces a per-id callable failure against the household, not the raw envelope id', async () => {
    batchUpdateBookings.mockResolvedValue({
      ok: true,
      action: 'APPROVE',
      updated: 1,
      failed: [{ id: 'v2', error: 'not-found' }],
    });
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    expect(await screen.findByText('Approved 1 of 2 selected bookings.')).toBeInTheDocument();
    const failure = screen.getByText('Household Two', { selector: 'li strong' }).closest('li');
    expect(failure?.textContent).toMatch(/the household's copy of it was not \(not-found\)/i);
  });
  it('says so, separately, when the whole callable throws rather than reporting per-id failures', async () => {
    batchUpdateBookings.mockRejectedValue(new Error('unauthenticated'));
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    expect(await screen.findByText(/unauthenticated/)).toBeInTheDocument();
    expect(screen.getByText(/could not be updated/i)).toBeInTheDocument();
  });
  it('lists a row the action does not apply to as SKIPPED, and never writes it', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 's1', kinfolkName: 'Household One', status: 'PENDING' }),
        entry({ _id: 'sx', kinfolkName: 'Done Household', status: 'COMPLETED' }),
      ],
    });
    render(<Bookings />);
    await pick('Household One', 'Done Household');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    expect(await screen.findByText('Approved 1 of 2 selected bookings.')).toBeInTheDocument();
    expect(screen.getByText(/Skipped, nothing was written/)).toBeInTheDocument();
    expect(
      screen.getByText('Done Household', { selector: 'li strong' }).closest('li')?.textContent,
    ).toMatch(/Already completed/);
    expect(approveBooking).toHaveBeenCalledTimes(1);
    expect(approveBooking).toHaveBeenCalledWith('s1');
  });
  it('keeps the rows that did not land selected, so a retry is one press', async () => {
    approveBooking.mockImplementation((id: string) =>
      id === 's2' ? Promise.reject(new Error('permission-denied')) : Promise.resolve(undefined),
    );
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    expect(await screen.findByText('Approved 1 of 2 selected bookings.')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Bulk actions' })).getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Select Household Two/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Select Household One/ })).not.toBeChecked();
  });
  it('does not send the envelope leg for a row whose flat write just failed', async () => {
    approveBooking.mockImplementation((id: string) =>
      id === 's2' ? Promise.reject(new Error('permission-denied')) : Promise.resolve(undefined),
    );
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    // Confirming 'v2' in the household's copy while the admin's own list still
    // shows it pending is the exact divergence this bar exists to avoid.
    await waitFor(() => expect(batchUpdateBookings).toHaveBeenCalledTimes(1));
    expect(batchUpdateBookings).toHaveBeenCalledWith(['v1'], 'APPROVE');
  });
  it('a clean run says every selected booking was updated, with no failure list', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /Yes, approve 2/ }));
    expect(await screen.findByText('Approved 2 of 2 selected bookings.')).toBeInTheDocument();
    expect(screen.getByText(/Every selected booking was updated/)).toBeInTheDocument();
    expect(screen.queryByText(/Not applied/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).toBeNull();
  });
  it('the row still opens its detail while Select is on: picking is a sibling control, not a mode that eats the click', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One');
    await userEvent.click(screen.getByRole('button', { name: /Household Two/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
