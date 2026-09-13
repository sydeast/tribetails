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
 * The screen reads `business_settings` once, for the KinCare catalog and the
 * time blocks its rows name (#704). Mocked here the way Schedule.test.tsx mocks
 * the same call, so this suite never reaches a real Firestore read. The default
 * below is the OPERATOR'S REAL CATALOG SHAPE (rate keys like `30Minute`, named
 * morning and midday blocks), because that is what makes the raw `visit_60` and
 * `60Mins` labels on the live screen resolvable at all.
 */
const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings }));

const TEST_SETTINGS = {
  serviceRates: { '30Minute': '25', '60Minute': '45' },
  serviceDurations: {},
  timeBlocks: [
    { id: 'morning', label: 'Morning', startTime: '08:00', endTime: '11:00', active: true },
    { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
  ],
};

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
  getBusinessSettings.mockReset().mockResolvedValue(TEST_SETTINGS);
});

/**
 * The Select toggle, of which there are now TWO on the screen and ONE mode
 * behind them (#701): one in the page heading, one on the list toolbar directly
 * above the sections it picks rows from. `index` says which control to press.
 */
function selectToggle(index = 0): HTMLElement {
  return screen.getAllByRole('button', { name: 'Select' })[index] as HTMLElement;
}

/** Turn Select on, then tick the checkbox for each named household. */
async function pick(...names: string[]) {
  await userEvent.click(selectToggle());
  for (const name of names) {
    await userEvent.click(screen.getByRole('checkbox', { name: new RegExp(`Select ${name}`) }));
  }
}

