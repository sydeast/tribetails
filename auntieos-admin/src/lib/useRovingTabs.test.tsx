// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRovingTabs } from './useRovingTabs';

/**
 * Exercises the hook the way every real screen wires it: a row of
 * role="tab" buttons, one active at a time via onClick, spread with
 * {...getTabProps(index)}. This is the same shape as Invoices.tsx /
 * Bookings.tsx / Sessions.tsx / etc. after the roving-tabindex edit.
 */
const LABELS = ['All', 'Open', 'Overdue', 'Paid'];

function FilterTabs({ onActivate }: { onActivate?: (label: string) => void }) {
  const [active, setActive] = useState(0);
  const { getTabProps } = useRovingTabs({ count: LABELS.length, activeIndex: active });

  return (
    <div role="tablist" aria-label="Filter">
      {LABELS.map((label, index) => (
        <button
          key={label}
          type="button"
          role="tab"
          aria-selected={active === index}
          onClick={() => {
            setActive(index);
            onActivate?.(label);
          }}
          {...getTabProps(index)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

describe('useRovingTabs', () => {
  it('gives the active tab tabIndex=0 and every other tab tabIndex=-1', () => {
    render(<FilterTabs />);
    const tabs = screen.getAllByRole('tab');

    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[2]).toHaveAttribute('tabindex', '-1');
    expect(tabs[3]).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight moves DOM focus to the next tab without changing selection', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<FilterTabs onActivate={onActivate} />);
    const tabs = screen.getAllByRole('tab');

    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}');

    expect(tabs[1]).toHaveFocus();
    // Arrow movement is focus-only (manual activation model): it must not
    // fire the caller's onClick / selection logic on its own.
    expect(onActivate).not.toHaveBeenCalled();
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowRight wraps from the last tab back to the first', async () => {
    const user = userEvent.setup();
    render(<FilterTabs />);
    const tabs = screen.getAllByRole('tab');

    tabs[3]?.focus();
    await user.keyboard('{ArrowRight}');

    expect(tabs[0]).toHaveFocus();
  });

  it('ArrowLeft wraps from the first tab to the last', async () => {
    const user = userEvent.setup();
    render(<FilterTabs />);
    const tabs = screen.getAllByRole('tab');

    tabs[0]?.focus();
    await user.keyboard('{ArrowLeft}');

    expect(tabs[3]).toHaveFocus();
  });

  it('Home jumps focus to the first tab, End jumps focus to the last', async () => {
    const user = userEvent.setup();
    render(<FilterTabs />);
    const tabs = screen.getAllByRole('tab');

    tabs[1]?.focus();
    await user.keyboard('{End}');
    expect(tabs[3]).toHaveFocus();

    await user.keyboard('{Home}');
    expect(tabs[0]).toHaveFocus();
  });

  it('roving tabIndex follows selection: after activating a different tab, only it is tabIndex=0', async () => {
    const user = userEvent.setup();
    render(<FilterTabs />);
    const tabs = screen.getAllByRole('tab');

    await user.click(tabs[2]!);

    expect(tabs[2]).toHaveAttribute('tabindex', '0');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[3]).toHaveAttribute('tabindex', '-1');
  });

  it('Enter activates the currently focused tab, even if it is not yet selected', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<FilterTabs onActivate={onActivate} />);
    const tabs = screen.getAllByRole('tab');

    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tabs[2]).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(onActivate).toHaveBeenCalledWith('Overdue');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('Space activates the currently focused tab', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<FilterTabs onActivate={onActivate} />);
    const tabs = screen.getAllByRole('tab');

    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}');
    await user.keyboard(' ');

    expect(onActivate).toHaveBeenCalledWith('Open');
  });
});
