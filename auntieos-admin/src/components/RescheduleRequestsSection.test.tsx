// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import type { RescheduleRequestDto } from '../contracts/bookingContracts.generated';

const { listRescheduleRequests, resolveBookingRescheduleRequest } = vi.hoisted(() => ({
  listRescheduleRequests: vi.fn(),
  resolveBookingRescheduleRequest: vi.fn(),
}));
vi.mock('../api/rescheduleRequests', () => ({
  listRescheduleRequests,
  resolveBookingRescheduleRequest,
}));

import { RescheduleRequestsSection, requestKey, whenLabel } from './RescheduleRequestsSection';

/** `useToast()` throws outside a provider; render the real one, the NeedsTriageSection.test convention. */
function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

const CURRENT_MS = new Date(2026, 7, 20, 9, 0).getTime();
const PROPOSED_MS = new Date(2026, 8, 1, 15, 0).getTime();

function request(overrides: Partial<RescheduleRequestDto> = {}): RescheduleRequestDto {
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

beforeEach(() => {
  listRescheduleRequests.mockReset();
  resolveBookingRescheduleRequest.mockReset();
});

describe('RescheduleRequestsSection', () => {
  it('renders nothing while the queue is loading', () => {
    listRescheduleRequests.mockReturnValue(new Promise(() => {}));
    const { container } = render(<RescheduleRequestsSection />);
    expect(container.querySelector('.reschedule-requests')).toBeNull();
  });

  it('renders nothing when nothing is waiting', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [] });
    const { container } = render(<RescheduleRequestsSection />);
    await waitFor(() => expect(listRescheduleRequests).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.reschedule-requests')).toBeNull());
  });

  it('fails LOUD when the queue cannot be read, so nobody reads silence as "none waiting"', async () => {
    listRescheduleRequests.mockRejectedValue(new Error('permission-denied'));
    render(<RescheduleRequestsSection />);
    expect(await screen.findByText(/couldn't load reschedule requests/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the household’s ask with both times and the reason', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [request()] });
    render(<RescheduleRequestsSection />);

    expect(await screen.findByText('Morning drop-in')).toBeInTheDocument();
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.getByText('Flight moved')).toBeInTheDocument();
    expect(
      screen.getByText(`${whenLabel(CURRENT_MS)} → ${whenLabel(PROPOSED_MS)}`),
    ).toBeInTheDocument();
    // Banner uppercases its pill, so the assertion matches what an operator reads.
    expect(screen.getByText('1 WAITING')).toBeInTheDocument();
  });

  it('accepting moves the visit and drops the row from the queue', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [request()] });
    resolveBookingRescheduleRequest.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      decision: 'accept',
      startTimeMs: PROPOSED_MS,
      sessionUpdated: true,
    });
    render(<RescheduleRequestsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('dialog', { name: /move this visit/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move it' }));

    await waitFor(() =>
      expect(resolveBookingRescheduleRequest).toHaveBeenCalledWith('fam-1', 'b1', 'v1', 'accept', ''),
    );
    await waitFor(() => expect(screen.queryByText('Morning drop-in')).toBeNull());
  });

  it('says so when an accepted visit has no schedule row to move yet', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [request({ status: 'requested' })] });
    resolveBookingRescheduleRequest.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      decision: 'accept',
      startTimeMs: PROPOSED_MS,
      sessionUpdated: false,
    });
    render(<RescheduleRequestsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move it' }));

    expect(await screen.findByText(/no schedule row to move yet/i)).toBeInTheDocument();
  });

  it('refuses a decline with no reason, before the callable is reached', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [request()] });
    render(<RescheduleRequestsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send the decline' }));

    expect(await screen.findByText(/say why the time does not work/i)).toBeInTheDocument();
    expect(resolveBookingRescheduleRequest).not.toHaveBeenCalled();
  });

  it('sends a decline with its reason and drops the row', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [request()] });
    resolveBookingRescheduleRequest.mockResolvedValue({
      ok: true,
      visitId: 'v1',
      decision: 'decline',
      startTimeMs: CURRENT_MS,
      sessionUpdated: false,
    });
    render(<RescheduleRequestsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await userEvent.type(await screen.findByLabelText(/why it does not work/i), 'That morning is full.');
    await userEvent.click(screen.getByRole('button', { name: 'Send the decline' }));

    await waitFor(() =>
      expect(resolveBookingRescheduleRequest).toHaveBeenCalledWith(
        'fam-1',
        'b1',
        'v1',
        'decline',
        'That morning is full.',
      ),
    );
    await waitFor(() => expect(screen.queryByText('Morning drop-in')).toBeNull());
  });

  it('keeps the row when the write fails, and shows the server’s reason', async () => {
    listRescheduleRequests.mockResolvedValue({ requests: [request()] });
    resolveBookingRescheduleRequest.mockRejectedValue(new Error('Tribe Tails is closed that day.'));
    render(<RescheduleRequestsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move it' }));

    expect(await screen.findByText('Tribe Tails is closed that day.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Morning drop-in')).toBeInTheDocument();
  });
});

describe('requestKey', () => {
  it('is unique across households, because a visit id is only unique inside one', () => {
    const a = request({ kinfolkId: 'fam-1' });
    const b = request({ kinfolkId: 'fam-2' });
    expect(requestKey(a)).not.toEqual(requestKey(b));
  });
});

describe('whenLabel', () => {
  it('says "Not set" rather than rendering an epoch for a missing time', () => {
    expect(whenLabel(null)).toBe('Not set');
  });
});
