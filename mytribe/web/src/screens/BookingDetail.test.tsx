// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingDetail } from './BookingDetail';
import type { GetBookingPolicyResult, GetBusinessClosuresResult } from '../api/bookingApi';
import type {
  AddBookingNoteResult,
  GetBookingNotesResult,
  GetMyBookingsResult,
  GetMyBookingsResultLiveVisit,
  RequestBookingCancellationResult,
  RequestBookingRescheduleResult,
} from '../contracts/bookingContracts.generated';

const mocks = vi.hoisted(() => ({
  getMyBookings: vi.fn<() => Promise<GetMyBookingsResult>>(),
  getBookingNotes: vi.fn<(kinfolkId: string, batchId: string, visitId: string) => Promise<GetBookingNotesResult>>(),
  getBookingPolicy: vi.fn<() => Promise<GetBookingPolicyResult>>(),
  getBusinessClosures: vi.fn<() => Promise<GetBusinessClosuresResult>>(),
  getMyVisits: vi.fn(),
  addBookingNote: vi.fn<(kinfolkId: string, batchId: string, visitId: string, body: string) => Promise<AddBookingNoteResult>>(),
  requestBookingCancellation: vi.fn<
    (kinfolkId: string, batchId: string, visitId: string, reason?: string) => Promise<RequestBookingCancellationResult>
  >(),
  requestBookingReschedule: vi.fn<
    (
      kinfolkId: string,
      batchId: string,
      visitId: string,
      proposedStartTimeMs: number,
      reason?: string,
      timeBlockId?: string | null,
    ) => Promise<RequestBookingRescheduleResult>
  >(),
}));

vi.mock('../api/portal', () => ({
  getMyBookings: () => mocks.getMyBookings(),
  getMyVisits: (...args: unknown[]) => mocks.getMyVisits(...args),
}));
vi.mock('../components/RouteMap', () => ({ RouteMap: () => <div data-testid="route-map" /> }));
vi.mock('../api/bookingApi', () => ({
  getBookingNotes: (kinfolkId: string, batchId: string, visitId: string) => mocks.getBookingNotes(kinfolkId, batchId, visitId),
  getBookingPolicy: () => mocks.getBookingPolicy(),
  getBusinessClosures: () => mocks.getBusinessClosures(),
  addBookingNote: (kinfolkId: string, batchId: string, visitId: string, body: string) =>
    mocks.addBookingNote(kinfolkId, batchId, visitId, body),
  requestBookingCancellation: (kinfolkId: string, batchId: string, visitId: string, reason?: string) =>
    mocks.requestBookingCancellation(kinfolkId, batchId, visitId, reason),
  requestBookingReschedule: (
    kinfolkId: string,
    batchId: string,
    visitId: string,
    proposedStartTimeMs: number,
    reason?: string,
    timeBlockId?: string | null,
  ) => mocks.requestBookingReschedule(kinfolkId, batchId, visitId, proposedStartTimeMs, reason, timeBlockId),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ visitId: 'v1' }),
  Link: ({ children, to, search, params }: { children?: ReactNode; to?: string; search?: unknown; params?: unknown }) => (
    <a href="#" data-to={to} data-search={JSON.stringify(search ?? null)} data-params={JSON.stringify(params ?? null)}>
      {children}
    </a>
  ),
}));

function booking(overrides: Partial<GetMyBookingsResultLiveVisit> = {}): GetMyBookingsResultLiveVisit {
  return {
    id: 'v1',
    batchId: 'b1',
    kinfolkId: 'fam1',
    status: 'confirmed',
    serviceType: 'Drop-in Visit',
    // #1297: the server-resolved name; follows an overridden serviceType.
    serviceLabel: overrides.serviceType ?? 'Drop-in Visit',
    serviceId: null,
    title: null,
    startTimeMs: new Date(2026, 5, 2, 8, 0).getTime(),
    endTimeMs: null,
    kinIds: ['k1'],
    kinNames: ['Miso'],
    auntieDisplayName: 'Maya',
    auntieAvatarUrl: null,
    notes: null,
    requestedByUid: 'u1',
    createdAtMs: null,
    updatedAtMs: null,
    visitProgress: null,
    sourceBookingId: null,
    sessionId: null,
    cancelRequested: false,
    cancelRequestStatus: null,
    cancelRequestReason: null,
    cancelResponseNote: null,
    rescheduleRequestStatus: null,
    rescheduleRequestedStartTimeMs: null,
    rescheduleRequestedEndTimeMs: null,
    rescheduleRequestReason: null,
    rescheduleResponseNote: null,
    address: null,
    kinTaleId: null,
    invoiceId: null,
    startTimePending: false,
    requestedDate: null,
    timeBlockLabel: null,
    timeBlockStartTime: null,
    timeBlockEndTime: null,
    ...overrides,
  };
}

