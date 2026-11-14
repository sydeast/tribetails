// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeldButton } from './HeldButton';

const REASON = 'Only the owner can complete a visit.';

/**
 * #2199: a button that is shown, cannot be used, and says why. The reason has
 * to reach a mouse, a keyboard, a screen reader and a finger, which a natively
 * disabled button cannot do.
 */
describe('HeldButton', () => {
  it('is announced as unavailable and carries the reason as its description', () => {
    render(<HeldButton label="Complete" reason={REASON} />);
    const button = screen.getByRole('button', { name: 'Complete' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(REASON);
    // The name is the label alone: the reason is the description, not part of it.
    expect(button).toHaveAccessibleName('Complete');
  });

  it('is not natively disabled, so the keyboard can reach it', async () => {
    render(<HeldButton label="Complete" reason={REASON} />);
    const button = screen.getByRole('button', { name: 'Complete' });
    expect(button).not.toHaveAttribute('disabled');
    await userEvent.tab();
    expect(button).toHaveFocus();
  });

  it('keeps the reason out of sight until it is asked for, and mounted all along', () => {
    render(<HeldButton label="Complete" reason={REASON} />);
    const tip = screen.getByText(REASON);
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(tip).toHaveAttribute('hidden');
  });

  it('KEYBOARD: focus opens the reason, leaving puts it away', async () => {
    render(<HeldButton label="Complete" reason={REASON} />);
    const tip = screen.getByText(REASON);
    await userEvent.tab();
    expect(tip).not.toHaveAttribute('hidden');
    await userEvent.tab();
    expect(tip).toHaveAttribute('hidden');
  });

  it('MOUSE: hover opens the reason, leaving puts it away', async () => {
    render(<HeldButton label="Complete" reason={REASON} />);
    const button = screen.getByRole('button', { name: 'Complete' });
    const tip = screen.getByText(REASON);
    await userEvent.hover(button);
    expect(tip).not.toHaveAttribute('hidden');
    await userEvent.unhover(button);
    expect(tip).toHaveAttribute('hidden');
  });

  it('TOUCH: a press opens the reason and it stays up after the finger lifts', () => {
    render(<HeldButton label="Complete" reason={REASON} />);
    const button = screen.getByRole('button', { name: 'Complete' });
    const tip = screen.getByText(REASON);
    fireEvent.touchStart(button);
    expect(tip).not.toHaveAttribute('hidden');
    fireEvent.touchEnd(button);
    fireEvent.click(button);
    expect(tip).not.toHaveAttribute('hidden');
  });

  it('Escape puts the reason away', async () => {
    render(<HeldButton label="Complete" reason={REASON} />);
    const tip = screen.getByText(REASON);
    await userEvent.tab();
    expect(tip).not.toHaveAttribute('hidden');
    await userEvent.keyboard('{Escape}');
    expect(tip).toHaveAttribute('hidden');
  });

  it('wears the kit button it stands in for, in its disabled look', () => {
    const { rerender } = render(<HeldButton label="Complete" reason={REASON} />);
    const ghost = screen.getByRole('button', { name: 'Complete' });
    expect(ghost).toHaveClass('auntie-btn', 'auntie-btn--ghost', 'auntie-is-disabled');
    rerender(<HeldButton label="Mark Completed" reason={REASON} tone="primary" />);
    expect(screen.getByRole('button', { name: 'Mark Completed' })).toHaveClass('auntie-btn--primary', 'auntie-is-disabled');
  });
});
