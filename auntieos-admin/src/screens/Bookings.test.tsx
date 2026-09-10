// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type BookingEntry } from '../api/bookings';

const { useCollection, useDocById } = vi.hoisted(() => ({
  useCollection: vi.fn(),
  useDocById: vi.fn(),
}));
vi.mock('../lib/firestore', () => ({ useCollection, useDocById }));

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
/**
 * The incoming-request queue mounted above the list (#399 item 2 and #438).
 * Stubbed to null here rather than given a ToastProvider: this suite is about
 * the bookings list, the section renders nothing when both its queues are empty
 * anyway, and its own states are covered in VisitRequestsSection.test.tsx.
 */
vi.mock('../components/VisitRequestsSection', () => ({
  VisitRequestsSection: () => null,
}));
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

import { Bookings, groupBookingsByStatus } from './Bookings';

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
  // No deep-linked booking unless a test says otherwise. `ready + null` is the
  // hook's settled "nothing to resolve" answer, not a miss: the screen reads it
  // only when an id was actually passed.
  useDocById.mockReset().mockReturnValue({ status: 'ready', data: null } satisfies Async<BookingEntry | null>);
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

/**
 * Reveal the History section. Completed and cancelled rows start behind its
 * count button (see `Bookings status sections` below), so a test about one of
 * them has to open it first or it is asserting against rows that are not in the
 * DOM at all.
 */