function bookingsResult(overrides: Partial<GetMyBookingsResult> = {}): GetMyBookingsResult {
  return { liveVisit: null, upcoming: [], recent: [], envelopes: [], ...overrides };
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BookingDetail />
    </QueryClientProvider>,
  );
}

const CLOCK_ONLY: GetBookingPolicyResult = {
  allowTimeBlockBooking: false,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'SPECIFIC_TIME',
  timeBlocks: [],
};
const NO_CLOSURES: GetBusinessClosuresResult = { closures: [], weeklyHours: [], timeZone: 'America/Chicago' };
beforeEach(() => {
  mocks.getBookingNotes.mockReset();
  mocks.getBookingNotes.mockResolvedValue({ bookingNote: null, notes: [] });
  mocks.getBookingPolicy.mockReset();
  mocks.getBookingPolicy.mockResolvedValue(CLOCK_ONLY);
  mocks.getBusinessClosures.mockReset();
  mocks.getBusinessClosures.mockResolvedValue(NO_CLOSURES);
  mocks.getMyBookings.mockReset();
  mocks.getMyVisits.mockReset();
  mocks.addBookingNote.mockReset();
  mocks.requestBookingCancellation.mockReset();
  mocks.requestBookingReschedule.mockReset();
});


/**
 * The instant at which the Chicago wall clock reads `hhmm` on `dayKey`, found
 * by search rather than by the code under test, so the assertion has its own
 * oracle for the zone arithmetic.
 */
function chicagoMs(dayKey: string, hhmm: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  const base = Date.UTC(y!, m! - 1, d!);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let t = base - 14 * 3600_000; t <= base + 38 * 3600_000; t += 15 * 60_000) {
    const parts = fmt.formatToParts(new Date(t));
    const g = (k: string) => parts.find((p) => p.type === k)?.value;
    if (`${g('year')}-${g('month')}-${g('day')}` === dayKey && `${g('hour')}:${g('minute')}` === hhmm) return t;
  }
  throw new Error('no instant');
}
/** Clicks the month grid's cell for a day `daysAhead` out, paging forward when it is in the next month. */
async function pickDay(user: ReturnType<typeof userEvent.setup>, within_: HTMLElement, daysAhead = 3): Promise<string> {
  const target = new Date();
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() + daysAhead);
  if (target.getMonth() !== new Date().getMonth()) {
    await user.click(within(within_).getByRole('button', { name: /next month/i }));
  }
  await user.click(within(within_).getByRole('button', { name: String(target.getDate()) }));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}
async function setTime(user: ReturnType<typeof userEvent.setup>, form: HTMLElement, hhmm: string) {
  const input = await within(form).findByLabelText(/^time$/i);
  await user.clear(input);
  await user.type(input, hhmm);
}

describe('BookingDetail: lookup', () => {
  it('shows a not-found state for an unknown visitId', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult());
    renderScreen();
    expect(await screen.findByText(/couldn.t find that booking/i)).toBeInTheDocument();
  });

  it('renders the found booking’s fields', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Drop-in Visit' })).toBeInTheDocument();
    expect(screen.getByText('Miso')).toBeInTheDocument();
    expect(screen.getByText('Maya')).toBeInTheDocument();
    expect(screen.getByText('CONFIRMED')).toBeInTheDocument();
  });

  it('surfaces a getMyBookings failure via LaunchError rather than a blank page', async () => {
    mocks.getMyBookings.mockRejectedValue(new Error('network down'));
    renderScreen();
    expect(await screen.findByText(/trouble loading your tribe/i)).toBeInTheDocument();
  });
});

