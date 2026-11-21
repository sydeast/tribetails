// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingRequest, bookingRequestOf, kinCareCountLabel } from './BookingRequest';
import type {
  GetMyBookingsResult,
  GetMyBookingsResultEnvelope,
  GetMyBookingsResultLiveVisit,
} from '../contracts/bookingContracts.generated';

/**
 * #1865: the "KinCare booking confirmed" notice opened the Schedule list, and
 * the household had to find the booking among the rest. A notice about a whole
 * request now opens the request: its one KinCare, or the list of them.
 */

const mocks = vi.hoisted(() => ({
  getMyBookings: vi.fn<() => Promise<GetMyBookingsResult>>(),
  batchId: 'b1',
}));

vi.mock('../api/portal', () => ({
  getMyHome: vi.fn(),
  getMyBookings: () => mocks.getMyBookings(),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ batchId: mocks.batchId }),
  Navigate: ({ to, params, replace }: { to?: string; params?: unknown; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-params={JSON.stringify(params ?? null)} data-replace={String(!!replace)} />
  ),
  Link: ({ children, to, params }: { children?: ReactNode; to?: string; params?: unknown }) => (
    <a href="#" data-to={to} data-params={JSON.stringify(params ?? null)}>
      {children}
    </a>
  ),
}));

function visit(id: string, overrides: Partial<GetMyBookingsResultLiveVisit> = {}): GetMyBookingsResultLiveVisit {
  return {
    id,
    batchId: 'b1',
    kinfolkId: 'fam1',
    status: 'confirmed',
    serviceType: 'Drop-in',
    serviceLabel: 'Drop-in',
    serviceId: null,
    title: null,
    startTimeMs: new Date(2026, 10, 24, 9, 0).getTime(),
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
    requestDeclinedAtMs: null,
    rescheduleRequestStatus: null,
    rescheduleRequestedStartTimeMs: null,
    rescheduleRequestedEndTimeMs: null,
    rescheduleRequestedTimeBlockLabel: null,
    rescheduleRequestedTimeBlockStartTime: null,
    rescheduleRequestedTimeBlockEndTime: null,
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

function envelope(batchId: string, kinCares: GetMyBookingsResultLiveVisit[]): GetMyBookingsResultEnvelope {
  return {
    batchId,
    envelopeStatus: 'confirmed',
    pattern: 'individual',
    serviceName: 'Drop-in',
    kinIds: ['k1'],
    kinNames: ['Miso'],
    notes: null,
    visitCount: kinCares.length,
    confirmedCount: kinCares.length,
    completedCount: 0,
    firstStartTimeMs: null,
    lastStartTimeMs: null,
    kinCares,
  };
}

function result(envelopes: GetMyBookingsResultEnvelope[]): GetMyBookingsResult {
  return { liveVisit: null, upcoming: envelopes.flatMap((e) => e.kinCares), recent: [], envelopes };
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BookingRequest />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getMyBookings.mockReset();
  mocks.batchId = 'b1';
});

describe('BookingRequest (#1865)', () => {
  it('says it is loading while the schedule is read', () => {
    mocks.getMyBookings.mockReturnValue(new Promise(() => {}));
    renderScreen();
    expect(screen.getByText(/Loading this booking/)).toBeInTheDocument();
  });

  it('a request of one KinCare goes straight to that KinCare, replacing the address', async () => {
    mocks.getMyBookings.mockResolvedValue(result([envelope('b1', [visit('v24')]), envelope('b2', [visit('other', { batchId: 'b2' })])]));
    renderScreen();
    const nav = await screen.findByTestId('navigate');
    expect(nav.dataset.to).toBe('/schedule/$visitId');
    expect(JSON.parse(nav.dataset.params!)).toEqual({ visitId: 'v24' });
    expect(nav.dataset.replace).toBe('true');
  });

  it('a request of several lists each KinCare, each opening its own page, and nothing from another request', async () => {
    mocks.getMyBookings.mockResolvedValue(
      result([
        envelope('b1', [visit('v24'), visit('v25', { startTimeMs: new Date(2026, 10, 25, 9, 0).getTime() })]),
        envelope('b2', [visit('other', { batchId: 'b2' })]),
      ]),
    );
    renderScreen();
    const card = await screen.findByTestId('booking-request');
    expect(card).toHaveTextContent('2 KinCares');
    const opens = Array.from(card.querySelectorAll('a[data-to="/schedule/$visitId"]')).map((a) => JSON.parse(a.getAttribute('data-params')!));
    expect(opens).toEqual([{ visitId: 'v24' }, { visitId: 'v25' }]);
    expect(screen.queryByTestId('navigate')).toBeNull();
  });

  it('a request no longer on the schedule says so, with the way back', async () => {
    mocks.batchId = 'gone';
    mocks.getMyBookings.mockResolvedValue(result([envelope('b1', [visit('v24')])]));
    renderScreen();
    expect(await screen.findByText(/couldn.t find that booking/)).toBeInTheDocument();
    expect(screen.getByText(/Back to Schedule/).closest('a')?.dataset.to).toBe('/schedule');
    expect(screen.queryByTestId('navigate')).toBeNull();
  });

  it('a failed read offers to try again rather than a blank page', async () => {
    mocks.getMyBookings.mockRejectedValue(new Error('boom'));
    renderScreen();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('bookingRequestOf / kinCareCountLabel', () => {
  it('finds the request by its batch only', () => {
    const r = result([envelope('b1', [visit('v1')])]);
    expect(bookingRequestOf(r, 'b1')?.batchId).toBe('b1');
    expect(bookingRequestOf(r, 'v1')).toBeNull();
    expect(bookingRequestOf(undefined, 'b1')).toBeNull();
  });
  it('counts KinCares in the brand word', () => {
    expect(kinCareCountLabel(1)).toBe('1 KinCare');
    expect(kinCareCountLabel(3)).toBe('3 KinCares');
  });
});