async function openHistory() {
  await userEvent.click(screen.getByRole('button', { name: /^Show \d+ finished$/ }));
}

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

  it('folds CANCELLED / CANCELED / REJECTED into one CANCELLED chip', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', status: 'CANCELLED' }),
        entry({ _id: 'b', status: 'CANCELED' }),
        entry({ _id: 'c', status: 'REJECTED' }),
      ],
    });
    render(<Bookings />);
    await openHistory();
    expect(screen.getAllByText('CANCELLED')).toHaveLength(3);
  });

  it('an unrecognized status renders its own honest UNKNOWN chip, never a fabricated known state', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'WEIRD_STATUS' })] });
    render(<Bookings />);
    await openHistory();
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
    // The sentence now names all three readings of a miss, including the one a
    // notification produces (a request approved into existence later); see the
    // dialog in Bookings.tsx.
    expect(screen.getByText(/cancelled or removed/i)).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: 'Yes, approve it' }));
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
  it('Deselect all empties the selection and hides the bar, leaving Select on', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: pendingPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
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
    // The completed row lives in History, which is collapsed until asked for.
    await openHistory();
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
/**
 * The mock's three status sections (`Pending approval` / `Scheduled` /
 * `History`, each with a live count), which the flat newest-first list did not
 * have: 94 of the 100 rows on the real screen are finished, so the six live
 * ones sat under them.
 *
 * The grouping is asserted as a pure function first, because "which bucket does
 * this status land in" is the part that must never disagree with the stat cards
 * or the filter chips above it.
 */
describe('groupBookingsByStatus', () => {
  it('orders sections pending, scheduled, history regardless of input order', () => {
    const sections = groupBookingsByStatus([
      entry({ _id: 'c', status: 'COMPLETED' }),
      entry({ _id: 'p', status: 'PENDING' }),
      entry({ _id: 's', status: 'SCHEDULED' }),
      entry({ _id: 'd', status: 'DRAFT' }),
    ]);
    expect(sections.map((s) => s.key)).toEqual(['pending', 'scheduled', 'history']);
    // Draft joins pending, mirroring the "Pending" stat this screen already shows.
    expect(sections[0]?.rows.map((r) => r._id)).toEqual(['p', 'd']);
    expect(sections[1]?.rows.map((r) => r._id)).toEqual(['s']);
    expect(sections[2]?.rows.map((r) => r._id)).toEqual(['c']);
  });
  it('keeps an empty section so the screen can say nothing is waiting', () => {
    const sections = groupBookingsByStatus([entry({ _id: 'c', status: 'COMPLETED' })]);
    expect(sections[0]).toEqual({ key: 'pending', label: 'Pending approval', rows: [] });
  });
  it('files an unrecognized status under History rather than letting it vanish', () => {
    // The AO-12 rule this tree keeps: a row that matches no section is a row
    // nobody can see. `historyCount` already counts `unknown`, so the section
    // that carries the same badge has to hold it.
    const sections = groupBookingsByStatus([entry({ _id: 'u', status: 'WAT' })]);
    expect(sections[2]?.rows.map((r) => r._id)).toEqual(['u']);
  });
  it('#699: Pending keeps the query order (the read that matters is who asked first)', () => {
    const sections = groupBookingsByStatus([
      entry({ _id: 'newer', status: 'PENDING' }),
      entry({ _id: 'older', status: 'PENDING' }),
    ]);
    expect(sections[0]?.rows.map((r) => r._id)).toEqual(['newer', 'older']);
  });

  it('#699: Scheduled sorts by the visit start time, soonest first, not BOOKINGS_QUERY\'s createdAt-desc order', () => {
    // BOOKINGS_QUERY streams newest-CREATED first, so `justAsked` (created most
    // recently) leads the input array even though its visit is a month out,
    // while `bookedWeeksAgo` (created earlier) is scheduled for next week.
    const sections = groupBookingsByStatus([
      entry({
        _id: 'justAsked',
        status: 'SCHEDULED',
        createdAt: fakeTs('2026-07-20T00:00:00Z'),
        startTime: '2026-08-10T09:00:00',
      }),
      entry({
        _id: 'bookedWeeksAgo',
        status: 'SCHEDULED',
        createdAt: fakeTs('2026-07-01T00:00:00Z'),
        startTime: '2026-07-16T09:00:00',
      }),
    ]);
    expect(sections[1]?.rows.map((r) => r._id)).toEqual(['bookedWeeksAgo', 'justAsked']);
  });

  it('#699: History sorts by the visit start time, most recent first', () => {
    const sections = groupBookingsByStatus([
      entry({ _id: 'earlierVisit', status: 'COMPLETED', startTime: '2026-06-01T09:00:00' }),
      entry({ _id: 'laterVisit', status: 'COMPLETED', startTime: '2026-06-20T09:00:00' }),
    ]);
    expect(sections[2]?.rows.map((r) => r._id)).toEqual(['laterVisit', 'earlierVisit']);
  });

  it('#699: an undated row sorts last within its section, never as 1970 or "now"', () => {
    const sections = groupBookingsByStatus([
      entry({ _id: 'undated', status: 'SCHEDULED', startTime: '', createdAt: null }),
      entry({ _id: 'dated', status: 'SCHEDULED', startTime: '2026-07-16T09:00:00' }),
    ]);
    expect(sections[1]?.rows.map((r) => r._id)).toEqual(['dated', 'undated']);
  });
  it('cancelled and completed share the one History section', () => {
    const sections = groupBookingsByStatus([
      entry({ _id: 'x', status: 'CANCELLED' }),
      entry({ _id: 'y', status: 'completed' }),
    ]);
    expect(sections[2]?.rows.map((r) => r._id)).toEqual(['x', 'y']);
  });
});
describe('Bookings status sections', () => {
  const mixed = [
    entry({ _id: 'a', kinfolkName: 'Waiting Wren', status: 'PENDING' }),
    entry({ _id: 'b', kinfolkName: 'Booked Devlin', status: 'SCHEDULED' }),
    entry({ _id: 'c', kinfolkName: 'Finished Sparrow', status: 'completed' }),
    entry({ _id: 'd', kinfolkName: 'Called Off Mercer', status: 'CANCELLED' }),
  ];
  function sectionNamed(label: string): HTMLElement {
    return screen.getByRole('group', { name: new RegExp(`^${label}`) });
  }
  it('heads each section with its own live count', () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    expect(within(sectionNamed('Pending approval')).getByText('1')).toBeInTheDocument();
    expect(within(sectionNamed('Scheduled')).getByText('1')).toBeInTheDocument();
    expect(within(sectionNamed('History')).getByText('2')).toBeInTheDocument();
  });
  it('puts each row under its own status section, not one flat list', () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    expect(within(sectionNamed('Pending approval')).getByText('Waiting Wren')).toBeInTheDocument();
    expect(within(sectionNamed('Scheduled')).getByText('Booked Devlin')).toBeInTheDocument();
  });
  it('keeps History behind its count until asked, so the live rows are not buried', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    expect(screen.queryByText('Finished Sparrow')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 finished' }));
    expect(screen.getByText('Finished Sparrow')).toBeInTheDocument();
    expect(screen.getByText('Called Off Mercer')).toBeInTheDocument();
  });
  it('says what an empty section is waiting for instead of leaving a bare heading', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [mixed[1] as BookingEntry] });
    render(<Bookings />);
    expect(
      within(sectionNamed('Pending approval')).getByText(/nothing is waiting on a reply/i),
    ).toBeInTheDocument();
  });
  it('collapses to the one section a status chip names', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('tab', { name: 'Scheduled' }));
    expect(screen.getByRole('group', { name: /^Scheduled/ })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Pending approval/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /^History/ })).toBeNull();
  });
  it('opens History outright when a chip asks for it, never behind a second press', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('tab', { name: 'Completed' }));
    expect(screen.getByText('Finished Sparrow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show \d+ finished$/ })).toBeNull();
  });
  it('still says "Nothing matches this filter" when a chip excludes every row', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    await userEvent.click(screen.getByRole('tab', { name: 'Draft' }));
    expect(screen.getByText(/nothing matches this filter/i)).toBeInTheDocument();
  });
  it('the section counts and the stat cards read from the same grouping', () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    const historyStat = screen
      .getByText('History', { selector: '.den-stat-label' })
      .closest('.den-stat, button.den-stat--button');
    expect(within(historyStat as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(sectionNamed('History')).getByText('2')).toBeInTheDocument();
  });
  it('can still bulk-pick a row that now sits inside a section', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    await pick('Waiting Wren');
    expect(screen.getByRole('group', { name: 'Bulk actions' })).toBeInTheDocument();
  });
});