describe('BookingDetail: add a note', () => {
  it('happy path: saves the note with kinfolkId/batchId/visitId from the found booking and shows confirmation', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.addBookingNote.mockResolvedValue({ noteId: 'n1' });
    const user = userEvent.setup();
    renderScreen();

    const textarea = await screen.findByPlaceholderText(/vet check/i);
    await user.type(textarea, 'Please use the back door.');
    await user.click(screen.getByRole('button', { name: /Save Note/i }));

    await waitFor(() =>
      expect(mocks.addBookingNote).toHaveBeenCalledWith('fam1', 'b1', 'v1', 'Please use the back door.'),
    );
    expect(await screen.findByText(/Note saved/i)).toBeInTheDocument();
    // the draft clears after a successful save
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('negative path: the Save button stays disabled for a blank note', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    renderScreen();
    await screen.findByPlaceholderText(/vet check/i);
    expect(screen.getByRole('button', { name: /Save Note/i })).toBeDisabled();
    expect(mocks.addBookingNote).not.toHaveBeenCalled();
  });

  it('error path: surfaces the 3-hour cutoff rejection instead of swallowing it (fail loud)', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.addBookingNote.mockRejectedValue(new Error('Notes cannot be edited within 3 hours of booking start window.'));
    const user = userEvent.setup();
    renderScreen();

    const textarea = await screen.findByPlaceholderText(/vet check/i);
    await user.type(textarea, 'too late');
    await user.click(screen.getByRole('button', { name: /Save Note/i }));

    expect(await screen.findByText(/3 hours/i)).toBeInTheDocument();
    // a failed save keeps the draft so the kinfolk can retry
    expect((textarea as HTMLTextAreaElement).value).toBe('too late');
  });

  it('unauthorized path: surfaces a permission-denied rejection verbatim', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.addBookingNote.mockRejectedValue(new Error('No access.'));
    const user = userEvent.setup();
    renderScreen();

    const textarea = await screen.findByPlaceholderText(/vet check/i);
    await user.type(textarea, 'hi');
    await user.click(screen.getByRole('button', { name: /Save Note/i }));

    expect(await screen.findByText(/No access\./)).toBeInTheDocument();
  });

  it('gates the note box off a booking with no batchId (an envelope-less AuntieOS session)', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ batchId: null })] }));
    renderScreen();
    expect(await screen.findByText(/linked to a booking yet/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/vet check/i)).not.toBeInTheDocument();
  });
});

