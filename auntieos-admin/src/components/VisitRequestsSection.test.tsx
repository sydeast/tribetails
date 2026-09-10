// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import type {
  CancelRequestDto,
  RescheduleRequestDto,
  ListPendingBookingRequestsResultRequest,
} from '../contracts/bookingContracts.generated';

const { listRescheduleRequests, resolveBookingRescheduleRequest } = vi.hoisted(() => ({
  listRescheduleRequests: vi.fn(),
  resolveBookingRescheduleRequest: vi.fn(),
}));
vi.mock('../api/rescheduleRequests', () => ({
  listRescheduleRequests,
  resolveBookingRescheduleRequest,
}));

const { listCancelRequests, resolveBookingCancellationRequest } = vi.hoisted(() => ({
  listCancelRequests: vi.fn(),
  resolveBookingCancellationRequest: vi.fn(),
}));
vi.mock('../api/cancelRequests', () => ({
  listCancelRequests,
  resolveBookingCancellationRequest,
}));
const { listPendingBookingRequests, approveBookingRequest, declineBookingRequest } = vi.hoisted(
  () => ({
    listPendingBookingRequests: vi.fn(),
    approveBookingRequest: vi.fn(),
    declineBookingRequest: vi.fn(),
  }),
);
vi.mock('../api/bookingRequests', () => ({
  listPendingBookingRequests,
  approveBookingRequest,
  declineBookingRequest,
}));

import { VisitRequestsSection, mergeQueues, requestKey, whenLabel } from './VisitRequestsSection';

/** `useToast()` throws outside a provider; render the real one, the NeedsTriageSection.test convention. */
function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

/**
 * #704: the queue reads as ONE compact banner above the Bookings sections and
 * opens on request, so an empty-most-days queue no longer pushes the first
 * status section most of a screen down. Every test that reads a ROW opens it
 * first; the loading, empty and failed-read states have no rows and no toggle,
 * and are asserted exactly as they were.
 */
async function openQueue() {
  await userEvent.click(await screen.findByRole('button', { name: /^Review \d+$/ }));
}
const CURRENT_MS = new Date(2026, 7, 20, 9, 0).getTime();
const PROPOSED_MS = new Date(2026, 8, 1, 15, 0).getTime();

function reschedule(overrides: Partial<RescheduleRequestDto> = {}): RescheduleRequestDto {
  return {
    kinfolkId: 'fam-1',
    batchId: 'b1',
    visitId: 'v1',
    title: 'Morning drop-in',
    serviceType: 'Drop-in Visit',
    kinNames: ['Biscuit'],
    status: 'confirmed',
    currentStartTimeMs: CURRENT_MS,
    currentEndTimeMs: CURRENT_MS + 30 * 60 * 1000,
    proposedStartTimeMs: PROPOSED_MS,
    proposedEndTimeMs: PROPOSED_MS + 30 * 60 * 1000,
    reason: 'Flight moved',
    requestedAtMs: CURRENT_MS,
    ...overrides,
  };
}

function cancellation(overrides: Partial<CancelRequestDto> = {}): CancelRequestDto {
  return {
    kinfolkId: 'fam-2',
    batchId: 'b2',
    visitId: 'v2',
    title: 'Evening sit',
    serviceType: 'Pet Sitting',
    kinNames: ['Nutmeg'],
    status: 'confirmed',
    startTimeMs: CURRENT_MS,
    endTimeMs: CURRENT_MS + 60 * 60 * 1000,
    reason: 'We are taking her with us',
    requestedAtMs: CURRENT_MS - 1000,
    ...overrides,
  };
}

/** A brand new booking request: an ENVELOPE, so it carries a batchId and no visitId (#533). */
function newBooking(
  overrides: Partial<ListPendingBookingRequestsResultRequest> = {},
): ListPendingBookingRequestsResultRequest {
  return {
    kinfolkId: 'fam-3',
    batchId: 'b3',
    kinfolkName: 'The Rivera Home',
    serviceType: 'Dog Walk',
    kinNames: ['Rex'],
    notes: 'Back door code 1234',
    visitCount: 4,
    firstStartTimeMs: CURRENT_MS,
    lastStartTimeMs: CURRENT_MS + 3 * 24 * 60 * 60 * 1000,
    startTimeMsList: [CURRENT_MS, CURRENT_MS + 24 * 60 * 60 * 1000],
    requestedAtMs: CURRENT_MS - 5000,
    ...overrides,
  };
}
beforeEach(() => {
  listRescheduleRequests.mockReset();
  resolveBookingRescheduleRequest.mockReset();
  listCancelRequests.mockReset();
  resolveBookingCancellationRequest.mockReset();
  listPendingBookingRequests.mockReset();
  approveBookingRequest.mockReset();
  declineBookingRequest.mockReset();
  listRescheduleRequests.mockResolvedValue({ requests: [] });
  listCancelRequests.mockResolvedValue({ requests: [] });
  listPendingBookingRequests.mockResolvedValue({ requests: [] });
});