describe('Bookings screen', () => {
  it('renders a streamed row with its household, service, when, and status chip', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Bookings />);
    // Scope by the row container: the row is a real <button> now that Bookings
    // wires its own onSelectBooking default (opening BookingActions), see the
    // "opens BookingActions" tests below for the interactive assertions.
    const row = screen.getByText('The Whitfields').closest('.bookings__row') as HTMLElement;
    expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
    // ONE line built by one formatter: service, the visit's own date, then the
    // operator's named window (09:00 sits inside the Morning block above).
    // Awaited because the window comes from the one-shot `business_settings`
    // read: before it lands the row honestly shows the clock time instead.
    expect(
      await within(row).findByText('Dog Walking · Jul 16 · Morning block'),
    ).toBeInTheDocument();
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

  it('#704: the heading is the mock\'s plain "Bookings" with its sub-copy, and carries Select and New booking', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Bookings />);
    expect(screen.getByRole('heading', { level: 1, name: 'Bookings' })).toBeInTheDocument();
    expect(screen.getByText('Pending requests and scheduled visits')).toBeInTheDocument();
    // The old heading read "Every visit." with a longer, differently-worded sub.
    expect(screen.queryByText(/^Every/)).toBeNull();
    expect(screen.getByRole('button', { name: 'New booking' })).toBeInTheDocument();
    expect(selectToggle()).toBeInTheDocument();
  });

  it('#704: Select is a toggle that reports an on state, not a button that renames itself', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Bookings />);
    expect(selectToggle()).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(selectToggle());
    // BOTH controls report the mode, because there is only one mode (#701).
    for (const toggle of screen.getAllByRole('button', { name: 'Select' })) {
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
    }
  });

  it('#704: there is no filter tab row, and every status still renders under its own section', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', kinfolkName: 'Row A', status: 'DRAFT' }),
        entry({ _id: 'b', kinfolkName: 'Row B', status: 'SCHEDULED' }),
        entry({ _id: 'c', kinfolkName: 'Row C', status: 'COMPLETED' }),
      ],
    });
    render(<Bookings />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('tablist')).toBeNull();
    // Nothing became unreachable in the removal: all three are on screen at once.
    expect(screen.getByText('Row A')).toBeInTheDocument();
    expect(screen.getByText('Row B')).toBeInTheDocument();
    expect(screen.getByText('Row C')).toBeInTheDocument();
  });

  it('#704: the Pending / Scheduled / History stat strip is gone, its numbers being the section chips', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', status: 'DRAFT' }),
        entry({ _id: 'b', status: 'PENDING' }),
        entry({ _id: 'c', status: 'SCHEDULED' }),
      ],
    });
    render(<Bookings />);
    expect(document.querySelectorAll('.den-stat-label')).toHaveLength(0);
    // DRAFT and PENDING still count as one bucket, mirroring BookingScreen.kt's
    // "Pending approval"; the chip on the section heading is where it is stated.
    const pending = screen.getByRole('group', { name: /^Pending approval/ });
    expect(within(pending).getByText('2')).toBeInTheDocument();
  });

  it('#704: each card wears a left accent stripe in its own status colour', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', kinfolkName: 'Waiting Wren', status: 'PENDING' }),
        entry({ _id: 'b', kinfolkName: 'Booked Devlin', status: 'SCHEDULED' }),
        entry({ _id: 'c', kinfolkName: 'Finished Sparrow', status: 'COMPLETED' }),
        entry({ _id: 'd', kinfolkName: 'Called Off Mercer', status: 'CANCELLED' }),
      ],
    });
    render(<Bookings />);
    function accentOf(name: string): HTMLElement {
      const row = screen.getByText(name).closest('.bookings__row') as HTMLElement;
      return row.querySelector('.bookings__row-accent') as HTMLElement;
    }
    expect(accentOf('Waiting Wren').className).toContain('bookings__row-accent--pending');
    expect(accentOf('Booked Devlin').className).toContain('bookings__row-accent--scheduled');
    expect(accentOf('Finished Sparrow').className).toContain('bookings__row-accent--completed');
    expect(accentOf('Called Off Mercer').className).toContain('bookings__row-accent--cancelled');
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
    // Scoped to the sheet: the card carries its own Approve now (#755), and
    // this test is about the sheet's.
    const sheet = screen.getByTestId('booking-detail-modal');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Approve' }));
    expect(approveBooking).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, approve it' }));
    expect(approveBooking).toHaveBeenCalledWith('ses-42');
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
  });

  /**
   * The mock's own card buttons (#755): Approve / Reject on a pending card,
   * Cancel on a scheduled one, none on history. Each opens the fuller record
   * with that question already posed, never a write from the list.
   */
  describe('the card\'s own transition buttons', () => {
    const three = [
      entry({ _id: 'p', kinfolkName: 'Waiting Wren', status: 'PENDING' }),
      entry({ _id: 's', kinfolkName: 'Booked Devlin', status: 'SCHEDULED' }),
      entry({ _id: 'h', kinfolkName: 'Finished Sparrow', status: 'COMPLETED' }),
    ];

    it('draws Approve and Reject on a pending card, Cancel on a scheduled one, nothing on history', () => {
      useCollection.mockReturnValue({ status: 'ready', data: three });
      render(<Bookings />);
      const wren = screen.getByRole('group', { name: 'Actions for Waiting Wren' });
      expect(within(wren).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(within(wren).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
      const devlin = screen.getByRole('group', { name: 'Actions for Booked Devlin' });
      expect(within(devlin).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(within(devlin).queryByRole('button', { name: 'Approve' })).toBeNull();
      expect(screen.queryByRole('group', { name: 'Actions for Finished Sparrow' })).toBeNull();
    });

    it('Approve on the card opens the sheet with the question posed, and writes only on the confirm', async () => {
      useCollection.mockReturnValue({ status: 'ready', data: three });
      render(<Bookings />);
      const wren = screen.getByRole('group', { name: 'Actions for Waiting Wren' });
      await userEvent.click(within(wren).getByRole('button', { name: 'Approve' }));
      const sheet = screen.getByTestId('booking-detail-modal');
      expect(sheet.dataset['entryId']).toBe('p');
      expect(within(sheet).getByText('Approve this booking?')).toBeInTheDocument();
      expect(approveBooking).not.toHaveBeenCalled();
      await userEvent.click(within(sheet).getByRole('button', { name: 'Yes, approve it' }));
      expect(approveBooking).toHaveBeenCalledWith('p');
      expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
    });

    it('Cancel on a scheduled card poses the cancel question; a plain row click afterwards poses none', async () => {
      useCollection.mockReturnValue({ status: 'ready', data: three });
      render(<Bookings />);
      const devlin = screen.getByRole('group', { name: 'Actions for Booked Devlin' });
      await userEvent.click(within(devlin).getByRole('button', { name: 'Cancel' }));
      let sheet = screen.getByTestId('booking-detail-modal');
      expect(within(sheet).getByText('Cancel this scheduled visit?')).toBeInTheDocument();
      expect(cancelBooking).not.toHaveBeenCalled();
      await userEvent.click(within(sheet).getByRole('button', { name: 'stub close' }));
      // The question does not leak into the next open.
      await userEvent.click(screen.getByRole('button', { name: /Booked Devlin/i }));
      sheet = screen.getByTestId('booking-detail-modal');
      expect(within(sheet).queryByText('Cancel this scheduled visit?')).toBeNull();
      expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('the buttons leave the cards while Select is on: the bulk bar owns the transitions then', async () => {
      useCollection.mockReturnValue({ status: 'ready', data: three });
      render(<Bookings />);
      await userEvent.click(selectToggle());
      expect(screen.queryByRole('group', { name: /^Actions for/ })).toBeNull();
    });

    it('an external onSelectBooking owns the sheet, so the cards draw no buttons', () => {
      useCollection.mockReturnValue({ status: 'ready', data: three });
      render(<Bookings onSelectBooking={vi.fn()} />);
      expect(screen.queryByRole('group', { name: /^Actions for/ })).toBeNull();
    });
  });

  /**
   * The skin of the list on the navy ground (#755), against
   * `auntieos-manage-bookings-2026-05-27-*.html`: serif section heads with a
   * quiet count, one glass card per booking that lifts, and the kit's status
   * pill in the state's own tone.
   */
  describe('the mock\'s shape on the navy ground', () => {
    it('each section is a staggered block with a serif heading and a plain count', () => {
      useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'PENDING' })] });
      render(<Bookings />);
      const pending = screen.getByRole('group', { name: /^Pending approval/ });
      expect(pending.className).toContain('d1');
      expect(screen.getByRole('group', { name: /^Scheduled/ }).className).toContain('d2');
      expect(screen.getByRole('group', { name: /^History/ }).className).toContain('d3');
      const head = within(pending).getByRole('heading', { level: 2 });
      expect(head.className).toBe('bookings__section-head');
      expect(head.querySelector('.bookings__section-count')?.textContent).toBe('1');
    });

    it('a card that opens the sheet is the surface that lifts; its buttons sit beside the row, not inside it', () => {
      useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'PENDING' })] });
      render(<Bookings />);
      const card = screen.getByText('The Whitfields').closest('.bookings__row') as HTMLElement;
      expect(card.className).toContain('lift');
      const rowButton = screen.getByRole('button', { name: /The Whitfields/i });
      expect(rowButton.className).not.toContain('lift');
      expect(rowButton.querySelector('button')).toBeNull();
      expect(card.querySelector('.bookings__row-acts')).not.toBeNull();
    });

    it('the status pill is the kit\'s, in the state\'s own tone, with no screen-local chip class', () => {
      useCollection.mockReturnValue({
        status: 'ready',
        data: [
          entry({ _id: 'a', kinfolkName: 'Draft Dune', status: 'DRAFT' }),
          entry({ _id: 'b', kinfolkName: 'Waiting Wren', status: 'PENDING' }),
          entry({ _id: 'c', kinfolkName: 'Booked Devlin', status: 'SCHEDULED' }),
          entry({ _id: 'd', kinfolkName: 'Finished Sparrow', status: 'COMPLETED' }),
          entry({ _id: 'e', kinfolkName: 'Called Off Mercer', status: 'CANCELLED' }),
        ],
      });
      render(<Bookings />);
      function pillOf(name: string): HTMLElement {
        const who = screen.getByText(name).closest('.bookings__row-who') as HTMLElement;
        return who.querySelector('.den-statuspill') as HTMLElement;
      }
      expect(pillOf('Draft Dune').dataset['tone']).toBe('error');
      expect(pillOf('Waiting Wren').dataset['tone']).toBe('orange');
      expect(pillOf('Booked Devlin').dataset['tone']).toBe('teal');
      expect(pillOf('Finished Sparrow').dataset['tone']).toBe('purple');
      // Muted and NOT struck: this mock's `.pill.cancelled` is a plain capsule.
      const cancelled = pillOf('Called Off Mercer');
      expect(cancelled.dataset['tone']).toBe('muted');
      expect(cancelled.className).not.toContain('struck');
      expect(document.querySelector('.bookings__chip')).toBeNull();
    });
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
    await userEvent.click(selectToggle());
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
    await userEvent.click(selectToggle());
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
  it('#704: all three sections are on screen, History open rather than behind "Show N finished"', () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    for (const label of ['Pending approval', 'Scheduled', 'History']) {
      expect(sectionNamed(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Finished Sparrow')).toBeInTheDocument();
    expect(screen.getByText('Called Off Mercer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /finished$/ })).toBeNull();
  });

  it('#704: a long History is PAGED, not collapsed, and Load more says how many are left', async () => {
    const history = Array.from({ length: 30 }, (_v, i) =>
      entry({ _id: `h${String(i)}`, kinfolkName: `Past ${String(i)}`, status: 'COMPLETED' }),
    );
    useCollection.mockReturnValue({ status: 'ready', data: history });
    render(<Bookings />);
    // The heading still states the WHOLE section, so a paged list never
    // understates what is under it.
    expect(within(sectionNamed('History')).getByText('30')).toBeInTheDocument();
    expect(within(sectionNamed('History')).getAllByRole('listitem')).toHaveLength(25);
    await userEvent.click(screen.getByRole('button', { name: 'Load 5 more' }));
    expect(within(sectionNamed('History')).getAllByRole('listitem')).toHaveLength(30);
    expect(screen.queryByRole('button', { name: /^Load \d+ more$/ })).toBeNull();
  });
  it('says what an empty section is waiting for instead of leaving a bare heading', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [mixed[1] as BookingEntry] });
    render(<Bookings />);
    expect(
      within(sectionNamed('Pending approval')).getByText(/nothing is waiting on a reply/i),
    ).toBeInTheDocument();
  });
  it('#701: the Select toggle on the list header turns select mode on, next to the rows it picks', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: mixed });
    render(<Bookings />);
    const listBar = screen.getByRole('group', { name: 'Bookings list' });
    const onTheList = within(listBar).getByRole('button', { name: 'Select' });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    await userEvent.click(onTheList);
    expect(screen.getAllByRole('checkbox')).toHaveLength(mixed.length);
    expect(onTheList).toHaveAttribute('aria-pressed', 'true');
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