describe('BookingDetail: the notes you already wrote (#1283)', () => {
  it('shows the booking note and each saved note with the time it was written', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.getBookingNotes.mockResolvedValue({
      bookingNote: 'QA walk test booking - please cancel.',
      notes: [
        { id: 'n1', body: 'Back door is easier.', createdAtMs: new Date(2026, 10, 1, 15, 5).getTime() },
        { id: 'n2', body: 'Second note', createdAtMs: null },
      ],
    });
    renderScreen();
    const card = await screen.findByTestId('saved-notes');
    expect(await within(card).findByText('QA walk test booking - please cancel.')).toBeInTheDocument();
    expect(within(card).getByText('Back door is easier.')).toBeInTheDocument();
    expect(within(card).getByText('Nov 1, 3:05 PM')).toBeInTheDocument();
    expect(within(card).getByText('Second note')).toBeInTheDocument();
    expect(mocks.getBookingNotes).toHaveBeenCalledWith('fam1', 'b1', 'v1');
  });
  it('says so when there is nothing yet', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    renderScreen();
    expect(await within(await screen.findByTestId('saved-notes')).findByText('Nothing yet.')).toBeInTheDocument();
  });
  it('lists a note right after it is saved, instead of clearing to the placeholder', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.addBookingNote.mockResolvedValue({ noteId: 'n9' });
    mocks.getBookingNotes
      .mockResolvedValueOnce({ bookingNote: null, notes: [] })
      .mockResolvedValue({ bookingNote: null, notes: [{ id: 'n9', body: 'Please use the back door.', createdAtMs: Date.now() }] });
    const user = userEvent.setup();
    renderScreen();
    await user.type(await screen.findByPlaceholderText(/vet check/i), 'Please use the back door.');
    await user.click(screen.getByRole('button', { name: /Save Note/i }));
    const card = await screen.findByTestId('saved-notes');
    expect(await within(card).findByText('Please use the back door.')).toBeInTheDocument();
  });
  it('offers a retry when the notes cannot be loaded', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.getBookingNotes.mockRejectedValue(new Error('down'));
    renderScreen();
    expect(await within(await screen.findByTestId('saved-notes')).findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
  it('asks for nothing on a visit with no booking envelope', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ batchId: null })] }));
    renderScreen();
    await screen.findByText(/linked to a booking yet/i);
    expect(screen.queryByTestId('saved-notes')).toBeNull();
    expect(mocks.getBookingNotes).not.toHaveBeenCalled();
  });
});
describe('BookingDetail: request cancellation', () => {
  it('happy path: confirms, sends the request, and invalidates the bookings cache', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'requested' })] }));
    mocks.requestBookingCancellation.mockResolvedValue({ ok: true, visitId: 'v1', alreadyPending: false, visit: null });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Request cancellation/i }));
    await user.click(screen.getByRole('button', { name: /Yes, request cancellation/i }));

    await waitFor(() => expect(mocks.requestBookingCancellation).toHaveBeenCalledWith('fam1', 'b1', 'v1', ''));
    // invalidation triggers a refetch of the same query
    await waitFor(() => expect(mocks.getMyBookings).toHaveBeenCalledTimes(2));
  });

  it('sends a typed reason', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'confirmed' })] }));
    mocks.requestBookingCancellation.mockResolvedValue({ ok: true, visitId: 'v1', alreadyPending: false, visit: null });
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Request cancellation/i }));
    await user.type(screen.getByPlaceholderText(/optional reason/i), 'Trip got moved');
    await user.click(screen.getByRole('button', { name: /Yes, request cancellation/i }));

    await waitFor(() =>
      expect(mocks.requestBookingCancellation).toHaveBeenCalledWith('fam1', 'b1', 'v1', 'Trip got moved'),
    );
  });

  it('"Never mind" backs out without calling the server', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'requested' })] }));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Request cancellation/i }));
    await user.click(screen.getByRole('button', { name: /Never mind/i }));

    expect(screen.getByRole('button', { name: /Request cancellation/i })).toBeInTheDocument();
    expect(mocks.requestBookingCancellation).not.toHaveBeenCalled();
  });

  it('error path: surfaces a rejection instead of swallowing it (fail loud)', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'requested' })] }));
    mocks.requestBookingCancellation.mockRejectedValue(
      new Error('Only an upcoming requested or confirmed visit can ask for a cancellation.'),
    );
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Request cancellation/i }));
    await user.click(screen.getByRole('button', { name: /Yes, request cancellation/i }));

    expect(await screen.findByText(/can ask for a cancellation/i)).toBeInTheDocument();
  });

  it('unauthorized path: surfaces a permission-denied rejection verbatim', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'requested' })] }));
    mocks.requestBookingCancellation.mockRejectedValue(new Error('No access.'));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /Request cancellation/i }));
    await user.click(screen.getByRole('button', { name: /Yes, request cancellation/i }));

    expect(await screen.findByText(/No access\./)).toBeInTheDocument();
  });

  it('shows the waiting state instead of the button while an ask is pending', async () => {
    mocks.getMyBookings.mockResolvedValue(
      bookingsResult({
        upcoming: [
          booking({ status: 'confirmed', cancelRequested: true, cancelRequestStatus: 'pending' }),
        ],
      }),
    );
    renderScreen();
    // #438: the copy may now promise a queue, because there is one. Before it,
    // this banner told the household the office knew when nothing had read the
    // flag since July.
    expect(await screen.findByTestId('cancel-pending')).toHaveTextContent(/queue/i);
    expect(screen.queryByRole('button', { name: /Request cancellation/i })).not.toBeInTheDocument();
  });

  it('#438: shows the office’s reason when the cancellation was declined, and lets them ask again', async () => {
    mocks.getMyBookings.mockResolvedValue(
      bookingsResult({
        upcoming: [
          booking({
            status: 'confirmed',
            cancelRequested: false,
            cancelRequestStatus: 'declined',
            cancelResponseNote: 'Inside the 48-hour window.',
          }),
        ],
      }),
    );
    renderScreen();
    const declined = await screen.findByTestId('cancel-declined');
    expect(declined).toHaveTextContent(/keeping this visit/i);
    expect(declined).toHaveTextContent('Inside the 48-hour window.');
    expect(screen.getByRole('button', { name: /Ask again/i })).toBeInTheDocument();
  });

  it('#438: says the visit is cancelled once the office accepted', async () => {
    mocks.getMyBookings.mockResolvedValue(
      bookingsResult({
        recent: [
          booking({
            status: 'cancelled',
            cancelRequested: false,
            cancelRequestStatus: 'accepted',
            cancelResponseNote: 'No charge for this one.',
          }),
        ],
      }),
    );
    renderScreen();
    const accepted = await screen.findByTestId('cancel-accepted');
    expect(accepted).toHaveTextContent(/this visit is cancelled/i);
    expect(accepted).toHaveTextContent('No charge for this one.');
    expect(screen.queryByRole('button', { name: /Request cancellation/i })).not.toBeInTheDocument();
  });

  it('does not offer cancellation for a completed visit', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [booking({ status: 'completed' })] }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Drop-in Visit' });
    expect(screen.queryByRole('button', { name: /Request cancellation/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('cancel-pending')).not.toBeInTheDocument();
  });

  it('does not offer cancellation for a booking with no batchId', async () => {
    mocks.getMyBookings.mockResolvedValue(
      bookingsResult({ upcoming: [booking({ status: 'requested', batchId: null })] }),
    );
    renderScreen();
    await screen.findByRole('heading', { name: 'Drop-in Visit' });
    expect(screen.queryByRole('button', { name: /Request cancellation/i })).not.toBeInTheDocument();
  });
});

