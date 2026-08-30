// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { rescheduleBooking } = vi.hoisted(() => ({ rescheduleBooking: vi.fn() }));
vi.mock('../api/bookingsWrite', () => ({ rescheduleBooking }));

import { BulkRescheduleDialog } from './BulkRescheduleDialog';
import { type RescheduleTarget } from '../lib/bookingReschedule';
import { type BulkRescheduleOutcome } from '../lib/bookingReschedule';

/**
 * The per-visit review sheet (#397 M16).
 *
 * `api/scheduleWrite` is deliberately NOT mocked: `overridableScheduleRefusal`
 * and `overrideHint` are the real refusal-reading logic these tests assert
 * against, and faking them would make the override cases prove nothing. That is
 * the same split BlockTimeDialog.test.tsx keeps.
 */

const onClose = vi.fn();
const user = userEvent.setup();

beforeEach(() => {
  rescheduleBooking.mockReset().mockResolvedValue({ ok: true });
  onClose.mockReset();
});

/** A callable rejection shaped the way `lib/fns.call` re-throws a FirebaseError. */
function refusal(code: string, message: string) {
  return Object.assign(new Error(message), {
    code: 'functions/failed-precondition',
    details: { code },
  });
}

function target(over: Partial<RescheduleTarget> = {}): RescheduleTarget {
  return {
    id: 'ses1',
    name: 'The Wrens',
    date: '2026-07-16',
    time: '09:00',
    durationMinutes: 60,
    currentStart: '2026-07-16T09:00:00',
    ...over,
  };
}

const WREN = target();
const DEVLIN = target({
  id: 'ses2',
  name: 'The Devlins',
  date: '2026-07-16',
  time: '14:00',
  currentStart: '2026-07-16T14:00:00',
});

function open(targets: RescheduleTarget[], skipped: { id: string; name: string; reason: string }[] = []) {
  render(<BulkRescheduleDialog targets={targets} skipped={skipped} onClose={onClose} />);
}

/** The outcome the sheet handed back when Done was pressed. */
function closedWith(): BulkRescheduleOutcome {
  const last = onClose.mock.calls.at(-1)?.[0];
  if (last === undefined || last === null) throw new Error('the sheet closed with no outcome');
  return last as BulkRescheduleOutcome;
}

async function retype(label: string, value: string) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
}

