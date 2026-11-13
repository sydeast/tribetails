// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import type { KinRemovalRequestDto, ResolveKinRemovalRequestResult } from '../api/kinRemovalRequests';

const mocks = vi.hoisted(() => ({
  listKinRemovalRequests: vi.fn(),
  resolveKinRemovalRequest: vi.fn(),
  access: { current: { status: 'admin' } as { status: string } | null },
}));
vi.mock('../api/kinRemovalRequests', () => ({
  listKinRemovalRequests: mocks.listKinRemovalRequests,
  resolveKinRemovalRequest: mocks.resolveKinRemovalRequest,
}));
vi.mock('../lib/access', () => ({ useAdminAccess: () => mocks.access.current }));

import { KinRemovalRequestBand, KinRemovalRequestsSection, resolvedMessage } from './KinRemovalRequests';

/** `useToast()` throws outside a provider; render the real one. */
function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

// Noon UTC, so the label is the same day in every test timezone.
const NOV_2 = Date.UTC(2026, 10, 2, 12);

function pending(overrides: Partial<KinRemovalRequestDto> = {}): KinRemovalRequestDto {
  return {
    id: 'fam1_k1',
    kinfolkId: 'fam1',
    kinId: 'k1',
    flatKinId: 'flat1',
    kinName: 'Biscuit',
    reason: 'Rehomed with family',
    status: 'pending',
    requestedAtMs: NOV_2,
    resolvedAtMs: null,
    resolutionNote: null,
    ...overrides,
  };
}

function resolved(decision: 'archive' | 'decline', householdNotified = true): ResolveKinRemovalRequestResult {
  return {
    ok: true,
    decision,
    request: pending({ status: decision === 'archive' ? 'archived' : 'declined' }),
    flatArchived: decision === 'archive',
    familyArchived: decision === 'archive',
    householdNotified,
  };
}

beforeEach(() => {
  mocks.listKinRemovalRequests.mockReset();
  mocks.resolveKinRemovalRequest.mockReset();
  mocks.access.current = { status: 'admin' };
});