describe('BookingDetail: status timeline', () => {
  // The "This booking" card also renders the status as plain text (e.g. "In
  // progress"), so timeline-step assertions are scoped to the timeline
  // section itself rather than matching against the whole screen.
  async function findTimeline() {
    const heading = await screen.findByText('Status timeline');
    return within(heading.closest('section') as HTMLElement);
  }

  it('shows En route as its own step, ahead of In progress, for an enRoute booking', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'enRoute' })] }));
    renderScreen();
    const timeline = await findTimeline();
    expect(timeline.getByText('En route')).toBeInTheDocument();
    expect(timeline.getByText('In progress')).toBeInTheDocument();
  });

  it('marks En route done and In progress current once the visit is active', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'active' })] }));
    renderScreen();
    const timeline = await findTimeline();
    const enRouteStep = timeline.getByText('En route').closest('.tl-step');
    const inProgressStep = timeline.getByText('In progress').closest('.tl-step');
    expect(enRouteStep).toHaveClass('done');
    expect(inProgressStep).toHaveClass('now');
  });

  it('still renders no timeline for a cancelled booking', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'cancelled' })] }));
    renderScreen();
    expect(await screen.findByText('CANCELLED')).toBeInTheDocument();
    expect(screen.queryByText('Status timeline')).not.toBeInTheDocument();
    expect(screen.queryByText('En route')).not.toBeInTheDocument();
  });
});
/**
 * "Reschedule visit" (#399 item 2).
 *
 * It was a `<span class="btn ghost block navlink-inert" title="Coming soon">`:
 * a control that looked like a button, could not be focused or pressed, and had
 * no callable behind it. A client could ask for a cancellation but never
 * propose a new time. These assert the control is real, that it PROPOSES rather
 * than moves, and that every state of the answer is rendered.
 */
