// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingDetail } from './BookingDetail';
import type {
  AddBookingNoteResult,
  GetMyBookingsResult,
  GetMyBookingsResultLiveVisit,
  RequestBookingCancellationResult,
} from '../contracts/bookingContracts.generated';

const mocks = vi.hoisted(() => ({
  getMyBookings: vi.fn<() => Promise<GetMyBookingsResult>>(),
  addBookingNote: vi.fn<(kinfolkId: string, batchId: string, visitId: string, body: string) => Promise<AddBookingNoteResult>>(),
  requestBookingCancellation: vi.fn<
    (kinfolkId: string, batchId: string, visitId: string, reason?: string) => Promise<RequestBookingCancellationResult>
  >(),
}));

vi.mock('../api/portal', () => ({
  getMyBookings: () => mocks.getMyBookings(),
}));
vi.mock('../api/bookingApi', () => ({
  addBookingNote: (kinfolkId: string, batchId: string, visitId: string, body: string) =>
    mocks.addBookingNote(kinfolkId, batchId, visitId, body),
  requestBookingCancellation: (kinfolkId: string, batchId: string, visitId: string, reason?: string) =>
    mocks.requestBookingCancellation(kinfolkId, batchId, visitId, reason),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ visitId: 'v1' }),
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
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
  mocks.addBookingNote.mockReset();
  mocks.requestBookingCancellation.mockReset();
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
    mocks.requestBookingCancellation.mockResolvedValue({ ok: true, visitId: 'v1', alreadyPending: false });
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
    mocks.requestBookingCancellation.mockResolvedValue({ ok: true, visitId: 'v1', alreadyPending: false });
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

  it('shows an "already requested" banner instead of the button when cancelRequested is already true', async () => {
    mocks.getMyBookings.mockResolvedValue(
      bookingsResult({ upcoming: [booking({ status: 'confirmed', cancelRequested: true })] }),
    );
    renderScreen();
    expect(await screen.findByText(/already requested/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Request cancellation/i })).not.toBeInTheDocument();
  });

  it('does not offer cancellation for a completed visit', async () => {
    mocks.getMyBookings.mockResolvedValue(bookingsResult({ recent: [booking({ status: 'completed' })] }));
    renderScreen();
    await screen.findByRole('heading', { name: 'Drop-in Visit' });
    expect(screen.queryByRole('button', { name: /Request cancellation/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/already requested/i)).not.toBeInTheDocument();
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