describe('BulkRescheduleDialog', () => {
  it('gives every selected visit its own prefilled field', () => {
    open([WREN, DEVLIN]);
    expect(screen.getByLabelText('New date for The Wrens')).toHaveValue('2026-07-16');
    expect(screen.getByLabelText('New time for The Wrens')).toHaveValue('09:00');
    expect(screen.getByLabelText('New time for The Devlins')).toHaveValue('14:00');
  });

  it('moves each adjusted visit to ITS OWN new window, and never the ones left alone', async () => {
    open([WREN, DEVLIN]);
    await retype('New date for The Wrens', '2026-07-17');
    await retype('New time for The Wrens', '11:30');
    await retype('New time for The Devlins', '16:45');

    await user.click(screen.getByRole('button', { name: 'Reschedule 2 visits' }));

    expect(rescheduleBooking).toHaveBeenCalledTimes(2);
    // One call per visit, each with the window that visit was given. The two
    // are a different day AND a different clock, which is exactly what one
    // shared delta could never express.
    const [firstId, firstStart, firstEnd] = rescheduleBooking.mock.calls[0]!;
    expect(firstId).toBe('ses1');
    expect(firstStart).toBe(new Date(2026, 6, 17, 11, 30).toISOString());
    expect(firstEnd).toBe(new Date(2026, 6, 17, 12, 30).toISOString());
    const [secondId, secondStart] = rescheduleBooking.mock.calls[1]!;
    expect(secondId).toBe('ses2');
    expect(secondStart).toBe(new Date(2026, 6, 16, 16, 45).toISOString());

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(closedWith().applied.map((a) => a.name)).toEqual(['The Wrens', 'The Devlins']);
  });

  it('leaves an untouched visit where it is and says so, rather than firing a write', async () => {
    open([WREN, DEVLIN]);
    await retype('New time for The Wrens', '11:30');

    await user.click(screen.getByRole('button', { name: 'Reschedule 2 visits' }));

    expect(rescheduleBooking).toHaveBeenCalledTimes(1);
    expect(rescheduleBooking.mock.calls[0]![0]).toBe('ses1');
    expect(await screen.findByText('Left where they are:')).toBeInTheDocument();
    expect(screen.getByText(/Its time is unchanged/)).toBeInTheDocument();
  });

  it('names a per-row refusal and offers the override it carries, once', async () => {
    rescheduleBooking.mockRejectedValueOnce(
      refusal('visit_overlap_conflict', 'A visit already runs from 11:30 to 12:30.'),
    );
    open([WREN]);
    await retype('New time for The Wrens', '11:30');
    await user.click(screen.getByRole('button', { name: 'Reschedule 1 visit' }));

    expect(await screen.findByText('Not moved:')).toBeInTheDocument();
    expect(screen.getByText(/A visit already runs from 11:30/)).toBeInTheDocument();

    // The refusal is overridable, so the operator is offered the way past it.
    const override = screen.getByRole('button', { name: 'Move over the booked visit' });
    // The retry is refused a second time. The offer must NOT come back: the
    // same losing move is never offered twice.
    rescheduleBooking.mockRejectedValueOnce(
      refusal('visit_overlap_conflict', 'A visit already runs from 11:30 to 12:30.'),
    );
    await user.click(override);

    expect(rescheduleBooking).toHaveBeenCalledTimes(2);
    expect(rescheduleBooking.mock.calls[1]![3]).toEqual({ visit: true });
    expect(
      screen.queryByRole('button', { name: 'Move over the booked visit' }),
    ).not.toBeInTheDocument();
  });

  it('never offers an override for a company closure', async () => {
    rescheduleBooking.mockRejectedValueOnce(
      refusal('company_holiday_conflict', 'The business is closed that day.'),
    );
    open([WREN]);
    await retype('New time for The Wrens', '11:30');
    await user.click(screen.getByRole('button', { name: 'Reschedule 1 visit' }));

    expect(await screen.findByText(/The business is closed that day/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move over/ })).not.toBeInTheDocument();
  });

  it('reports a partial failure per visit: some landed, one did not', async () => {
    rescheduleBooking
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('The visit could not be read.'));
    open([WREN, DEVLIN], [{ id: 'ses3', name: 'The Sparrows', reason: 'It has already been completed.' }]);
    await retype('New time for The Wrens', '11:30');
    await retype('New time for The Devlins', '16:45');

    await user.click(screen.getByRole('button', { name: 'Reschedule 2 visits' }));

    expect(await screen.findByText('Moved 1 of 3 selected visits.')).toBeInTheDocument();
    expect(screen.getByText(/The visit could not be read/)).toBeInTheDocument();
    expect(screen.getByText(/already been completed/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    const outcome = closedWith();
    expect(outcome.applied.map((a) => a.name)).toEqual(['The Wrens']);
    expect(outcome.failures.map((f) => f.name)).toEqual(['The Devlins']);
    // A plain error carries no conflict code, so there is nothing to override.
    expect(outcome.failures[0]!.override).toBeNull();
    expect(outcome.skipped.map((s) => s.name)).toEqual(['The Sparrows']);
  });

  it('a visit the selection could not offer is named before anything is written', () => {
    open([WREN], [{ id: 'ses9', name: 'The Mercers', reason: 'It has already been cancelled.' }]);
    expect(screen.getByText('Not offered a new time:')).toBeInTheDocument();
    expect(screen.getByText(/already been cancelled/)).toBeInTheDocument();
  });

  it('an override that lands turns the row into a move', async () => {
    rescheduleBooking.mockRejectedValueOnce(
      refusal('booking_busy_conflict', 'That window is imported as busy.'),
    );
    open([WREN]);
    await retype('New time for The Wrens', '11:30');
    await user.click(screen.getByRole('button', { name: 'Reschedule 1 visit' }));
    await user.click(await screen.findByRole('button', { name: 'Move over the busy block' }));
    expect(rescheduleBooking.mock.calls[1]![3]).toEqual({ busy: true });
    expect(screen.getByText('Moved 1 of 1 selected visit.')).toBeInTheDocument();
    expect(screen.queryByText('Not moved:')).toBeNull();
  });
  it('Escape mid-run does not close the sheet, so no landed write goes unreported', async () => {
    // The footer buttons disable while a run is in flight; Escape and a
    // backdrop click reach the Dialog's own dismiss and would otherwise unmount
    // the sheet with writes still going out.
    let release: (() => void) | undefined;
    rescheduleBooking.mockImplementationOnce(
      () => new Promise<{ ok: true }>((resolve) => { release = () => resolve({ ok: true }); }),
    );
    open([WREN]);
    await retype('New time for The Wrens', '11:30');
    await user.click(screen.getByRole('button', { name: 'Reschedule 1 visit' }));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    release?.();
    expect(await screen.findByText('Moved 1 of 1 selected visit.')).toBeInTheDocument();
  });
  it('backing out writes nothing and reports no outcome', async () => {
    open([WREN]);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(rescheduleBooking).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(null);
  });
});