describe('BookingDetail: reschedule request', () => {
  it('offers a real button, not the inert span it replaced', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    renderScreen();
    const button = await screen.findByRole('button', { name: /reschedule visit/i });
    expect(button).toBeEnabled();
  });
  it('uses the booking wizard\'s day grid, not a raw date-time input (#1284)', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    expect(await within(form).findByRole('button', { name: /previous month/i })).toBeInTheDocument();
    expect(form.querySelector('input[type="datetime-local"]')).toBeNull();
    // Nothing to send until a day is picked.
    expect(within(form).getByRole('button', { name: /send this time to tribe tails/i })).toBeDisabled();
  });
  it('shows a loading cue while the days and times load', async () => {
    mocks.getBusinessClosures.mockReturnValue(new Promise(() => {}));
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    expect(await screen.findByText(/loading the days and times you can pick/i)).toBeInTheDocument();
  });
  it('sends the chosen day and time on the Chicago clock, with the reason, and never touches the visit itself', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.requestBookingReschedule.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      proposedStartTimeMs: 0,
      proposedEndTimeMs: null,
      visit: null,
    });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    const day = await pickDay(user, form);
    await setTime(user, form, '1030');
    await user.type(within(form).getByPlaceholderText(/why the change/i), 'Flight moved');
    await user.click(within(form).getByRole('button', { name: /send this time to tribe tails/i }));
    await waitFor(() =>
      expect(mocks.requestBookingReschedule).toHaveBeenCalledWith('fam1', 'b1', 'v1', chicagoMs(day, '10:30'), 'Flight moved', null),
    );
  });
  it('greys out a closed weekday and a company closure in the day grid', async () => {
    const closed = new Date();
    closed.setDate(closed.getDate() + 2);
    const pad = (n: number) => String(n).padStart(2, '0');
    const closedKey = `${closed.getFullYear()}-${pad(closed.getMonth() + 1)}-${pad(closed.getDate())}`;
    mocks.getBusinessClosures.mockResolvedValue({
      closures: [{ date: closedKey, name: 'Owner away' }],
      weeklyHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: weekday !== 0, startTime: weekday !== 0 ? '09:00' : null, endTime: weekday !== 0 ? '17:00' : null })),
      timeZone: 'America/Chicago',
    });
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    await within(form).findByRole('button', { name: /previous month/i });
    const closedButtons = form.querySelectorAll('.mp-day.is-closed');
    const titles = Array.from(closedButtons).map((b) => b.getAttribute('title') ?? '');
    expect(titles).toContain('Closed: Owner away');
    expect(titles.some((t) => t.includes('Closed: Sundays'))).toBe(true);
  });
  it('refuses a clock time outside that weekday\'s hours, before the callable is reached', async () => {
    mocks.getBusinessClosures.mockResolvedValue({
      closures: [],
      weeklyHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: true, startTime: '09:00', endTime: '17:00' })),
      timeZone: 'America/Chicago',
    });
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    await pickDay(user, form);
    await setTime(user, form, '0200');
    expect(await within(form).findByText(/we are open 09:00 to 17:00/i)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: /send this time to tribe tails/i })).toBeDisabled();
    expect(mocks.requestBookingReschedule).not.toHaveBeenCalled();
  });
  it('offers the business\'s time blocks when it books by block, and sends the block id', async () => {
    mocks.getBookingPolicy.mockResolvedValue({
      allowTimeBlockBooking: true,
      allowSpecificTimeBooking: false,
      defaultBookingMode: 'TIME_BLOCK',
      timeBlocks: [
        { id: 'morning', label: 'Morning', startTime: '08:00', endTime: '12:00', durationMinutes: 240 },
        { id: 'afternoon', label: 'Afternoon', startTime: '12:00', endTime: '17:00', durationMinutes: 300 },
      ],
    });
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.requestBookingReschedule.mockResolvedValue({ ok: true, visitId: 'v1', proposedStartTimeMs: 0, proposedEndTimeMs: null, visit: null });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    const day = await pickDay(user, form);
    expect(within(form).queryByLabelText(/^time$/i)).toBeNull();
    await user.selectOptions(await within(form).findByLabelText(/time block/i), 'afternoon');
    await user.click(within(form).getByRole('button', { name: /send this time to tribe tails/i }));
    await waitFor(() =>
      expect(mocks.requestBookingReschedule).toHaveBeenCalledWith('fam1', 'b1', 'v1', chicagoMs(day, '12:00'), '', 'afternoon'),
    );
  });
  it("shows the server's own words when the request is refused", async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.requestBookingReschedule.mockRejectedValue(
      new Error('Only a requested or confirmed visit can ask for a new time.'),
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    await pickDay(user, form);
    await user.click(within(form).getByRole('button', { name: /send this time to tribe tails/i }));
    expect(
      await screen.findByText(/only a requested or confirmed visit can ask for a new time/i),
    ).toBeInTheDocument();
  });
  it('renders the waiting state and hides the control while a request is pending', async () => {
    const pending = booking({
      rescheduleRequestStatus: 'pending',
      rescheduleRequestedStartTimeMs: new Date(2026, 8, 1, 15, 0).getTime(),
    });
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [pending] }));
    renderScreen();
    const banner = await screen.findByTestId('reschedule-pending');
    expect(banner.textContent).toMatch(/new time requested/i);
    expect(screen.queryByRole('button', { name: /reschedule visit/i })).toBeNull();
  });
  it('#1299: offers no cancellation while a new time is waiting, and says when it will', async () => {
    mocks.getMyBookings.mockResolvedValue(
      bookingsResult({ upcoming: [booking({ rescheduleRequestStatus: 'pending' })] }),
    );
    renderScreen();
    await screen.findByTestId('reschedule-pending');
    expect(screen.queryByRole('button', { name: /request cancellation/i })).toBeNull();
    expect(screen.getByTestId('cancel-held').textContent).toMatch(/once Tribe Tails answers your new time/i);
  });
  it('#1299: offers no new time while a cancellation is waiting', async () => {
    mocks.getMyBookings.mockResolvedValue(
      bookingsResult({ upcoming: [booking({ cancelRequested: true, cancelRequestStatus: 'pending' })] }),
    );
    renderScreen();
    await screen.findByTestId('cancel-pending');
    expect(screen.queryByRole('button', { name: /reschedule visit/i })).toBeNull();
  });
  it('#1298: a requested visit shows REQUESTED in the badge and a clock, not a green check, on the Status tile', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ status: 'requested' })] }));
    renderScreen();
    await screen.findByText('REQUESTED');
    expect(screen.queryByText('\u2705')).toBeNull();
    expect(screen.getByText('\u{1F552}')).toBeInTheDocument();
  });
  it('renders the accepted answer', async () => {
    const accepted = booking({
      rescheduleRequestStatus: 'accepted',
      rescheduleRequestedStartTimeMs: new Date(2026, 8, 1, 15, 0).getTime(),
      rescheduleResponseNote: 'See you then.',
    });
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [accepted] }));
    renderScreen();
    const banner = await screen.findByTestId('reschedule-accepted');
    expect(banner.textContent).toMatch(/accepted/i);
    expect(banner.textContent).toMatch(/see you then/i);
  });
  it('renders a declined answer with the reason, and lets the household try again', async () => {
    const declined = booking({
      rescheduleRequestStatus: 'declined',
      rescheduleRequestedStartTimeMs: new Date(2026, 8, 1, 15, 0).getTime(),
      rescheduleResponseNote: 'That morning is fully booked.',
    });
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [declined] }));
    renderScreen();
    const banner = await screen.findByTestId('reschedule-declined');
    expect(banner.textContent).toMatch(/that morning is fully booked/i);
    expect(screen.getByRole('button', { name: /reschedule visit/i })).toBeEnabled();
  });
  it('offers no reschedule control on a visit with no booking envelope', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking({ batchId: null })] }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Drop-in Visit' });
    expect(screen.queryByRole('button', { name: /reschedule visit/i })).toBeNull();
  });
  it('offers no reschedule control on a completed visit', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [booking({ status: 'completed' })] }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Drop-in Visit' });
    expect(screen.queryByRole('button', { name: /reschedule visit/i })).toBeNull();
  });
});

