// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import type {
  CancelRequestDto,
  RescheduleRequestDto,
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

import { VisitRequestsSection, mergeQueues, requestKey, whenLabel } from './VisitRequestsSection';

/** `useToast()` throws outside a provider; render the real one, the NeedsTriageSection.test convention. */
function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
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

beforeEach(() => {
  listRescheduleRequests.mockReset();
  resolveBookingRescheduleRequest.mockReset();
  listCancelRequests.mockReset();
  resolveBookingCancellationRequest.mockReset();
  listRescheduleRequests.mockResolvedValue({ requests: [] });
  listCancelRequests.mockResolvedValue({ requests: [] });
});

describe('VisitRequestsSection', () => {
  it('renders nothing while the queues are loading', () => {
    listRescheduleRequests.mockReturnValue(new Promise(() => {}));
    listCancelRequests.mockReturnValue(new Promise(() => {}));
    const { container } = render(<VisitRequestsSection />);
    expect(container.querySelector('.visit-requests')).toBeNull();
  });

  it('renders nothing when nothing is waiting in either queue', async () => {
    const { container } = render(<VisitRequestsSection />);
    await waitFor(() => expect(listCancelRequests).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.visit-requests')).toBeNull());
  });

  it('shows both kinds of ask in one queue, oldest first', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [reschedule()] });
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    render(<VisitRequestsSection />);

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

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel it' }));

    expect(await screen.findByText(/no schedule row to take off/i)).toBeInTheDocument();
  });

  it('refuses a cancellation decline with no reason, before the callable is reached', async () => {
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    render(<VisitRequestsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send the decline' }));

    expect(await screen.findByText(/say why the visit is staying/i)).toBeInTheDocument();
    expect(resolveBookingCancellationRequest).not.toHaveBeenCalled();
  });

  it('sends a cancellation decline with its reason and drops the row', async () => {
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

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.type(
      await screen.findByLabelText(/why it is staying/i),
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

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('dialog', { name: /move this visit/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move it' }));

    await waitFor(() =>
      expect(resolveBookingRescheduleRequest).toHaveBeenCalledWith('fam-1', 'b1', 'v1', 'accept', ''),
    );
    await waitFor(() => expect(screen.queryByText('Morning drop-in')).toBeNull());
  });

  it('refuses a reschedule decline with no reason', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [reschedule()] });
    render(<VisitRequestsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send the decline' }));

    expect(await screen.findByText(/say why the time does not work/i)).toBeInTheDocument();
    expect(resolveBookingRescheduleRequest).not.toHaveBeenCalled();
  });

  it('keeps the row when the write fails, and shows the server’s reason', async () => {
    listCancelRequests.mockResolvedValue({ requests: [cancellation()] });
    resolveBookingCancellationRequest.mockRejectedValue(
      new Error('There is no cancellation request waiting on this visit.'),
    );
    render(<VisitRequestsSection />);

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
