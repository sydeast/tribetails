// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingDetail } from './BookingDetail';
import type {
  AddBookingNoteResult,
  GetMyBookingsResult,
  GetMyBookingsResultLiveVisit,
  RequestBookingCancellationResult,
  RequestBookingRescheduleResult,
} from '../contracts/bookingContracts.generated';

const mocks = vi.hoisted(() => ({
  getMyBookings: vi.fn<() => Promise<GetMyBookingsResult>>(),
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
    ) => Promise<RequestBookingRescheduleResult>
  >(),
}));

vi.mock('../api/portal', () => ({
  getMyBookings: () => mocks.getMyBookings(),
  getMyVisits: (...args: unknown[]) => mocks.getMyVisits(...args),
}));
vi.mock('../components/RouteMap', () => ({ RouteMap: () => <div data-testid="route-map" /> }));
vi.mock('../api/bookingApi', () => ({
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
  ) => mocks.requestBookingReschedule(kinfolkId, batchId, visitId, proposedStartTimeMs, reason),
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

beforeEach(() => {
  mocks.getMyBookings.mockReset();
  mocks.getMyVisits.mockReset();
  mocks.addBookingNote.mockReset();
  mocks.requestBookingCancellation.mockReset();
  mocks.requestBookingReschedule.mockReset();
});

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
  /** A local datetime-local value a few days out, in the form the input emits. */
  function futureInputValue(daysAhead = 3): { value: string; ms: number } {
    const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    d.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    const value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return { value, ms: new Date(value).getTime() };
  }
  it('offers a real button, not the inert span it replaced', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    renderScreen();
    const button = await screen.findByRole('button', { name: /reschedule visit/i });
    expect(button).toBeEnabled();
  });
  it('sends the chosen time and the reason, and never touches the visit itself', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.requestBookingReschedule.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      proposedStartTimeMs: 0,
      proposedEndTimeMs: null,
      visit: null,
    });
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    const { value, ms } = futureInputValue();
    await userEvent.type(within(form).getByLabelText(/new date and time/i), value);
    await userEvent.type(within(form).getByPlaceholderText(/why the change/i), 'Flight moved');
    await userEvent.click(within(form).getByRole('button', { name: /send this time to tribe tails/i }));
    await waitFor(() =>
      expect(mocks.requestBookingReschedule).toHaveBeenCalledWith('fam1', 'b1', 'v1', ms, 'Flight moved'),
    );
  });
  it('refuses a past time in the browser, before the callable is reached', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    await userEvent.type(within(form).getByLabelText(/new date and time/i), '2020-01-01T09:00');
    await userEvent.click(within(form).getByRole('button', { name: /send this time to tribe tails/i }));
    expect(await screen.findByText(/pick a time in the future/i)).toBeInTheDocument();
    expect(mocks.requestBookingReschedule).not.toHaveBeenCalled();
  });
  it("shows the server's own words when the request is refused", async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ upcoming: [booking()] }));
    mocks.requestBookingReschedule.mockRejectedValue(
      new Error('Only a requested or confirmed visit can ask for a new time.'),
    );
    renderScreen();
    await userEvent.click(await screen.findByRole('button', { name: /reschedule visit/i }));
    const form = await screen.findByTestId('reschedule-form');
    await userEvent.type(within(form).getByLabelText(/new date and time/i), futureInputValue().value);
    await userEvent.click(within(form).getByRole('button', { name: /send this time to tribe tails/i }));
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
  function futureValue(): { value: string; ms: number } {
    const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    d.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    const value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return { value, ms: new Date(value).getTime() };
  }
  it('reschedule: "New time requested" is drawn from the returned visit, with the refetch still out', async () => {
    const { value, ms } = futureValue();
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
    await user.type(within(form).getByLabelText(/new date and time/i), value);
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