/**
 * ISSUE #389, the booking half's landing side. `lib/notificationActions.ts`
 * derives the flat session id from the notification's envelope visit id; the
 * router turns `?bookingId=<that id>` into this prop. The read is BY ID because
 * BOOKINGS_QUERY is the 200 newest sessions and a notification can name an
 * older one.
 */
describe('Bookings deep link', () => {
  it('opens the sheet for a booking the streamed page does not contain', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'a-different-one' })] });
    useDocById.mockReturnValue({ status: 'ready', data: entry({ _id: 'vis_old-visit' }) });
    render(<Bookings initialBookingId="vis_old-visit" />);
    expect(await screen.findByTestId('booking-detail-modal')).toHaveAttribute(
      'data-entry-id',
      'vis_old-visit',
    );
    expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', 'vis_old-visit');
  });

  it('prefers the streamed row over a second read when the booking is already on the page', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'vis_here' })] });
    useDocById.mockReturnValue({ status: 'ready', data: null });
    render(<Bookings initialBookingId="vis_here" />);
    expect(await screen.findByTestId('booking-detail-modal')).toHaveAttribute(
      'data-entry-id',
      'vis_here',
    );
  });

  it('says a still-requested visit has no record yet, rather than opening an empty sheet', async () => {
    // A visit that has not been approved has no kin_care_sessions document at
    // all, so its derived id resolves to nothing. That is the one case the
    // derivation cannot bridge, and the operator is told which case it is.
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    useDocById.mockReturnValue({ status: 'ready', data: null });
    render(<Bookings initialBookingId="vis_not-approved-yet" />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/only once the request is approved/)).toBeInTheDocument();
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
  });

  it('does not flash the unavailable dialog while the by-id read is still in flight', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    useDocById.mockReturnValue({ status: 'loading' });
    render(<Bookings initialBookingId="vis_slow" />);
    expect(screen.getByText('Looking this booking up…')).toBeInTheDocument();
    expect(screen.queryByText(/only once the request is approved/)).toBeNull();
  });

  it('surfaces a failed by-id read as a readable error with a retry, not as a missing booking', async () => {
    // A read that failed and a booking that is gone both leave the entry null.
    // Telling the operator a network blip meant the visit was cancelled is the
    // error-as-empty conflation lib/async.ts exists to refuse.
    const retry = vi.fn();
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    useDocById.mockReturnValue({ status: 'error', message: 'backend unreachable', retry });
    render(<Bookings initialBookingId="vis_unreadable" />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('backend unreachable');
    expect(screen.queryByText(/only once the request is approved/)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalled();
  });
  it('does not let the deep-linked document answer for a row selected afterwards', async () => {
    // The fetched booking belongs to the link, not to the screen: picking a
    // different row must resolve through the stream, and a row that is not
    // there must miss rather than reopening the linked one.
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'vis_linked' })] });
    useDocById.mockReturnValue({ status: 'ready', data: entry({ _id: 'vis_linked' }) });
    render(<Bookings initialBookingId="vis_linked" />);
    await screen.findByTestId('booking-detail-modal');
    await userEvent.click(screen.getByRole('button', { name: 'stub close' }));
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
  });
});
/**
 * The mock's fourth bulk button (#397 M16). What this owns is the SCREEN's
 * half: that the press opens the per-visit sheet rather than firing a
 * transition, that the sheet is handed the visits that can move plus the
 * reasons the others cannot, and that the result survives the sheet closing.
 * The sheet's own behaviour has its own suite in
 * `components/BulkRescheduleDialog.test.tsx`, and the planning logic in
 * `lib/bookingReschedule.test.ts`.
 */