describe('KinRemovalRequestBand (#1408)', () => {
  it('reads THIS Kin by its flat id and says so while it loads', async () => {
    let release: (v: { requests: KinRemovalRequestDto[] }) => void = () => {};
    mocks.listKinRemovalRequests.mockReturnValue(new Promise((r) => { release = r; }));
    render(<KinRemovalRequestBand flatKinId="flat1" />);
    expect(mocks.listKinRemovalRequests).toHaveBeenCalledWith('flat1');
    expect(screen.getAllByText('Checking for a removal request…').length).toBeGreaterThan(0);
    await act(async () => release({ requests: [] }));
    expect(screen.queryByText('Checking for a removal request…')).toBeNull();
  });

  it('renders nothing when no request is waiting', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [] });
    const { container } = render(<KinRemovalRequestBand flatKinId="flat1" />);
    await waitFor(() => expect(mocks.listKinRemovalRequests).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="kin-removal-band"]')).toBeNull());
    expect(screen.queryByText('Removal requested')).toBeNull();
  });

  it('shows the household request, date and reason, with Archive and Decline for the owner', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending()] });
    render(<KinRemovalRequestBand flatKinId="flat1" />);
    const band = await screen.findByTestId('kin-removal-band');
    expect(within(band).getByText('Removal requested')).toBeInTheDocument();
    expect(band).toHaveTextContent('The household asked on Nov 2, 2026 to remove Biscuit from their profile.');
    expect(band).toHaveTextContent('Reason: Rehomed with family');
    expect(within(band).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(within(band).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('an Auntie sees the request but no buttons', async () => {
    mocks.access.current = { status: 'caretaker' };
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending()] });
    render(<KinRemovalRequestBand flatKinId="flat1" />);
    const band = await screen.findByTestId('kin-removal-band');
    expect(band).toHaveTextContent('Only the owner can archive or decline.');
    expect(within(band).queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(within(band).queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('a failed read says so and retries', async () => {
    mocks.listKinRemovalRequests.mockRejectedValueOnce(new Error('network'));
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending()] });
    const user = userEvent.setup();
    render(<KinRemovalRequestBand flatKinId="flat1" />);
    expect(await screen.findByText("Couldn't check for a removal request")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Removal requested')).toBeInTheDocument();
  });

  it('Archive confirms first, waits on the server, then clears the band and reloads the profile', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending()] });
    let release: (v: ResolveKinRemovalRequestResult) => void = () => {};
    mocks.resolveKinRemovalRequest.mockReturnValue(new Promise((r) => { release = r; }));
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(<KinRemovalRequestBand flatKinId="flat1" onResolved={onResolved} />);
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent("Biscuit comes off the household's profile. Visits, invoices and KinTales are kept");
    await user.type(within(dialog).getByLabelText('Note for the household (optional)'), 'Take care.');
    await user.click(within(dialog).getByRole('button', { name: 'Archive it' }));
    expect(mocks.resolveKinRemovalRequest).toHaveBeenCalledWith('fam1_k1', 'archive', 'Take care.');
    // Pessimistic: still open and busy until the server answers.
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /Working/ })).toBeDisabled();
    expect(onResolved).not.toHaveBeenCalled();
    await act(async () => release(resolved('archive')));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('archive'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Removal requested')).toBeNull();
    expect(await screen.findByText('Biscuit is archived. The household has your answer.')).toBeInTheDocument();
  });

  it('Decline sends the note and says so', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending()] });
    mocks.resolveKinRemovalRequest.mockResolvedValue(resolved('decline'));
    const user = userEvent.setup();
    render(<KinRemovalRequestBand flatKinId="flat1" />);
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent("Biscuit stays on the household's profile.");
    await user.type(within(dialog).getByLabelText('Note for the household (optional)'), 'A visit is booked next week.');
    await user.click(within(dialog).getByRole('button', { name: 'Send the decline' }));
    await waitFor(() =>
      expect(mocks.resolveKinRemovalRequest).toHaveBeenCalledWith('fam1_k1', 'decline', 'A visit is booked next week.'),
    );
    expect(await screen.findByText('Declined. Biscuit stays on the profile. The household has your answer.')).toBeInTheDocument();
  });

  it('a refusal stays in the dialog and the request stays', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending()] });
    mocks.resolveKinRemovalRequest.mockRejectedValue(new Error('This removal request has already been answered.'));
    const user = userEvent.setup();
    render(<KinRemovalRequestBand flatKinId="flat1" />);
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive it' }));
    expect(await within(screen.getByRole('dialog')).findByText('This removal request has already been answered.')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Removal requested')).toBeInTheDocument();
  });
});

