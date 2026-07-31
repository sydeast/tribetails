// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type ScheduleSessionEntry } from '../api/schedule';
import { type BookingNoteEntry } from '../api/bookingNotes';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { rescheduleBooking, assignAuntie, addBookingNote, addInternalBookingNote, getVisitAssignment } =
  vi.hoisted(() => ({
    rescheduleBooking: vi.fn(),
    assignAuntie: vi.fn(),
    addBookingNote: vi.fn(),
    addInternalBookingNote: vi.fn(),
    getVisitAssignment: vi.fn(),
  }));
vi.mock('../api/bookingsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/bookingsWrite')>()),
  rescheduleBooking,
  assignAuntie,
  addBookingNote,
  addInternalBookingNote,
  getVisitAssignment,
}));

const { listStaff } = vi.hoisted(() => ({ listStaff: vi.fn() }));
vi.mock('../api/staff', async (orig) => ({
  ...(await orig<typeof import('../api/staff')>()),
  listStaff,
}));

const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));

import { BookingDetailModal } from './BookingDetailModal';

// UTC-5 in July, so a stored "...Z" instant must be re-read as a LOCAL clock
// time everywhere below (the AO-18 convention).
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const START = '2026-07-16T19:00:00.000Z'; // 14:00 local
const WELL_BEFORE = Date.parse(START) - 24 * 60 * 60 * 1000;
const INSIDE_CUTOFF = Date.parse(START) - 60 * 60 * 1000;

function entry(over: Partial<ScheduleSessionEntry> = {}): ScheduleSessionEntry {
  return {
    _id: 'vis_v1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: [],
    serviceType: 'Dog Walk',
    startTime: START,
    endTime: '2026-07-16T20:30:00.000Z',
    serviceDurationMinutes: 90,
    status: 'SCHEDULED',
    notes: 'Side gate is sticky.',
    kinCareBatchId: 'b1',
    kinCareVisitId: 'v1',
    sourceBookingId: 'v1',
    ...over,
  };
}

const noNotes: Async<BookingNoteEntry[]> = { status: 'ready', data: [] };

function mockNotes(opts: { kinfolk?: Async<BookingNoteEntry[]>; internal?: Async<BookingNoteEntry[]> } = {}) {
  useCollection.mockImplementation((spec: { path: string }) => {
    if (spec.path.endsWith('/internalNotes')) return opts.internal ?? noNotes;
    if (spec.path.endsWith('/notes')) return opts.kinfolk ?? noNotes;
    throw new Error(`unexpected collection path in test: ${spec.path}`);
  });
}

const user = userEvent.setup();

beforeEach(() => {
  useCollection.mockReset();
  mockNotes();
  rescheduleBooking.mockReset();
  assignAuntie.mockReset();
  addBookingNote.mockReset();
  addInternalBookingNote.mockReset();
  getVisitAssignment.mockReset();
  getVisitAssignment.mockResolvedValue({ assignedAuntieUid: null, auntieDisplayName: null });
  listStaff.mockReset();
  getKinfolkProfile.mockReset();
  getKinfolkProfile.mockResolvedValue({ _id: 'kf1', serviceAddress: '412 Mockingbird Ln' });
});

function open(over: Partial<ScheduleSessionEntry> = {}, props: Record<string, unknown> = {}) {
  return render(
    <BookingDetailModal
      entry={entry(over)}
      onClose={vi.fn()}
      nowMs={() => WELL_BEFORE}
      {...props}
    />,
  );
}

/** The fact row's value cell, looked up by its label (a <dt>/<dd> pair). */
function factValue(label: string): HTMLElement {
  const dt = screen.getByText(label);
  const dd = dt.parentElement?.querySelector('dd');
  if (!dd) throw new Error(`no value cell for fact row "${label}"`);
  return dd as HTMLElement;
}

