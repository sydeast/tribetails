// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { type Async } from '../lib/async';
import { type ScheduleSessionEntry } from '../api/schedule';
import { type BookingNoteEntry } from '../api/bookingNotes';
import { ToastProvider } from './Toast';

// A landed reschedule now confirms through useToast(), which throws outside a
// ToastProvider. Same wrap KinfolkEdit.test.tsx uses.
function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { rescheduleBooking, assignAuntie, addBookingNote, addInternalBookingNote, listVisitInternalNotes, getVisitAssignment } =
  vi.hoisted(() => ({
    rescheduleBooking: vi.fn(),
    assignAuntie: vi.fn(),
    addBookingNote: vi.fn(),
    addInternalBookingNote: vi.fn(),
    listVisitInternalNotes: vi.fn(),
    getVisitAssignment: vi.fn(),
  }));
vi.mock('../api/bookingsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/bookingsWrite')>()),
  rescheduleBooking,
  assignAuntie,
  addBookingNote,
  addInternalBookingNote,
  listVisitInternalNotes,
  getVisitAssignment,
}));

const { listStaff } = vi.hoisted(() => ({ listStaff: vi.fn() }));
vi.mock('../api/staff', async (orig) => ({
  ...(await orig<typeof import('../api/staff')>()),
  listStaff,
}));
// #1607: the notes name their staff writer through the shared roster read.
const { staffNames } = vi.hoisted(() => ({ staffNames: { current: new Map<string, string>() } }));
vi.mock('../lib/useStaffNames', () => ({ useStaffNames: () => staffNames.current }));

const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));

import { BookingDetailModal } from './BookingDetailModal';

// #1574: the fixtures here are fixed 2026 dates, and a visit is never moved
// into the past (nor a New visit scheduled there). The clock is pinned before
// the earliest of them; only Date is faked, so userEvent's timers run as normal.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});


// #1155: the DEVICE is America/Los_Angeles (UTC-7 in July) and the BUSINESS is
// America/Chicago (UTC-5), so a stored "...Z" instant must be re-read on the
// business clock everywhere below, and a typed time built on it.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const BIZ = 'America/Chicago';
const START = '2026-07-16T19:00:00.000Z'; // 14:00 business clock, 12:00 on the device
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
  listVisitInternalNotes.mockReset();
  listVisitInternalNotes.mockResolvedValue({ notes: [], canMarkAdminOnly: true, hasBookingRecord: true });
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
      businessZone={BIZ}
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