describe('KinRemovalRequestsSection, the queue on Bookings (#1408)', () => {
  it('reads every pending request, shows a count, and opens to rows with actions', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({
      requests: [pending(), pending({ id: 'fam2_k9', kinName: 'Moss', reason: null })],
    });
    const user = userEvent.setup();
    render(<KinRemovalRequestsSection />);
    expect(mocks.listKinRemovalRequests).toHaveBeenCalledWith(undefined);
    expect(await screen.findByText('2 WAITING')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review 2' }));
    const queue = screen.getByTestId('kin-removal-queue');
    expect(within(queue).getByText('Biscuit')).toBeInTheDocument();
    expect(within(queue).getByText('Moss')).toBeInTheDocument();
    expect(within(queue).getByText('Rehomed with family')).toBeInTheDocument();
    expect(within(queue).getAllByRole('button', { name: 'Archive' })).toHaveLength(2);
  });

  it('an answered row leaves the queue', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending(), pending({ id: 'fam2_k9', kinName: 'Moss' })] });
    mocks.resolveKinRemovalRequest.mockResolvedValue(resolved('decline'));
    const user = userEvent.setup();
    render(<KinRemovalRequestsSection />);
    await user.click(await screen.findByRole('button', { name: 'Review 2' }));
    await user.click(within(screen.getByTestId('kin-removal-queue')).getAllByRole('button', { name: 'Decline' })[0]!);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send the decline' }));
    await waitFor(() => expect(screen.queryByText('Biscuit')).toBeNull());
    expect(screen.getByText('1 WAITING')).toBeInTheDocument();
  });

  it('says so while loading, and renders nothing when the queue is empty', async () => {
    let release: (v: { requests: KinRemovalRequestDto[] }) => void = () => {};
    mocks.listKinRemovalRequests.mockReturnValue(new Promise((r) => { release = r; }));
    render(<KinRemovalRequestsSection />);
    expect(screen.getAllByText('Checking for Kin removal requests…').length).toBeGreaterThan(0);
    await act(async () => release({ requests: [] }));
    expect(screen.queryByText('Checking for Kin removal requests…')).toBeNull();
    expect(screen.queryByTestId('kin-removal-queue')).toBeNull();
  });

  it('a failed read is an error banner, never an empty queue', async () => {
    mocks.listKinRemovalRequests.mockRejectedValue(new Error('network'));
    render(<KinRemovalRequestsSection />);
    expect(await screen.findByText("Couldn't load Kin removal requests")).toBeInTheDocument();
  });

  it('an Auntie sees the rows without actions', async () => {
    mocks.access.current = { status: 'caretaker' };
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending()] });
    const user = userEvent.setup();
    render(<KinRemovalRequestsSection />);
    await user.click(await screen.findByRole('button', { name: 'Review 1' }));
    expect(within(screen.getByTestId('kin-removal-queue')).queryByRole('button', { name: 'Archive' })).toBeNull();
  });
});

describe('KinRemovalRequestsSection opened from the notice (#1912)', () => {
  it('arrives unfolded with the named request marked and its Archive and Decline ready', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({
      requests: [pending({ id: 'fam2_k9', kinName: 'Pip' }), pending()],
    });
    render(<KinRemovalRequestsSection focusRequestId="fam1_k1" />);
    const queue = await screen.findByTestId('kin-removal-queue');
    const rows = within(queue).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const marked = rows.filter((r) => r.getAttribute('aria-current') === 'true');
    expect(marked).toHaveLength(1);
    expect(within(marked[0]!).getByText('Biscuit')).toBeTruthy();
    expect(within(marked[0]!).getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(within(marked[0]!).getByRole('button', { name: 'Decline' })).toBeTruthy();
    expect(screen.queryByText('That request has already been answered.')).toBeNull();
  });
  it('a request that is no longer waiting says so in one line, with the rest of the queue under it', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [pending({ id: 'fam2_k9', kinName: 'Pip' })] });
    render(<KinRemovalRequestsSection focusRequestId="fam1_k1" />);
    expect(await screen.findByText('That request has already been answered.')).toBeTruthy();
    expect(within(screen.getByTestId('kin-removal-queue')).getByText('Pip')).toBeTruthy();
  });
  it('says the same when nothing at all is waiting', async () => {
    mocks.listKinRemovalRequests.mockResolvedValue({ requests: [] });
    render(<KinRemovalRequestsSection focusRequestId="fam1_k1" />);
    expect(await screen.findByText('That request has already been answered.')).toBeTruthy();
    expect(screen.queryByTestId('kin-removal-queue')).toBeNull();
  });
  it('a failed read on arrival is an error with Retry, never "already answered"', async () => {
    mocks.listKinRemovalRequests.mockRejectedValue(new Error('offline'));
    render(<KinRemovalRequestsSection focusRequestId="fam1_k1" />);
    expect(await screen.findByText("Couldn't load Kin removal requests")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('That request has already been answered.')).toBeNull();
  });
});
describe('resolvedMessage', () => {
  it('reports a notice that did not go out', () => {
    expect(resolvedMessage(resolved('archive', false))).toBe(
      'Biscuit is archived. The message to the household did not go out, so tell them another way.',
    );
  });
});