describe('BookingDetailModal fact rows', () => {
  it('is a real dialog, not a styled div', () => {
    open();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('shows every fact the operator asked for: kinfolk, address, services, duration, date and time', async () => {
    open();
    expect(factValue('Kinfolk')).toHaveTextContent('The Whitfields');
    expect(factValue('Requested services')).toHaveTextContent('Dog Walk');
    expect(factValue('Duration')).toHaveTextContent('1 hr 30 min');
    expect(factValue('When')).toHaveTextContent('Thu, Jul 16 at 2:00 PM');
    expect(factValue('Status')).toHaveTextContent('SCHEDULED');
    expect(factValue('Booking notes')).toHaveTextContent('Side gate is sticky.');
    await waitFor(() => expect(factValue('Address')).toHaveTextContent('412 Mockingbird Ln'));
    expect(getKinfolkProfile).toHaveBeenCalledWith('kf1');
  });

  it('says the address is not on file rather than rendering a blank row', async () => {
    getKinfolkProfile.mockResolvedValue({ _id: 'kf1', serviceAddress: '' });
    open();
    await waitFor(() => expect(factValue('Address')).toHaveTextContent('Not on file'));
  });

  it('surfaces an address load failure instead of pretending there is no address', async () => {
    getKinfolkProfile.mockRejectedValue(new Error('permission-denied'));
    open();
    await waitFor(() => expect(factValue('Address')).toHaveTextContent('permission-denied'));
  });

  it('navigates to the kinfolk detail from the kinfolk name', async () => {
    const onOpenKinfolk = vi.fn();
    open({}, { onOpenKinfolk });
    await user.click(within(factValue('Kinfolk')).getByRole('button', { name: /The Whitfields/ }));
    expect(onOpenKinfolk).toHaveBeenCalledWith('kf1');
  });

  it('renders the kinfolk name as static text when there is nowhere to go (no dead control)', () => {
    open();
    expect(within(factValue('Kinfolk')).queryByRole('button')).toBeNull();
    expect(factValue('Kinfolk')).toHaveTextContent('The Whitfields');
  });

  it('links to the visit KinTale when one has been sent', async () => {
    const onOpenKinTale = vi.fn();
    open({ reportIds: ['rep1'] }, { onOpenKinTale });
    await user.click(screen.getByRole('button', { name: /Open the KinTale/i }));
    expect(onOpenKinTale).toHaveBeenCalledWith('rep1');
  });

  it('says no KinTale yet rather than showing an empty link', () => {
    open({ reportIds: [] }, { onOpenKinTale: vi.fn() });
    expect(screen.queryByRole('button', { name: /Open the KinTale/i })).toBeNull();
    expect(screen.getByText(/No KinTale for this visit yet/i)).toBeInTheDocument();
  });
});

describe('BookingDetailModal actions slot', () => {
  it('renders the caller-owned status transitions inside the sheet', () => {
    open({}, { actions: <button type="button">Approve</button> });
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }),
    ).toBeInTheDocument();
  });

  it('renders NOTHING in that slot when the caller passes none, so a screen with no transitions to offer shows no empty panel', () => {
    open();
    // Schedule.tsx opens this same sheet without an actions slot. The three
    // panels it does own still render; nothing stands in for the missing one.
    expect(screen.getByText('Staffing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByText('Actions')).toBeNull();
  });
});

describe('BookingDetailModal notes', () => {
  it('adds a kinfolk-facing note through the portal callable', async () => {
    addBookingNote.mockResolvedValue({ noteId: 'n1' });
    open();
    await user.type(screen.getByLabelText('Add a kinfolk-facing note'), 'Walked the long loop.');
    await user.click(screen.getByRole('button', { name: 'Save kinfolk-facing note' }));
    await waitFor(() =>
      expect(addBookingNote).toHaveBeenCalledWith('kf1', 'b1', 'v1', 'Walked the long loop.'),
    );
  });

  it('adds an internal note through the admin callable', async () => {
    addInternalBookingNote.mockResolvedValue({ noteId: 'n2' });
    open();
    await user.type(screen.getByLabelText('Add an internal note'), 'Gate code changed.');
    await user.click(screen.getByRole('button', { name: 'Save internal note' }));
    await waitFor(() =>
      expect(addInternalBookingNote).toHaveBeenCalledWith('kf1', 'b1', 'v1', 'Gate code changed.'),
    );
  });

  it('renders both existing threads oldest first', () => {
    mockNotes({
      kinfolk: {
        status: 'ready',
        data: [
          { _id: 'n2', body: 'Second note', createdAt: '2026-07-15T12:00:00.000Z' },
          { _id: 'n1', body: 'First note', createdAt: '2026-07-15T09:00:00.000Z' },
        ],
      },
      internal: { status: 'ready', data: [{ _id: 'i1', body: 'Staff only' }] },
    });
    open();
    const thread = screen.getByRole('list', { name: 'Kinfolk-facing notes' });
    expect(within(thread).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('First note'),
      expect.stringContaining('Second note'),
    ]);
    expect(
      within(screen.getByRole('list', { name: 'Internal notes' })).getByText('Staff only'),
    ).toBeInTheDocument();
  });

  it('locks BOTH composers inside the three hour cutoff and says why', async () => {
    open({}, { nowMs: () => INSIDE_CUTOFF });
    expect(screen.getByLabelText('Add a kinfolk-facing note')).toBeDisabled();
    expect(screen.getByLabelText('Add an internal note')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save kinfolk-facing note' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save internal note' })).toBeDisabled();
    // The reason, not just a grey control: one banner per locked composer.
    expect(screen.getAllByText(/locked/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/3 hours/i).length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a note callable rejection fail-loud rather than a silent no-op', async () => {
    addBookingNote.mockRejectedValue(new Error('Notes cannot be edited within 3 hours of booking start window.'));
    open();
    await user.type(screen.getByLabelText('Add a kinfolk-facing note'), 'late');
    await user.click(screen.getByRole('button', { name: 'Save kinfolk-facing note' }));
    expect(await screen.findByText(/within 3 hours of booking start window/)).toBeInTheDocument();
  });
});

