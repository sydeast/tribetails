// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuntieDatePicker } from './AuntieDatePicker';
import type { DayAvailability } from '../lib/bookingAvailability';

// Local calendar days; pin the zone west of Greenwich so a UTC-parsing
// regression names the wrong weekday instead of quietly passing.
const ORIG_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  process.env.TZ = ORIG_TZ;
});

const TODAY = '2027-08-15'; // a Sunday, mid-month, so both edges are reachable

function availability(over: Partial<DayAvailability> = {}) {
  return (iso: string): DayAvailability => ({
    iso,
    past: iso < TODAY,
    hours: { kind: 'open', startHHmm: '09:00', endHHmm: '17:00' },
    hoursKnown: true,
    blocked: [],
    sessionCount: 0,
    scheduleKnown: true,
    holidayName: null,
    ...over,
  });
}

/** Renders the picker with real selection state, the way the dialog drives it. */
function Harness(props: {
  initial?: string[];
  availabilityFor?: (iso: string) => DayAvailability;
  onToggle?: (iso: string) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(props.initial ?? []));
  return (
    <AuntieDatePicker
      selected={selected}
      onToggle={(iso) => {
        props.onToggle?.(iso);
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(iso)) next.delete(iso);
          else next.add(iso);
          return next;
        });
      }}
      todayIso={TODAY}
      availabilityFor={props.availabilityFor ?? availability()}
      mode="multi"
      label="Visit dates"
    />
  );
}

/** The one cell currently in the Tab order. */
function tabbableCell(): HTMLElement {
  const cells = screen.getAllByRole('gridcell').filter((c) => c.tabIndex === 0);
  expect(cells).toHaveLength(1);
  return cells[0]!;
}

