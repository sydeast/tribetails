// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type BookingEntry } from '../api/bookings';

const { approveBooking, rejectBooking, cancelBooking, markBookingCompleted, rescheduleBooking } = vi.hoisted(
  () => ({
    approveBooking: vi.fn(),
    rejectBooking: vi.fn(),
    cancelBooking: vi.fn(),
    markBookingCompleted: vi.fn(),
    rescheduleBooking: vi.fn(),
  }),
);
vi.mock('../api/bookingsWrite', () => ({
  approveBooking,
  rejectBooking,
  cancelBooking,
  markBookingCompleted,
  rescheduleBooking,
}));

import { BookingActions } from './BookingActions';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function entry(over: Partial<BookingEntry>): BookingEntry {
  return {
    _id: 'ses1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    serviceType: 'Dog Walking',
    status: 'SCHEDULED',
    startTime: '2026-07-16T09:00:00',
    completedAt: '',
    departedAt: '',
    notes: '',
    kinfolkNotes: '',
    createdAt: fakeTs('2026-07-15T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  approveBooking.mockReset();
  rejectBooking.mockReset();
  cancelBooking.mockReset();
  markBookingCompleted.mockReset();
  rescheduleBooking.mockReset();
});

describe('BookingActions: unavailable entry', () => {
  it('renders an honest "unavailable" dialog rather than a blank or fabricated detail', () => {
    const onClose = vi.fn();
    render(<BookingActions entry={null} onClose={onClose} />);
    expect(screen.getByText(/booking unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
  });

  it('Done calls onClose', async () => {
    const onClose = vi.fn();
    render(<BookingActions entry={null} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^done$/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('BookingActions: detail view', () => {
  it('shows the household, service, when, notes, and status chip', () => {
    render(
      <BookingActions
        entry={entry({ kinfolkNotes: 'Leave the gate latched.' })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/the whitfields · booking/i)).toBeInTheDocument();
    expect(screen.getByText('Dog Walking')).toBeInTheDocument();
    expect(screen.getByText(/Jul 16, 9:00 AM/)).toBeInTheDocument();
    expect(screen.getByText('Leave the gate latched.')).toBeInTheDocument();
    expect(screen.getByText('SCHEDULED')).toBeInTheDocument();
  });

  it('an unnamed kinfolk renders "Unnamed Kinfolk" rather than a blank title', () => {
    render(<BookingActions entry={entry({ kinfolkName: '' })} onClose={vi.fn()} />);
    expect(screen.getByText(/unnamed kinfolk · booking/i)).toBeInTheDocument();
  });

  it('DRAFT/PENDING offer Approve + Reject, not Cancel/Complete/Reschedule', () => {
    render(<BookingActions entry={entry({ status: 'DRAFT' })} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark Completed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull();
  });

  it('SCHEDULED offers Mark Completed + Cancel + Reschedule, not Approve/Reject', () => {
    render(<BookingActions entry={entry({ status: 'SCHEDULED' })} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Mark Completed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('COMPLETED/CANCELLED/UNKNOWN offer no actions, only Done, mirroring KebabMenu\'s terminal guard', () => {
    render(<BookingActions entry={entry({ status: 'COMPLETED' })} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^done$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark Completed' })).toBeNull();
    expect(screen.getByText(/reached a final state/i)).toBeInTheDocument();
  });

  it('an unrecognized status offers no actions and names the raw status honestly', () => {
    render(<BookingActions entry={entry({ status: 'WEIRD_STATUS' })} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText(/"WEIRD_STATUS".*isn't recognized/i)).toBeInTheDocument();
  });
});

describe('BookingActions: Approve', () => {
  it('requires confirmation before calling approveBooking', async () => {
    approveBooking.mockResolvedValue(undefined);
    render(<BookingActions entry={entry({ status: 'DRAFT' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approveBooking).not.toHaveBeenCalled();
    expect(screen.getByText(/approve this booking/i)).toBeInTheDocument();
  });

  it('calls approveBooking with the booking id on confirm, then closes', async () => {
    approveBooking.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<BookingActions entry={entry({ _id: 'ses-9', status: 'DRAFT' })} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /approve booking/i }));
    expect(approveBooking).toHaveBeenCalledWith('ses-9');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Back returns to the detail view without approving', async () => {
    render(<BookingActions entry={entry({ status: 'DRAFT' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(approveBooking).not.toHaveBeenCalled();
    expect(screen.getByText(/the whitfields · booking/i)).toBeInTheDocument();
  });

  it('fails loud, naming the action, and does not close, when approveBooking rejects', async () => {
    approveBooking.mockRejectedValue(new Error('permission-denied'));
    const onClose = vi.fn();
    render(<BookingActions entry={entry({ status: 'DRAFT' })} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /approve booking/i }));
    expect(await screen.findByText(/approve failed: permission-denied/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables Back and the confirm button while the write is in flight', async () => {
    let resolveWrite: (() => void) | undefined;
    approveBooking.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    render(<BookingActions entry={entry({ status: 'DRAFT' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: /approve booking/i }));
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
    resolveWrite?.();
  });
});

describe('BookingActions: Reject / Cancel', () => {
  it('Reject confirms, then calls rejectBooking', async () => {
    rejectBooking.mockResolvedValue(undefined);
    render(<BookingActions entry={entry({ _id: 'ses-1', status: 'PENDING' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await userEvent.click(screen.getByRole('button', { name: /reject booking/i }));
    expect(rejectBooking).toHaveBeenCalledWith('ses-1');
  });

  it('Cancel confirms, then calls cancelBooking (a different action than Reject)', async () => {
    cancelBooking.mockResolvedValue(undefined);
    render(<BookingActions entry={entry({ _id: 'ses-2', status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: /cancel visit/i }));
    expect(cancelBooking).toHaveBeenCalledWith('ses-2');
    expect(rejectBooking).not.toHaveBeenCalled();
  });
});

describe('BookingActions: Mark Completed', () => {
  it('confirms, then calls markBookingCompleted with the booking id and an ISO timestamp', async () => {
    markBookingCompleted.mockResolvedValue(undefined);
    render(<BookingActions entry={entry({ _id: 'ses-3', status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Completed' }));
    await userEvent.click(screen.getByRole('button', { name: /^mark completed$/i }));
    expect(markBookingCompleted).toHaveBeenCalledWith('ses-3', expect.any(String));
    const [, iso] = markBookingCompleted.mock.calls[0] as [string, string];
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });
});

describe('BookingActions: Reschedule', () => {
  it('opens a start/end form, not a bare confirm', async () => {
    render(<BookingActions entry={entry({ status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    expect(screen.getByText('Start')).toBeInTheDocument();
    expect(screen.getByText('End')).toBeInTheDocument();
  });

  it('rejects submission with a blank end time, without calling the callable', async () => {
    render(<BookingActions entry={entry({ status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    await userEvent.click(screen.getByRole('button', { name: /save new time/i }));
    expect(screen.getByText(/pick both a start and end time/i)).toBeInTheDocument();
    expect(rescheduleBooking).not.toHaveBeenCalled();
  });

  it('rejects an end time at or before the start time', async () => {
    render(<BookingActions entry={entry({ status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    const inputs = document.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: '2026-07-20T10:00' } });
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: '2026-07-20T09:00' } });
    await userEvent.click(screen.getByRole('button', { name: /save new time/i }));
    expect(screen.getByText(/end time must be after the start time/i)).toBeInTheDocument();
    expect(rescheduleBooking).not.toHaveBeenCalled();
  });

  it('calls rescheduleBooking with the id and both times, then closes', async () => {
    rescheduleBooking.mockResolvedValue({ ok: true, sessionId: 'ses-5' });
    const onClose = vi.fn();
    render(<BookingActions entry={entry({ _id: 'ses-5', status: 'SCHEDULED' })} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    const inputs = document.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: '2026-07-20T09:00' } });
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: '2026-07-20T10:00' } });
    await userEvent.click(screen.getByRole('button', { name: /save new time/i }));
    expect(rescheduleBooking).toHaveBeenCalledWith('ses-5', '2026-07-20T09:00', '2026-07-20T10:00');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fails loud, naming the callable, when rescheduleBooking rejects', async () => {
    rescheduleBooking.mockRejectedValue(new Error("Session 'ses-5' not found."));
    render(<BookingActions entry={entry({ _id: 'ses-5', status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    const inputs = document.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: '2026-07-20T09:00' } });
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: '2026-07-20T10:00' } });
    await userEvent.click(screen.getByRole('button', { name: /save new time/i }));
    expect(await screen.findByText(/rescheduleBooking failed:.*not found/i)).toBeInTheDocument();
  });
});