describe('BookingDetailModal reschedule', () => {
  it('prefills the LOCAL date and time of the current start', () => {
    open();
    expect(screen.getByLabelText('New date')).toHaveValue('2026-07-16');
    expect(screen.getByLabelText('New time')).toHaveValue('14:00');
  });

  it('invokes rescheduleBooking with the end recomputed from the service duration', async () => {
    rescheduleBooking.mockResolvedValue({ ok: true, sessionId: 'vis_v1' });
    open();
    // fireEvent, not userEvent.type: jsdom sanitises a partial value on an
    // <input type="time"> to '', so typing it character by character never
    // lands. The component reads the change event either way.
    fireEvent.change(screen.getByLabelText('New time'), { target: { value: '09:30' } });
    await user.click(screen.getByRole('button', { name: 'Reschedule visit' }));
    // 09:30 local on 2026-07-16 is 14:30Z; +90 minutes of service duration is 16:00Z.
    await waitFor(() =>
      expect(rescheduleBooking).toHaveBeenCalledWith(
        'vis_v1',
        '2026-07-16T14:30:00.000Z',
        '2026-07-16T16:00:00.000Z',
      ),
    );
  });

  it('surfaces a reschedule rejection fail-loud', async () => {
    rescheduleBooking.mockRejectedValue(new Error("Session 'vis_v1' not found."));
    open();
    await user.click(screen.getByRole('button', { name: 'Reschedule visit' }));
    expect(await screen.findByText(/not found/)).toBeInTheDocument();
  });
});