/**
 * #1098: the overnight's start time is the Auntie's to set, and
 * `requestBookingReschedule` refuses a visit that has none yet. So the
 * household is not offered a control that can only fail; cancelling stays.
 */
describe('BookingDetail: a visit whose start time the Auntie sets (#1098)', () => {
  const pending = () =>
    booking({ serviceType: 'Overnight', startTimeMs: null, startTimePending: true, requestedDate: '2026-10-09', status: 'requested' });
  it('shows the night and who sets the start, never "Time to be confirmed"', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [pending()] }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Overnight' });
    expect(screen.getAllByText('Fri night · Start time set by your Auntie').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Time to be confirmed|TBD|Invalid Date|12:00 AM/)).toBeNull();
    expect(screen.getByText('Oct')).toBeInTheDocument();
    expect(screen.getByText('09')).toBeInTheDocument();
  });
  it('hides Reschedule with the reason, and keeps cancellation', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [pending()] }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Overnight' });
    expect(screen.queryByRole('button', { name: /reschedule visit/i })).toBeNull();
    expect(screen.getByText('Your Auntie has not set the start time yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request cancellation/i })).toBeEnabled();
  });
  it('offers Reschedule again once the start time is set', async () => {
    mocks.getMyBookings.mockResolvedValue(
      bookingsResult({ upcoming: [booking({ startTimePending: false, requestedDate: '2026-10-09' })] }),
    );
    renderScreen();
    expect(await screen.findByRole('button', { name: /reschedule visit/i })).toBeEnabled();
    expect(screen.queryByText('Your Auntie has not set the start time yet.')).toBeNull();
  });
});
/**
 * #1281: the panel closed on success and the visit kept its pre-ask look for
 * 10s+ until the refetch landed. The server now returns the visit as stored,
 * and it is on screen the moment the call resolves, refetch or no refetch.
 */
describe('BookingDetail: #1281 the ask shows the moment it resolves', () => {
  it('reschedule: "New time requested" is drawn from the returned visit, with the refetch still out', async () => {
    const ms = Date.now() + 3 * 24 * 60 * 60 * 1000;
    mocks.getMyBookings.mockResolvedValueOnce(bookingsResult({ upcoming: [booking()] }));
    // Every later read hangs, so only the cache write can explain the banner.
    mocks.getMyBookings.mockReturnValue(new Promise(() => {}));
    mocks.requestBookingReschedule.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      proposedStartTimeMs: ms,
      proposedEndTimeMs: null,
      visit: booking({ rescheduleRequestStatus: 'pending', rescheduleRequestedStartTimeMs: ms }),
    });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    await pickDay(user, form);
    await user.click(within(form).getByRole('button', { name: /send this time to tribe tails/i }));
    expect(await screen.findByText(/New time requested/)).toBeInTheDocument();
    expect(screen.queryByTestId('reschedule-form')).not.toBeInTheDocument();
    expect(mocks.requestBookingReschedule).toHaveBeenCalledTimes(1);
  });
  it('cancel: "Cancellation requested" is drawn from the returned visit, with the refetch still out', async () => {
    mocks.getMyBookings.mockResolvedValueOnce(bookingsResult({ upcoming: [booking()] }));
    mocks.getMyBookings.mockReturnValue(new Promise(() => {}));
    mocks.requestBookingCancellation.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      alreadyPending: false,
      visit: booking({ cancelRequested: true, cancelRequestStatus: 'pending' }),
    });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /Request cancellation/i }));
    await user.click(screen.getByRole('button', { name: /Yes, request cancellation/i }));
    expect(await screen.findByText(/Cancellation requested/)).toBeInTheDocument();
    expect(mocks.requestBookingCancellation).toHaveBeenCalledTimes(1);
  });
  it('with no visit in the reply, stays on "Sending…" until the fresh list arrives', async () => {
    let answer!: (r: GetMyBookingsResult) => void;
    mocks.getMyBookings.mockResolvedValueOnce(bookingsResult({ upcoming: [booking()] }));
    mocks.getMyBookings.mockReturnValue(new Promise((r) => { answer = r; }));
    mocks.requestBookingCancellation.mockResolvedValue({ ok: true, visitId: 'v1', alreadyPending: false, visit: null });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /Request cancellation/i }));
    await user.click(screen.getByRole('button', { name: /Yes, request cancellation/i }));
    await waitFor(() => expect(mocks.getMyBookings).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /Sending/ })).toBeDisabled();
    answer(bookingsResult({ upcoming: [booking({ cancelRequested: true, cancelRequestStatus: 'pending' })] }));
    expect(await screen.findByText(/Cancellation requested/)).toBeInTheDocument();
  });
});