describe('AuntieDatePicker', () => {
  it('opens on the month containing today when nothing is selected', () => {
    render(<Harness />);
    expect(screen.getByText('August 2027')).toBeInTheDocument();
  });

  it('opens on the month of the EARLIEST selection, so a part-filled form lands where it was', () => {
    render(<Harness initial={['2027-11-04', '2027-10-02']} />);
    expect(screen.getByText('October 2027')).toBeInTheDocument();
  });

  it('toggles a day on and back off', async () => {
    const onToggle = vi.fn();
    render(<Harness onToggle={onToggle} />);
    const cell = screen.getByRole('gridcell', { name: /Fri, Aug 20/ });

    await userEvent.click(cell);
    expect(onToggle).toHaveBeenLastCalledWith('2027-08-20');
    expect(cell).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(cell);
    expect(cell).toHaveAttribute('aria-selected', 'false');
  });

  it('refuses a day in the past but keeps it focusable', async () => {
    const onToggle = vi.fn();
    render(<Harness onToggle={onToggle} />);
    const past = screen.getByRole('gridcell', { name: /Tue, Aug 3, in the past, not available/ });

    await userEvent.click(past);
    expect(onToggle).not.toHaveBeenCalled();
    expect(past).toHaveAttribute('aria-selected', 'false');
    // Focusable, not `disabled`: arrowing left off the 1st of the month must not
    // drop focus to the document and strand a keyboard user mid-grid.
    expect(past).not.toBeDisabled();
    expect(past).toHaveAttribute('aria-disabled', 'true');
  });

  it('walks months with the header buttons', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('September 2027')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText('July 2027')).toBeInTheDocument();
  });

  describe('availability marks', () => {
    it('marks and speaks a closed day, and still lets the operator pick it', async () => {
      const onToggle = vi.fn();
      render(
        <Harness
          onToggle={onToggle}
          availabilityFor={(iso) => ({ ...availability()(iso), hours: { kind: 'closed' } })}
        />,
      );
      const cell = screen.getByRole('gridcell', { name: /Fri, Aug 20, business closed/ });
      expect(cell.textContent).toContain('Closed');
      // The operator IS the business and may decide to work a Sunday.
      await userEvent.click(cell);
      expect(onToggle).toHaveBeenCalledWith('2027-08-20');
    });

    it('marks and speaks a blocked window', () => {
      render(
        <Harness
          availabilityFor={(iso) => ({
            ...availability()(iso),
            blocked: [{ label: '8:00 AM to 12:00 PM', startHHmm: '08:00', endHHmm: '12:00' }],
          })}
        />,
      );
      const cell = screen.getByRole('gridcell', {
        name: /Fri, Aug 20, open 9:00 AM to 5:00 PM, blocked 8:00 AM to 12:00 PM/,
      });
      expect(cell.textContent).toContain('Blocked');
    });

    it('C1: refuses a company holiday, unlike a plain closed-hours day -- the operator is NOT offered it', async () => {
      const onToggle = vi.fn();
      render(
        <Harness
          onToggle={onToggle}
          availabilityFor={(iso) => ({ ...availability()(iso), holidayName: 'Independence Day' })}
        />,
      );
      const cell = screen.getByRole('gridcell', { name: /Fri, Aug 20, closed for Independence Day, not available/ });
      expect(cell.textContent).toContain('Closed');
      expect(cell).toHaveAttribute('aria-disabled', 'true');
      // Focusable, not `disabled`, same as a past day: arrowing onto it must not
      // strand a keyboard user, but activating it must not select it either.
      expect(cell).not.toBeDisabled();

      await userEvent.click(cell);
      expect(onToggle).not.toHaveBeenCalled();
      expect(cell).toHaveAttribute('aria-selected', 'false');
    });

    it('claims nothing when availability could not be read', () => {
      render(
        <Harness
          availabilityFor={(iso) => ({
            ...availability()(iso),
            hoursKnown: false,
            scheduleKnown: false,
            hours: { kind: 'closed' },
          })}
        />,
      );
      const cell = screen.getByRole('gridcell', { name: /Fri, Aug 20, availability unknown/ });
      // No "Closed" badge: we do not know that, and the dialog's banner says so.
      expect(cell.textContent).not.toContain('Closed');
    });
  });

  describe('keyboard', () => {
    it('puts exactly ONE cell in the Tab order', () => {
      render(<Harness />);
      expect(screen.getAllByRole('gridcell').length).toBe(42);
      expect(tabbableCell()).toHaveAccessibleName(/Today/);
    });

    it('moves a day with Left/Right and a WEEK with Up/Down', async () => {
      render(<Harness />);
      tabbableCell().focus();

      await userEvent.keyboard('{ArrowRight}');
      expect(document.activeElement).toHaveAccessibleName(/Tomorrow/);
      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement).toHaveAccessibleName(/Mon, Aug 23/);
      await userEvent.keyboard('{ArrowUp}{ArrowLeft}');
      expect(document.activeElement).toHaveAccessibleName(/Today/);
    });

    it('Home and End go to the ends of the focused WEEK, not of the grid', async () => {
      render(<Harness />);
      tabbableCell().focus(); // Sun Aug 15; the grid is Monday-first

      await userEvent.keyboard('{Home}');
      expect(document.activeElement).toHaveAccessibleName(/Mon, Aug 9/);
      await userEvent.keyboard('{End}');
      expect(document.activeElement).toHaveAccessibleName(/Today/);
    });

    it('PageUp and PageDown change month and keep focus on the day', async () => {
      render(<Harness />);
      tabbableCell().focus();

      await userEvent.keyboard('{PageDown}');
      expect(screen.getByText('September 2027')).toBeInTheDocument();
      expect(document.activeElement).toHaveAccessibleName(/Wed, Sep 15/);

      await userEvent.keyboard('{PageUp}{PageUp}');
      expect(screen.getByText('July 2027')).toBeInTheDocument();
      expect(document.activeElement).toHaveAccessibleName(/Thu, Jul 15/);
    });

    it('arrowing off the edge renders the next month and follows the day into it', async () => {
      render(<Harness />);
      tabbableCell().focus();
      // Aug 15 to Sep 5 is three weeks forward, past the end of August.
      await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
      expect(screen.getByText('September 2027')).toBeInTheDocument();
      expect(document.activeElement).toHaveAccessibleName(/Sun, Sep 5/);
    });

    it('selects the focused day with Enter and with Space', async () => {
      const onToggle = vi.fn();
      render(<Harness onToggle={onToggle} />);
      tabbableCell().focus();

      await userEvent.keyboard('{ArrowRight}{Enter}');
      expect(onToggle).toHaveBeenLastCalledWith('2027-08-16');
      await userEvent.keyboard('{ArrowRight}[Space]');
      expect(onToggle).toHaveBeenLastCalledWith('2027-08-17');
      expect(onToggle).toHaveBeenCalledTimes(2);
    });

    it('keeps the Tab target inside the month the header buttons moved to', async () => {
      render(<Harness />);
      await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
      // Otherwise Tab lands on a cell that is no longer rendered and focus falls
      // out of the grid entirely.
      expect(tabbableCell()).toHaveAccessibleName(/Wed, Sep 15/);
    });
  });
});