describe('BookingDetailModal assigned Auntie', () => {
  it('reads the canonical assignment off the visit doc on open', async () => {
    getVisitAssignment.mockResolvedValue({ assignedAuntieUid: 'u1', auntieDisplayName: 'Auntie Ruth' });
    open();
    await waitFor(() => expect(factValue('Assigned Auntie')).toHaveTextContent('Auntie Ruth'));
    expect(getVisitAssignment).toHaveBeenCalledWith('kf1', 'b1', 'v1');
  });

  it('loads the roster lazily, only when the picker is opened', async () => {
    listStaff.mockResolvedValue([{ uid: 'u1', displayName: 'Auntie Ruth', email: null }]);
    open();
    await waitFor(() => expect(getVisitAssignment).toHaveBeenCalled());
    expect(listStaff).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Choose an Auntie' }));
    await waitFor(() => expect(listStaff).toHaveBeenCalledTimes(1));
  });

  it('swaps optimistically, then settles on the canonical name from the re-read', async () => {
    listStaff.mockResolvedValue([{ uid: 'u1', displayName: 'Ruth', email: null }]);
    let resolveAssign: (v: unknown) => void = () => {};
    assignAuntie.mockReturnValue(new Promise((res) => { resolveAssign = res; }));
    open();
    await user.click(screen.getByRole('button', { name: 'Choose an Auntie' }));
    await user.click(await screen.findByRole('button', { name: 'Ruth' }));

    // Optimistic: the row already reads the new Auntie while the callable is in flight.
    expect(factValue('Assigned Auntie')).toHaveTextContent('Ruth');
    expect(assignAuntie).toHaveBeenCalledWith('kf1', 'b1', 'v1', 'u1');

    getVisitAssignment.mockResolvedValue({
      assignedAuntieUid: 'u1',
      auntieDisplayName: 'Ruth Whitfield',
    });
    resolveAssign({ ok: true, visitId: 'v1', auntieUid: 'u1' });
    await waitFor(() => expect(factValue('Assigned Auntie')).toHaveTextContent('Ruth Whitfield'));
  });

  it('REVERTS the optimistic swap and says why when the callable rejects', async () => {
    getVisitAssignment.mockResolvedValue({ assignedAuntieUid: 'u0', auntieDisplayName: 'Auntie Prior' });
    listStaff.mockResolvedValue([{ uid: 'u1', displayName: 'Ruth', email: null }]);
    assignAuntie.mockRejectedValue(new Error('assignAuntie: no staff record for that uid.'));
    open();
    await waitFor(() => expect(factValue('Assigned Auntie')).toHaveTextContent('Auntie Prior'));
    await user.click(screen.getByRole('button', { name: 'Choose an Auntie' }));
    await user.click(await screen.findByRole('button', { name: 'Ruth' }));

    expect(await screen.findByText(/no staff record for that uid/)).toBeInTheDocument();
    expect(factValue('Assigned Auntie')).toHaveTextContent('Auntie Prior');
  });

  it('surfaces a roster load failure with a retry rather than an empty picker', async () => {
    listStaff.mockRejectedValue(new Error('permission-denied'));
    open();
    await user.click(screen.getByRole('button', { name: 'Choose an Auntie' }));
    expect(await screen.findByText(/permission-denied/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('BookingDetailModal on a non-envelope (legacy flat) visit', () => {
  const legacy = { kinCareBatchId: '', kinCareVisitId: '' };

  it('disables the assign control WITH the reason, never silently omits it', () => {
    open(legacy);
    expect(screen.getByRole('button', { name: 'Choose an Auntie' })).toBeDisabled();
    expect(
      screen.getByText(/not part of a booking request, so there is no visit record to assign against/i),
    ).toBeInTheDocument();
    expect(getVisitAssignment).not.toHaveBeenCalled();
  });

  it('explains why the note threads are unavailable instead of showing empty ones', () => {
    open(legacy);
    expect(useCollection).not.toHaveBeenCalled();
    expect(screen.getAllByText(/no visit record to attach notes to/i).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Add a kinfolk-facing note')).toBeNull();
  });

  it('still offers reschedule, which acts on the flat session doc', async () => {
    rescheduleBooking.mockResolvedValue({ ok: true, sessionId: 'vis_v1' });
    open(legacy);
    await user.click(screen.getByRole('button', { name: 'Reschedule visit' }));
    await waitFor(() => expect(rescheduleBooking).toHaveBeenCalled());
  });
});
