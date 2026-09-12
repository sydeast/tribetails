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

import { BookingActions, BookingStatusActions } from './BookingActions';

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
    await userEvent.click(screen.getByRole('button', { name: /yes, approve it/i }));
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
    await userEvent.click(screen.getByRole('button', { name: /yes, approve it/i }));
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
    await userEvent.click(screen.getByRole('button', { name: /yes, approve it/i }));
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
    await userEvent.click(screen.getByRole('button', { name: /yes, reject it/i }));
    expect(rejectBooking).toHaveBeenCalledWith('ses-1');
  });

  it('Cancel confirms, then calls cancelBooking (a different action than Reject)', async () => {
    cancelBooking.mockResolvedValue(undefined);
    render(<BookingActions entry={entry({ _id: 'ses-2', status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: /yes, cancel the visit/i }));
    expect(cancelBooking).toHaveBeenCalledWith('ses-2');
    expect(rejectBooking).not.toHaveBeenCalled();
  });
});

/**
 * A3: `actionsFor` decides what this panel OFFERS; the server decides what is
 * ALLOWED. The two agree today, and that is exactly why the disagreement needs
 * a test: a stale row, a second operator acting first, or a status this app
 * cannot read all reach a callable that refuses with `failed-precondition`.
 * The operator must see the server's own sentence, not a swallowed failure or
 * a rewritten one.
 */
