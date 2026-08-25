// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { createBlockedTimeSlot } = vi.hoisted(() => ({ createBlockedTimeSlot: vi.fn() }));
vi.mock('../api/scheduleWrite', async () => {
  // Only the callable is stubbed: `overridableScheduleRefusal` and
  // `overrideHint` are the real refusal-reading logic this suite is asserting
  // against, so faking them would make the override test prove nothing.
  const actual = await vi.importActual<typeof import('../api/scheduleWrite')>('../api/scheduleWrite');
  return { ...actual, createBlockedTimeSlot };
});

import { BlockTimeDialog } from './BlockTimeDialog';

const onClose = vi.fn();
const onBlocked = vi.fn();
const user = userEvent.setup();

beforeEach(() => {
  createBlockedTimeSlot.mockReset().mockResolvedValue({ ok: true, docId: 'slot-1' });
  onClose.mockReset();
  onBlocked.mockReset();
});

function open(initialDate = '2026-07-16') {
  render(<BlockTimeDialog initialDate={initialDate} onClose={onClose} onBlocked={onBlocked} />);
}

/** A callable rejection shaped the way `lib/fns.call` re-throws a FirebaseError. */
function refusal(code: string, message: string) {
  return Object.assign(new Error(message), { code: 'functions/failed-precondition', details: { code } });
}

describe('BlockTimeDialog', () => {
  it('sends the wall clock AND its epoch-ms twin, so the server can check the window', async () => {
    open();
    await user.click(screen.getByRole('button', { name: 'Block time' }));

    expect(createBlockedTimeSlot).toHaveBeenCalledTimes(1);
    const args = createBlockedTimeSlot.mock.calls[0]![0];
    expect(args).toMatchObject({
      date: '2026-07-16',
      startTime: '09:00',
      endTime: '12:00',
      notes: '',
    });
    // The twin is the SAME window, resolved in the operator's own zone. Built
    // here the same way, so this holds in any runner timezone.
    expect(args.startTimeMs).toBe(new Date(2026, 6, 16, 9, 0, 0, 0).getTime());
    expect(args.endTimeMs).toBe(new Date(2026, 6, 16, 12, 0, 0, 0).getTime());
    // No override on a first attempt: the key is absent, not `false`.
    expect(args).not.toHaveProperty('overrideVisitConflict');
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('carries the reason the operator typed', async () => {
    open();
    await user.type(screen.getByLabelText('Reason (optional)'), 'Vet appointment');
    await user.click(screen.getByRole('button', { name: 'Block time' }));
    expect(createBlockedTimeSlot.mock.calls[0]![0].notes).toBe('Vet appointment');
  });

  it('refuses to submit a window that ends before it starts, and says why', async () => {
    open();
    const end = screen.getByLabelText('End');
    await user.clear(end);
    await user.type(end, '08:00');

    expect(screen.getByText('The end has to come after the start.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Block time' })).toBeDisabled();
    expect(createBlockedTimeSlot).not.toHaveBeenCalled();
  });

  // ── the refusal path ───────────────────────────────────────────────────────

  it('surfaces the server’s own sentence when a visit already occupies the window', async () => {
    createBlockedTimeSlot.mockRejectedValueOnce(
      refusal(
        'visit_overlap_conflict',
        'That time is already taken: visit 1 (2026-07-16 14:00 UTC to 2026-07-16 17:00 UTC) overlaps a visit already booked (2026-07-16 15:00 UTC to 2026-07-16 16:00 UTC).',
      ),
    );
    open();
    await user.click(screen.getByRole('button', { name: 'Block time' }));

    expect(screen.getByText('Couldn’t block the time')).toBeInTheDocument();
    expect(screen.getByText(/overlaps a visit already booked/)).toBeInTheDocument();
    expect(onBlocked).not.toHaveBeenCalled();
    // The dialog stays open with the operator's input intact: a refusal is not
    // a reason to make them retype the window.
    expect(screen.getByLabelText('Start')).toHaveValue('09:00');
  });

  it('offers "Block anyway" on that refusal, and the retry carries the override flag', async () => {
    createBlockedTimeSlot
      .mockRejectedValueOnce(refusal('visit_overlap_conflict', 'That time is already taken.'))
      .mockResolvedValueOnce({ ok: true, docId: 'slot-2' });
    open();
    await user.click(screen.getByRole('button', { name: 'Block time' }));
    await user.click(screen.getByRole('button', { name: 'Block anyway' }));

    expect(createBlockedTimeSlot).toHaveBeenCalledTimes(2);
    expect(createBlockedTimeSlot.mock.calls[1]![0]).toMatchObject({ overrideVisitConflict: true });
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('never offers the same losing move twice: a failed override is not re-offered', async () => {
    createBlockedTimeSlot
      .mockRejectedValueOnce(refusal('visit_overlap_conflict', 'That time is already taken.'))
      .mockRejectedValueOnce(refusal('visit_overlap_conflict', 'That time is already taken.'));
    open();
    await user.click(screen.getByRole('button', { name: 'Block time' }));
    await user.click(screen.getByRole('button', { name: 'Block anyway' }));

    expect(screen.getByText('Couldn’t block the time')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block anyway' })).toBeNull();
  });

  /**
   * `guardCompanyHolidayConflict` has no override parameter at all, so the
   * dialog must not draw a button that would re-send the identical request.
   */
  it('a company-closure refusal is final: no override is offered', async () => {
    createBlockedTimeSlot.mockRejectedValueOnce(
      refusal('company_holiday_conflict', 'This date is not available: visit 1 (2026-12-25) falls on Christmas. The business is closed.'),
    );
    open();
    await user.click(screen.getByRole('button', { name: 'Block time' }));

    expect(screen.getByText(/The business is closed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block anyway' })).toBeNull();
  });
});