describe('BookingDetailModal: the request note on a booked visit (#1579)', () => {
  it('shows the household’s request note, which approval carries as kinfolkNotes', () => {
    open({ kinfolkNotes: 'QA- booking request test, safe to cancel', notes: '' });
    expect(factValue('From the household')).toHaveTextContent('QA- booking request test, safe to cancel');
    expect(screen.queryByText('Office note')).not.toBeInTheDocument();
  });
});
describe('BookingDetailModal fact rows', () => {
  it('#1592: names the requested service from the KinCare catalog, never the stored key', () => {
    open(
      { serviceType: '30minute' },
      { catalog: { serviceRates: { '30Minute': '30' }, serviceDurations: {}, timeBlocks: [] } },
    );
    expect(factValue('Requested services')).toHaveTextContent(/^30Minute$/);
  });

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
    // #1580: the session's own notes text is the first row of the internal-notes list now, not a fact.
    expect(screen.queryByText('Office note')).not.toBeInTheDocument();
    expect(factValue('From the household')).toHaveTextContent('None on the request');
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

  it('adds an internal note to the visit\'s one list, by its session (#1580)', async () => {
    addInternalBookingNote.mockResolvedValue({ noteId: 'n2', visibility: 'shared', storedOn: 'thread' });
    open();
    await screen.findByText('No internal notes yet.');
    await user.type(screen.getByLabelText('Add an internal note'), 'Gate code changed.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(addInternalBookingNote).toHaveBeenCalledWith({ sessionId: 'vis_v1' }, 'Gate code changed.', 'shared'),
    );
  });
  it('shows the same internal list Auntie Time shows, admin-only notes marked (#1580)', async () => {
    listVisitInternalNotes.mockResolvedValue({
      notes: [
        { id: 'session:vis_v1', body: 'Note from Auntie Time', authorRole: 'unknown', authorName: null, createdAtMs: null, visibility: 'shared', source: 'visitRecord' },
        { id: 'a1', body: 'Rate goes up', authorRole: 'admin', authorName: 'Syd', createdAtMs: 1_000, visibility: 'adminOnly', source: 'thread' },
      ],
      canMarkAdminOnly: true,
      hasBookingRecord: true,
    });
    open();
    const list = await screen.findByRole('list', { name: 'Internal notes' });
    expect(within(list).getByText('Note from Auntie Time')).toBeInTheDocument();
    expect(within(list).getByText('Admin only')).toBeInTheDocument();
    expect(listVisitInternalNotes).toHaveBeenCalledWith({ sessionId: 'vis_v1' });
  });

  it('renders the kinfolk-facing thread oldest first', () => {
    mockNotes({
      kinfolk: {
        status: 'ready',
        data: [
          { _id: 'n2', body: 'Second note', createdAt: '2026-07-15T12:00:00.000Z' },
          { _id: 'n1', body: 'First note', createdAt: '2026-07-15T09:00:00.000Z' },
        ],
      },
    });
    open();
    const thread = screen.getByRole('list', { name: 'Kinfolk-facing notes' });
    expect(within(thread).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('First note'),
      expect.stringContaining('Second note'),
    ]);
  });

  it('locks the kinfolk-facing composer inside the three hour cutoff and says why; internal notes stay open (#1580)', async () => {
    open({}, { nowMs: () => INSIDE_CUTOFF });
    expect(screen.getByLabelText('Add a kinfolk-facing note')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save kinfolk-facing note' })).toBeDisabled();
    expect(screen.getAllByText(/3 hours/i).length).toBeGreaterThanOrEqual(1);
    await screen.findByText('No internal notes yet.');
    expect(screen.getByLabelText('Add an internal note')).toBeEnabled();
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
  it('prefills the BUSINESS date and time of the current start, not the device one', () => {
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
    // 09:30 business clock (Chicago) on 2026-07-16 is 14:30Z; +90 minutes of service duration is 16:00Z.
    await waitFor(() =>
      expect(rescheduleBooking).toHaveBeenCalledWith(
        'vis_v1',
        '2026-07-16T14:30:00.000Z',
        '2026-07-16T16:00:00.000Z',
      ),
    );
    // The sheet closes on a landed reschedule (see ReschedulePanel's own doc),
    // so this is the only surface that can confirm it happened.
    expect(await screen.findByRole('status')).toHaveTextContent("The Whitfields's visit is rescheduled.");
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
  it('#1580: still lists and takes internal notes, which the server keeps on its visit record', async () => {
    listVisitInternalNotes.mockResolvedValue({ notes: [], canMarkAdminOnly: true, hasBookingRecord: false });
    open(legacy);
    await screen.findByText('No internal notes yet.');
    expect(screen.getByLabelText('Add an internal note')).toBeEnabled();
    // An admin-only note cannot be kept apart from Aunties on such a visit, so it is not offered.
    expect(screen.queryByRole('checkbox', { name: /admin only/i })).toBeNull();
  });

  it('still offers reschedule, which acts on the flat session doc', async () => {
    rescheduleBooking.mockResolvedValue({ ok: true, sessionId: 'vis_v1' });
    open(legacy);
    await user.click(screen.getByRole('button', { name: 'Reschedule visit' }));
    await waitFor(() => expect(rescheduleBooking).toHaveBeenCalled());
  });
});