describe('BookingActions: a server refusal the offer-map did not predict', () => {
  it('surfaces an illegal-transition refusal verbatim and does not close', async () => {
    cancelBooking.mockRejectedValue(
      new Error('Cannot CANCEL a booking in status COMPLETED. Allowed from: SCHEDULED, ON_MY_WAY, ARRIVED, DEPARTED.'),
    );
    const onClose = vi.fn();
    render(<BookingActions entry={entry({ _id: 'ses-2', status: 'SCHEDULED' })} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: /yes, cancel the visit/i }));
    expect(
      await screen.findByText(/cannot cancel a booking in status completed/i),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * ISSUE #582. The distance refusal is a SECOND, differently-coded refusal
   * under the same operator switch, and the two remedies are different: one
   * says record the step, the other says you were measured a long way from the
   * house. This surface has no arrival control of its own — the in-visit
   * lifecycle lives on the phone and the desktop console — so the server's own
   * sentence, which names the distance and both ways out, is the whole of what
   * a React-only operator gets. It must not be swallowed or rewritten.
   */
  it('surfaces the arrival-radius refusal verbatim, naming the distance and the radius', async () => {
    markBookingCompleted.mockRejectedValue(
      new Error(
        "This visit's arrival was recorded 2.4 km from the household, and your settings require " +
          'it within 150 m. Record the arrival again from the household, widen "Arrival must be ' +
          'within" in Settings, or turn off "Verify arrival and departure".',
      ),
    );
    const onClose = vi.fn();
    render(<BookingActions entry={entry({ _id: 'ses-8', status: 'SCHEDULED' })} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Completed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, mark it completed' }));
    expect(await screen.findByText(/2\.4 km from the household/i)).toBeInTheDocument();
    expect(await screen.findByText(/within 150 m/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces an unreadable-status refusal verbatim', async () => {
    markBookingCompleted.mockRejectedValue(
      new Error("Booking status 'HIJACKED' is not a status this app recognizes, so no transition can be applied to it."),
    );
    render(<BookingActions entry={entry({ _id: 'ses-3', status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Completed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, mark it completed' }));
    expect(await screen.findByText(/not a status this app recognizes/i)).toBeInTheDocument();
  });
});

describe('BookingActions: Mark Completed', () => {
  it('confirms, then calls markBookingCompleted with the booking id and an ISO timestamp', async () => {
    markBookingCompleted.mockResolvedValue(undefined);
    render(<BookingActions entry={entry({ _id: 'ses-3', status: 'SCHEDULED' })} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Completed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, mark it completed' }));
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
/**
 * `BookingStatusActions` is the same decision as the dialog above, rendered as
 * a panel so it can be composed into `BookingDetailModal` (Bookings.tsx does
 * exactly that). These cases pin the parts that are NOT shared with the dialog:
 * the in-place confirm step (no nested modal) and `onDone` firing only after
 * the write lands.
 */
describe('BookingStatusActions (the panel composed into the detail sheet)', () => {
  it('offers Approve and Reject on a pending booking, the same pair as the dialog', () => {
    render(<BookingStatusActions entry={entry({ status: 'PENDING' })} onDone={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });
  it('offers Mark Completed and Cancel on a scheduled booking', () => {
    render(<BookingStatusActions entry={entry({ status: 'SCHEDULED' })} onDone={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Mark Completed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
  it('offers nothing on a terminal booking, and says so rather than rendering a bare empty panel', () => {
    render(<BookingStatusActions entry={entry({ status: 'COMPLETED' })} onDone={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText(/reached a final state/i)).toBeInTheDocument();
  });
  it('names an unrecognized status instead of guessing at an action for it', () => {
    render(<BookingStatusActions entry={entry({ status: 'WEIRD' })} onDone={vi.fn()} />);
    expect(screen.getByText(/"WEIRD"/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
  it('confirms IN PLACE, never by opening a second dialog inside the sheet', async () => {
    render(<BookingStatusActions entry={entry({ status: 'PENDING' })} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(screen.getByText(/request will be cancelled\. This cannot be undone\./i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rejectBooking).not.toHaveBeenCalled();
  });
  /**
   * THE 2026-08-17 WALK. The confirm step rendered only the body, and the body
   * was present tense: "Sandy Demo's visit is marked Completed." next to a
   * button also labelled "Mark Completed". The operator read that as the write
   * having landed and the CTA having come back, pressed Back, and reported the
   * booking as stuck on Scheduled. The walk's own network log is the proof:
   * 20 minutes on /bookings, 74 requests, zero calls to transitionBookingStatus.
   *
   * The suite at the time was green, because every test clicked the trigger and
   * then clicked the confirm and asserted the write. None of them looked at
   * whether the two steps could be told apart. These three do.
   */
  it('renders the QUESTION on the confirm step, not just the consequence', async () => {
    render(<BookingStatusActions entry={entry({ status: 'SCHEDULED' })} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Completed' }));
    expect(screen.getByRole('heading', { name: 'Mark this visit completed?' })).toBeInTheDocument();
  });
  it('states the outcome in the future tense, never as something already done', async () => {
    render(<BookingStatusActions entry={entry({ status: 'SCHEDULED' })} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Completed' }));
    expect(screen.getByText(/will be marked Completed/i)).toBeInTheDocument();
    expect(screen.queryByText(/is marked Completed\./i)).toBeNull();
  });
  it('never labels the confirm button with the string the operator just pressed', async () => {
    for (const [status, trigger] of [
      ['SCHEDULED', 'Mark Completed'],
      ['SCHEDULED', 'Cancel'],
      ['PENDING', 'Approve'],
      ['PENDING', 'Reject'],
    ] as const) {
      const { unmount } = render(<BookingStatusActions entry={entry({ status })} onDone={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: trigger }));
      // The trigger is gone, and nothing on the confirm step wears its name.
      expect(screen.queryByRole('button', { name: trigger })).toBeNull();
      unmount();
    }
  });
  it('Back returns to the buttons without writing anything', async () => {
    render(<BookingStatusActions entry={entry({ status: 'PENDING' })} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(approveBooking).not.toHaveBeenCalled();
  });
  it('writes the booking id and calls onDone once the confirm is pressed', async () => {
    approveBooking.mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<BookingStatusActions entry={entry({ _id: 'ses-9', status: 'PENDING' })} onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, approve it' }));
    expect(approveBooking).toHaveBeenCalledWith('ses-9');
    expect(onDone).toHaveBeenCalledOnce();
  });
  it('marks completed with a parseable ISO stamp, the same payload the dialog sends', async () => {
    markBookingCompleted.mockResolvedValue(undefined);
    render(<BookingStatusActions entry={entry({ _id: 'ses-3', status: 'SCHEDULED' })} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Completed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, mark it completed' }));
    expect(markBookingCompleted).toHaveBeenCalledWith('ses-3', expect.any(String));
    const [, iso] = markBookingCompleted.mock.calls[0] as [string, string];
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });
  it('fails loud on a rejected write, stays on the confirm step, and does NOT call onDone', async () => {
    cancelBooking.mockRejectedValue(new Error('permission-denied'));
    const onDone = vi.fn();
    render(<BookingStatusActions entry={entry({ status: 'SCHEDULED' })} onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel the visit' }));
    expect(await screen.findByText(/cancel failed: permission-denied/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, cancel the visit' })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  // #755: a Bookings card's own button opens the sheet with the question up.
  it('initialAction poses that transition\'s confirm on mount, writing nothing until the confirm', async () => {
    rejectBooking.mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(
      <BookingStatusActions
        entry={entry({ _id: 'ses-9', status: 'PENDING' })}
        initialAction="reject"
        onDone={onDone}
      />,
    );
    expect(screen.getByText('Reject this booking?')).toBeInTheDocument();
    expect(rejectBooking).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, reject it' }));
    expect(rejectBooking).toHaveBeenCalledWith('ses-9');
    expect(onDone).toHaveBeenCalledOnce();
  });
  it('an initialAction the current state does not offer poses nothing: the row moved on', () => {
    // A card pressed Approve, and the listener had already moved the row to
    // Scheduled. The sheet opens on the plain button row, never on a question
    // the state no longer allows.
    render(
      <BookingStatusActions
        entry={entry({ status: 'SCHEDULED' })}
        initialAction="approve"
        onDone={vi.fn()}
      />,
    );
    expect(screen.queryByText('Approve this booking?')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Completed' })).toBeInTheDocument();
  });
});