describe('BookingDetail: a visit that is over (#1285, #1303)', () => {
  const done = (overrides: Partial<GetMyBookingsResultLiveVisit> = {}) =>
    booking({
      status: 'completed',
      sessionId: 'sess-1',
      address: '12 Elm St, Austin TX',
      kinTaleId: 'tale-9',
      invoiceId: 'inv-3',
      ...overrides,
    });
  it('#1285: has no before-the-visit note box on a completed visit', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done()] }));
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    renderScreen();
    await screen.findByText('COMPLETED', { selector: '.chip' });
    expect(screen.queryByText(/Leave a note for/)).toBeNull();
    expect(screen.queryByText(/before this visit/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /save note/i })).toBeNull();
  });
  it('#1285: or on a cancelled one', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done({ status: 'cancelled' })] }));
    renderScreen();
    await screen.findByText('CANCELLED', { selector: '.chip' });
    expect(screen.queryByText(/Leave a note for/)).toBeNull();
    expect(screen.queryByTestId('after-visit')).toBeNull();
  });
  it('#1285: still offers the note box on an upcoming visit', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    renderScreen();
    expect(await screen.findByText(/Leave a note for/)).toBeInTheDocument();
  });
  it('#1303: every step of a completed visit is a check, including the last, and none is a number', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done()] }));
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    const { container } = renderScreen();
    await screen.findByText('COMPLETED', { selector: '.chip' });
    const dots = [...container.querySelectorAll('.tl-dot')].map((d) => d.textContent);
    expect(dots).toEqual(['✓', '✓', '✓', '✓', '✓']);
  });
  it('#1303: a confirmed visit still counts its upcoming steps', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    const { container } = renderScreen();
    await screen.findByText('CONFIRMED');
    expect([...container.querySelectorAll('.tl-dot')].map((d) => d.textContent)).toEqual(['✓', '2', '3', '4', '5']);
  });
  it('#1303: shows the address under When and where', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done()] }));
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    renderScreen();
    expect((await screen.findByTestId('visit-address')).textContent).toContain('12 Elm St, Austin TX');
  });
  it('#1303: says nothing about an address that is not on file', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done({ address: null })] }));
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    renderScreen();
    await screen.findByText('COMPLETED', { selector: '.chip' });
    expect(screen.queryByTestId('visit-address')).toBeNull();
  });
  it('#1303: links to the KinTale and the invoice', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done()] }));
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    renderScreen();
    const tale = await screen.findByRole('link', { name: /Read the KinTale/ });
    expect(tale).toHaveAttribute('data-to', '/kintales');
    expect(tale).toHaveAttribute('data-search', JSON.stringify({ tale: 'tale-9' }));
    const invoice = screen.getByRole('link', { name: /See the invoice/ });
    expect(invoice).toHaveAttribute('data-to', '/invoices/$invoiceId');
    expect(invoice).toHaveAttribute('data-params', JSON.stringify({ invoiceId: 'inv-3' }));
  });
  it('#1303: offers no link to a record that does not exist', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done({ kinTaleId: null, invoiceId: null })] }));
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    renderScreen();
    expect(await screen.findByText(/Nothing has been sent for this visit yet/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /KinTale|invoice/ })).toBeNull();
  });
  it('#1303: shows the visit replay when the session recorded a route', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done()] }));
    mocks.getMyVisits.mockResolvedValue({
      visits: [{ id: 'sess-1', status: 'COMPLETED', gpsSummary: { route: [{ lat: 1, lng: 2 }], distanceMeters: 900, durationSeconds: 600 } }],
    });
    renderScreen();
    expect(await screen.findByTestId('route-map')).toBeInTheDocument();
    expect(screen.getByText('Visit Replay')).toBeInTheDocument();
  });
  it('#1303: a replay lookup that fails drops the replay and nothing else', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [done()] }));
    mocks.getMyVisits.mockRejectedValue(new Error('nope'));
    renderScreen();
    expect(await screen.findByRole('link', { name: /Read the KinTale/ })).toBeInTheDocument();
    expect(screen.queryByTestId('route-map')).toBeNull();
  });
});
describe('BookingDetail: back to the tab the visit lives in (#1304)', () => {
  it('names Past Visits from a completed visit and the default tab from an upcoming one', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [booking({ status: 'completed' })] }));
    const { unmount } = renderScreen();
    expect(await screen.findByRole('link', { name: /Back to Schedule/ })).toHaveAttribute('data-search', JSON.stringify({ tab: 'past' }));
    unmount();
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    renderScreen();
    expect(await screen.findByRole('link', { name: /Back to Schedule/ })).toHaveAttribute('data-search', JSON.stringify({}));
  });
});