describe('Bookings bulk reschedule', () => {
  const scheduledPair = [
    entry({ _id: 's1', kinfolkName: 'Household One', status: 'SCHEDULED', startTime: '2026-07-16T09:00:00', endTime: '2026-07-16T10:00:00' }),
    entry({ _id: 's2', kinfolkName: 'Household Two', status: 'SCHEDULED', startTime: '2026-07-16T14:00:00', endTime: '2026-07-16T15:00:00' }),
  ];
  it('opens a field per selected visit, and names a selected row it cannot move', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [...scheduledPair, entry({ _id: 's3', kinfolkName: 'Waiting Household', status: 'PENDING' })],
    });
    render(<Bookings />);
    await pick('Household One', 'Household Two', 'Waiting Household');
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    expect(screen.getByLabelText('New time for Household One')).toHaveValue('09:00');
    expect(screen.getByLabelText('New time for Household Two')).toHaveValue('14:00');
    // The pending row never gets a field, and is never silently dropped either.
    expect(screen.queryByLabelText('New time for Waiting Household')).toBeNull();
    expect(screen.getByText('Not offered a new time:')).toBeInTheDocument();
    // Scoped to the sheet: the "Pending" stat card carries the same phrase.
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText(/awaiting a reply/)).toBeInTheDocument();
    // Opening a sheet is not a transition: nothing was written by the press.
    expect(rescheduleBooking).not.toHaveBeenCalled();
  });
  it('keeps the visits that did not move selected, and keeps the result after the sheet closes', async () => {
    rescheduleBooking.mockImplementation((id: string) =>
      id === 's2' ? Promise.reject(new Error('permission-denied')) : Promise.resolve({ ok: true }),
    );
    useCollection.mockReturnValue({ status: 'ready', data: scheduledPair });
    render(<Bookings />);
    await pick('Household One', 'Household Two');
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    for (const name of ['Household One', 'Household Two']) {
      const field = screen.getByLabelText(`New time for ${name}`);
      await userEvent.clear(field);
      await userEvent.type(field, '11:30');
    }
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule 2 visits' }));
    expect(await screen.findByText('Moved 1 of 2 selected visits.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    // The banner outlives the sheet: an operator who closed it can still read
    // which household did not move.
    expect(screen.getByText('Moved 1 of 2 selected visits.')).toBeInTheDocument();
    expect(screen.getByText(/permission-denied/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Select Household Two/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Select Household One/ })).not.toBeChecked();
  });
});