describe('VisitRequestsSection', () => {
  it('reserves the block with a loading panel while the three queues are in flight (#698)', () => {
    listRescheduleRequests.mockReturnValue(new Promise(() => {}));
    listCancelRequests.mockReturnValue(new Promise(() => {}));
    listPendingBookingRequests.mockReturnValue(new Promise(() => {}));
    const { container } = render(<VisitRequestsSection />);
    expect(container.querySelector('.visit-requests')).not.toBeNull();
    expect(screen.getByText('Checking for requests…')).toBeInTheDocument();
  });

  it('states plainly that nothing is waiting, rather than rendering nothing (#698)', async () => {
    render(<VisitRequestsSection />);
    await waitFor(() => expect(listCancelRequests).toHaveBeenCalled());
    expect(await screen.findByText('No visit requests waiting.')).toBeInTheDocument();
  });

  it('keeps the same block mounted from the loading panel through to data, so the page never shifts (#698)', async () => {
    let settleReschedule: (v: { requests: RescheduleRequestDto[] }) => void = () => {};
    let settleCancel: (v: { requests: CancelRequestDto[] }) => void = () => {};
    let settleNewBookings: (v: { requests: ListPendingBookingRequestsResultRequest[] }) => void =
      () => {};
    listRescheduleRequests.mockReturnValue(
      new Promise((res) => {
        settleReschedule = res;
      }),
    );
    listCancelRequests.mockReturnValue(
      new Promise((res) => {
        settleCancel = res;
      }),
    );
    listPendingBookingRequests.mockReturnValue(
      new Promise((res) => {
        settleNewBookings = res;
      }),
    );

    const { container } = render(<VisitRequestsSection />);
    expect(container.querySelectorAll('.visit-requests')).toHaveLength(1);
    expect(screen.getByText('Checking for requests…')).toBeInTheDocument();

    settleReschedule({ requests: [] });
    settleCancel({ requests: [] });
    settleNewBookings({ requests: [] });

    expect(await screen.findByText('No visit requests waiting.')).toBeInTheDocument();
    // Exactly one section the whole way through: the block itself never
    // unmounts and remounts, which is what would push the stat strip below it.
    expect(container.querySelectorAll('.visit-requests')).toHaveLength(1);
  });

  it('#704: reads as one compact banner with its count, and the rows open on request', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [reschedule()] });
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    render(<VisitRequestsSection />);

    // Nothing is hidden: the banner states the count out loud before a press.
    expect(await screen.findByText('2 WAITING')).toBeInTheDocument();
    expect(screen.queryByText('Evening sit')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();

    const review = screen.getByRole('button', { name: 'Review 2' });
    await userEvent.click(review);
    expect(screen.getByText('Evening sit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('shows both kinds of ask in one queue, oldest first', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [reschedule()] });
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    render(<VisitRequestsSection />);
    await openQueue();

    expect(await screen.findByText('Evening sit')).toBeInTheDocument();
    expect(screen.getByText('Morning drop-in')).toBeInTheDocument();
    // Banner uppercases its pill, so the assertion matches what an operator reads.
    expect(screen.getByText('2 WAITING')).toBeInTheDocument();

    const titles = [...document.querySelectorAll('.visit-requests__row-title')].map(
      (n) => n.textContent,
    );
    expect(titles).toEqual(['Evening sit', 'Morning drop-in']);
  });

  it('shows the cancellation ask with the visit it would take off and the reason', async () => {
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    render(<VisitRequestsSection />);
    await openQueue();

    expect(await screen.findByText('Evening sit')).toBeInTheDocument();
    expect(screen.getByText('Nutmeg')).toBeInTheDocument();
    expect(screen.getByText('We are taking her with us')).toBeInTheDocument();
    expect(screen.getByText(whenLabel(CURRENT_MS))).toBeInTheDocument();
    // The kind chip, so an operator never mistakes one ask for the other.
    expect(document.querySelector('.visit-requests__row-kind')?.textContent).toBe('Cancel');
  });

  it('accepting a cancellation cancels the visit and drops the row', async () => {
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    resolveBookingCancellationRequest.mockResolvedValue({
      ok: true,
      visitId: 'v2',
      decision: 'accept',
      status: 'cancelled',
      sessionUpdated: true,
      rescheduleRequestClosed: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('dialog', { name: /cancel this visit/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel it' }));

    await waitFor(() =>
      expect(resolveBookingCancellationRequest).toHaveBeenCalledWith('fam-2', 'b2', 'v2', 'accept', ''),
    );
    await waitFor(() => expect(screen.queryByText('Evening sit')).toBeNull());
  });

  it('says so when an accepted cancellation had no schedule row to take off', async () => {
    listCancelRequests.mockResolvedValue({ requests: [cancellation({ status: 'requested' })] });
    resolveBookingCancellationRequest.mockResolvedValue({
      ok: true,
      visitId: 'v2',
      decision: 'accept',
      status: 'cancelled',
      sessionUpdated: false,
      rescheduleRequestClosed: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    expect(await screen.findByText(/no schedule row to take off/i)).toBeInTheDocument();
  });

  it('submits a cancellation decline with no note, since the office does not owe a reason (#700)', async () => {
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    resolveBookingCancellationRequest.mockResolvedValue({
      ok: true,
      visitId: 'v2',
      decision: 'decline',
      status: 'confirmed',
      sessionUpdated: false,
      rescheduleRequestClosed: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send the decline' }));

    await waitFor(() =>
      expect(resolveBookingCancellationRequest).toHaveBeenCalledWith('fam-2', 'b2', 'v2', 'decline', ''),
    );
    await waitFor(() => expect(screen.queryByText('Evening sit')).toBeNull());
  });

  it('sends a cancellation decline with its optional note and drops the row', async () => {
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    resolveBookingCancellationRequest.mockResolvedValue({
      ok: true,
      visitId: 'v2',
      decision: 'decline',
      status: 'confirmed',
      sessionUpdated: false,
      rescheduleRequestClosed: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.type(
      await screen.findByLabelText(/anything to add for the household/i),
      'Inside the 48-hour window.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send the decline' }));

    await waitFor(() =>
      expect(resolveBookingCancellationRequest).toHaveBeenCalledWith(
        'fam-2',
        'b2',
        'v2',
        'decline',
        'Inside the 48-hour window.',
      ),
    );
    await waitFor(() => expect(screen.queryByText('Evening sit')).toBeNull());
  });

  it('accepting a reschedule moves the visit and drops the row', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [reschedule()] });
    resolveBookingRescheduleRequest.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      decision: 'accept',
      startTimeMs: PROPOSED_MS,
      sessionUpdated: true,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('dialog', { name: /move this visit/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move it' }));

    await waitFor(() =>
      expect(resolveBookingRescheduleRequest).toHaveBeenCalledWith('fam-1', 'b1', 'v1', 'accept', ''),
    );
    await waitFor(() => expect(screen.queryByText('Morning drop-in')).toBeNull());
  });

  it('submits a reschedule decline with no note, since the office does not owe a reason (#700)', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [reschedule()] });
    resolveBookingRescheduleRequest.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      decision: 'decline',
      startTimeMs: CURRENT_MS,
      sessionUpdated: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send the decline' }));

    await waitFor(() =>
      expect(resolveBookingRescheduleRequest).toHaveBeenCalledWith('fam-1', 'b1', 'v1', 'decline', ''),
    );
    await waitFor(() => expect(screen.queryByText('Morning drop-in')).toBeNull());
  });

  it('keeps the row when the write fails, and shows the server’s reason', async () => {
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    resolveBookingCancellationRequest.mockRejectedValue(
      new Error('There is no cancellation request waiting on this visit.'),
    );
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    expect(
      await screen.findByText('There is no cancellation request waiting on this visit.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Evening sit')).toBeInTheDocument();
  });

  it('fails LOUD when a queue cannot be read, so nobody reads silence as "none waiting"', async () => {
    listCancelRequests.mockRejectedValue(new Error('permission-denied'));
    render(<VisitRequestsSection />);
    expect(await screen.findByText(/didn't load/i)).toBeInTheDocument();
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('one broken queue does not hide the other queue’s rows', async () => {
    listRescheduleRequests.mockRejectedValue(new Error('permission-denied'));
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    render(<VisitRequestsSection />);
    await openQueue();

    expect(await screen.findByText('Evening sit')).toBeInTheDocument();
    expect(screen.getByText(/reschedule requests: permission-denied/i)).toBeInTheDocument();
  });
});

describe('mergeQueues', () => {
  it('orders by how long the household has been waiting, oldest first', () => {
    const rows = mergeQueues(
      [reschedule({ requestedAtMs: 300 })],
      [cancellation({ requestedAtMs: 100 }), cancellation({ visitId: 'v3', requestedAtMs: 200 })],
    );
    expect(rows.map((r) => r.request.requestedAtMs)).toEqual([100, 200, 300]);
  });

  it('sorts a row with no timestamp last, rather than pretending it waited since 1970', () => {
    const rows = mergeQueues(
      [reschedule({ requestedAtMs: null })],
      [cancellation({ requestedAtMs: 100 })],
    );
    expect(rows.map((r) => r.kind)).toEqual(['cancel', 'reschedule']);
  });
});

describe('requestKey', () => {
  it('is unique across households, because a visit id is only unique inside one', () => {
    const a = requestKey({ kind: 'cancel', request: cancellation({ kinfolkId: 'fam-1' }) });
    const b = requestKey({ kind: 'cancel', request: cancellation({ kinfolkId: 'fam-2' }) });
    expect(a).not.toEqual(b);
  });

  it('separates the two asks a single visit can carry at once', () => {
    const a = requestKey({ kind: 'cancel', request: cancellation() });
    const b = requestKey({
      kind: 'reschedule',
      request: reschedule({ kinfolkId: 'fam-2', batchId: 'b2', visitId: 'v2' }),
    });
    expect(a).not.toEqual(b);
  });
});

describe('whenLabel', () => {
  it('says "Not set" rather than rendering an epoch for a missing time', () => {
    expect(whenLabel(null)).toBe('Not set');
  });
});

/**
 * #533. Until this, a household could ask for care through the portal and no
 * screen in the React admin ever showed the request: the Bookings list streams
 * the flat `kin_care_sessions` collection and a `requested` envelope has no
 * session yet. These cover the third kind of row and its two answers.
 */
describe('VisitRequestsSection: new booking requests (#533)', () => {
  it('shows a pending request that no other queue would surface', async () => {
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    render(<VisitRequestsSection />);
    await openQueue();

    expect(await screen.findByText('New request')).toBeInTheDocument();
    expect(screen.getByText('Dog Walk')).toBeInTheDocument();
    // The household's own words for the request, which an operator needs before
    // answering it.
    expect(screen.getByText('Back door code 1234')).toBeInTheDocument();
  });

  it('reads a multi-visit request as a count and a span, not four rows', async () => {
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    render(<VisitRequestsSection />);
    await openQueue();

    expect(await screen.findByText(/4 visits,/)).toBeInTheDocument();
    expect(screen.getAllByText('New request')).toHaveLength(1);
  });

  it('a one-visit request names its date plainly', async () => {
    listPendingBookingRequests.mockResolvedValue({
      requests: [newBooking({ visitCount: 1, lastStartTimeMs: CURRENT_MS })],
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await screen.findByText('New request');
    expect(screen.queryByText(/1 visits/)).toBeNull();
  });

  it('approving books the whole envelope through one call, and says the household heard once', async () => {
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    approveBookingRequest.mockResolvedValue({
      affectedVisits: 4,
      failedVisits: 0,
      newlyConfirmed: 4,
      householdNotified: true,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Book it' }));

    await waitFor(() => expect(approveBookingRequest).toHaveBeenCalledWith('fam-3', 'b3'));
    // #536: once for the request, not once per visit, and the copy says so.
    expect(
      await screen.findByText(
        /All 4 visits are on the schedule and the household has been told once, with every date/,
      ),
    ).toBeInTheDocument();
  });

  it('a re-approve of something already booked does not claim the household was told again', async () => {
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    approveBookingRequest.mockResolvedValue({
      affectedVisits: 4,
      failedVisits: 0,
      newlyConfirmed: 0,
      householdNotified: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Book it' }));

    expect(await screen.findByText(/already booked/i)).toBeInTheDocument();
    expect(screen.queryByText(/has been told once/)).toBeNull();
  });

  it('a booking whose confirmation did not go out tells the operator to reach them another way', async () => {
    // The state that matters most, and the one the old copy could not express:
    // the visits ARE on the schedule, so this is not an error, but the household
    // does not know. An operator who is not told never finds out.
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    approveBookingRequest.mockResolvedValue({
      affectedVisits: 4,
      failedVisits: 0,
      newlyConfirmed: 4,
      householdNotified: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Book it' }));

    expect(await screen.findByText(/tell them another way/)).toBeInTheDocument();
  });

  it('a partial failure says the household has NOT been told', async () => {
    // The backend deliberately dispatches nothing on a partial failure, so the
    // retry is not a second confirmation. An operator who reads this as "they
    // heard about the ones that worked" stops chasing it.
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    approveBookingRequest.mockResolvedValue({
      affectedVisits: 3,
      failedVisits: 1,
      newlyConfirmed: 3,
      householdNotified: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Book it' }));

    expect(
      await screen.findByText(/the household has not been told, so try again/i),
    ).toBeInTheDocument();
  });

  it('surfaces a failed approve in the dialog and leaves the request answerable', async () => {
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    approveBookingRequest.mockRejectedValue(new Error('the callable refused'));
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Book it' }));

    expect(await screen.findByText('the callable refused')).toBeInTheDocument();
    // A request that failed to book must not vanish from the queue.
    expect(screen.getByRole('button', { name: 'Book it' })).toBeEnabled();
  });

  it('submits a decline with no note, since the office does not owe a reason (#700)', async () => {
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    declineBookingRequest.mockResolvedValue({
      affectedVisits: 4,
      failedVisits: 0,
      householdNotified: true,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send the decline' }));

    await waitFor(() => expect(declineBookingRequest).toHaveBeenCalledWith('fam-3', 'b3', ''));
    expect(await screen.findByText(/the household has your answer/)).toBeInTheDocument();
  });

  it('declining sends the optional note to the household', async () => {
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    declineBookingRequest.mockResolvedValue({
      affectedVisits: 4,
      failedVisits: 0,
      householdNotified: true,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.type(
      screen.getByLabelText('Anything to add for the household (optional)'),
      'Fully booked that weekend.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send the decline' }));

    await waitFor(() =>
      expect(declineBookingRequest).toHaveBeenCalledWith(
        'fam-3',
        'b3',
        'Fully booked that weekend.',
      ),
    );
    expect(await screen.findByText(/the household has your answer/)).toBeInTheDocument();
  });

  it('says so when the decline went through and the MESSAGE did not', async () => {
    // `manageBookingSeries` decides the request and THEN dispatches, and a
    // dispatch that throws never rolls the decision back. So the request really
    // is turned down while the household is still waiting on an answer, which is
    // the silence #533 exists to end. This toast used to promise them their
    // reason either way. Android has read this field since #536
    // (`EnhancedSchedulingViewModel.householdLine`); this client had not caught
    // up, and an operator who is not told cannot phone them instead.
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    declineBookingRequest.mockResolvedValue({
      affectedVisits: 4,
      failedVisits: 0,
      householdNotified: false,
    });
    render(<VisitRequestsSection />);
    await openQueue();

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.type(
      screen.getByLabelText('Anything to add for the household (optional)'),
      'Fully booked that weekend.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send the decline' }));

    expect(
      await screen.findByText(
        /the message to the household did not go out, so tell them another way/,
      ),
    ).toBeInTheDocument();
  });

  it('a broken request queue is reported, never shown as an empty queue', async () => {
    // An operator who believes nothing is waiting, when the read never landed,
    // leaves a household waiting on an answer that is never coming.
    listPendingBookingRequests.mockRejectedValue(new Error('permission-denied'));
    render(<VisitRequestsSection />);

    expect(await screen.findByText(/New booking requests: permission-denied/)).toBeInTheDocument();
  });

  it('all three queues share one list, oldest ask first', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [reschedule()] });
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    listPendingBookingRequests.mockResolvedValue({ requests: [newBooking()] });
    render(<VisitRequestsSection />);
    await openQueue();

    await screen.findByText('New request');
    const kinds = screen
      .getAllByText(/^(New request|Cancel|Reschedule)$/)
      .map((n) => n.textContent);
    // newBooking asked at -5000, cancellation at -1000, reschedule at 0.
    expect(kinds).toEqual(['New request', 'Cancel', 'Reschedule']);
  });
});

describe('requestKey: envelope rows (#533)', () => {
  it('keys a new request by its batch, since it has no visit id', () => {
    expect(requestKey({ kind: 'newBooking', request: newBooking() })).toBe('newBooking/fam-3/b3');
  });
});
