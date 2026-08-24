// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { BookingMonthPicker } from './BookingMonthPicker';

/**
 * #544: month navigation. These render the picker directly with a pinned
 * `today`, because every assertion here is about a boundary (the month
 * before today, the day after the horizon) and reading those off the wall
 * clock is how a suite goes red at midnight -- the weekly-closure test in
 * BookingWizard.test.tsx already carries that scar.
 */

// A Sunday-ish mid-month weekday in a 31-day month, so no assertion below
// sits on a month edge by accident.
const TODAY = new Date(2026, 7, 12); // 2026-08-12

function Harness(props: { today?: Date; horizonDays?: number; closedDates?: Map<string, string> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <BookingMonthPicker
      selectedDates={selected}
      onToggle={(key) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        })
      }
      today={props.today ?? TODAY}
      {...(props.horizonDays !== undefined ? { horizonDays: props.horizonDays } : {})}
      {...(props.closedDates ? { closedDates: props.closedDates } : {})}
    />
  );
}

const day = (n: number) => screen.getByRole('button', { name: String(n) });
const prevMonth = () => screen.getByRole('button', { name: 'Previous month' });
const nextMonth = () => screen.getByRole('button', { name: 'Next month' });

describe('BookingMonthPicker: month navigation', () => {
  it('opens on today’s month and can page forward and back', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText('August 2026')).toBeInTheDocument();

    await user.click(nextMonth());
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    // A real September, not a fixed 28-day block.
    expect(screen.getAllByRole('button', { name: /^\d+$/ })).toHaveLength(30);

    await user.click(prevMonth());
    expect(screen.getByText('August 2026')).toBeInTheDocument();
  });

  it('refuses to page before today’s month', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(prevMonth()).toBeDisabled();

    await user.click(nextMonth());
    expect(prevMonth()).toBeEnabled();
    await user.click(prevMonth());
    expect(prevMonth()).toBeDisabled();
    expect(screen.getByText('August 2026')).toBeInTheDocument();
  });

  it('stops paging forward at the month holding the booking horizon', async () => {
    const user = userEvent.setup();
    // 40 days from 2026-08-12 lands on 2026-09-21, so September is the last
    // reachable month.
    render(<Harness horizonDays={40} />);
    expect(nextMonth()).toBeEnabled();
    await user.click(nextMonth());
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(nextMonth()).toBeDisabled();
  });

  it('crosses a year boundary', async () => {
    const user = userEvent.setup();
    render(<Harness today={new Date(2026, 11, 10)} />);
    await user.click(nextMonth());
    expect(screen.getByText('January 2027')).toBeInTheDocument();
  });
});

describe('BookingMonthPicker: bookable window', () => {
  it('shows days before today but will not let them be picked', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(day(11)).toBeDisabled(); // yesterday
    expect(day(1)).toBeDisabled(); // first of the month
    expect(day(12)).toBeEnabled(); // today is bookable

    await user.click(day(12));
    expect(day(12)).toHaveAttribute('aria-pressed', 'true');
  });

  it('disables the days past the horizon inside the last reachable month', async () => {
    const user = userEvent.setup();
    render(<Harness horizonDays={40} />); // horizon = 2026-09-21
    await user.click(nextMonth());
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(day(21)).toBeEnabled(); // the horizon day itself is bookable
    expect(day(22)).toBeDisabled();
    expect(day(22)).toHaveAttribute('title', 'Too far ahead to book');
  });

  it('offers the 29th through 31st of a long month', () => {
    render(<Harness />);
    for (const n of [29, 30, 31]) expect(day(n)).toBeEnabled();
  });
});

describe('BookingMonthPicker: closures and selection across months', () => {
  it('marks a closure in a month that is only reachable by paging forward', async () => {
    const user = userEvent.setup();
    render(<Harness closedDates={new Map([['2026-09-07', 'Labor Day']])} />);
    // The 7th is closed in September only; August's is merely in the past.
    expect(day(15)).toBeEnabled();

    await user.click(nextMonth());
    expect(day(7)).toBeDisabled();
    expect(day(7)).toHaveAttribute('title', 'Closed: Labor Day');
    expect(day(8)).toBeEnabled();
  });

  it('keeps dates picked in one month selected after paging away and back', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(day(20));
    expect(day(20)).toHaveAttribute('aria-pressed', 'true');

    await user.click(nextMonth());
    expect(day(20)).toHaveAttribute('aria-pressed', 'false'); // September 20th
    await user.click(day(20));

    await user.click(prevMonth());
    expect(day(20)).toHaveAttribute('aria-pressed', 'true'); // August 20th, still on
  });

  it('reports the real calendar date, not just the day number, when paged forward', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<BookingMonthPicker selectedDates={new Set()} onToggle={onToggle} today={TODAY} />);
    await user.click(nextMonth());
    await user.click(day(3));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0]![0]).toBe('2026-09-03');
    expect((onToggle.mock.calls[0]![1] as Date).getMonth()).toBe(8);
  });
});
