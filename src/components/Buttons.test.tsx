// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GhostButton, IconButton, PrimaryButton } from './Buttons';

/**
 * The contract these buttons exist to enforce, in priority order:
 *
 *  1. No onClick means no control. The wasm AuntieChip takes a REQUIRED onClick
 *     and always applies .clickable, so callers who only wanted a badge pass
 *     `{}` and ship something that hovers, shows a hand cursor, and does
 *     nothing. Every "static" test below is that bug, pinned.
 *  2. Disabled means the `disabled` attribute. Grey-but-live is the same class
 *     of lie: the affordance says no and the handler says yes.
 *  3. Busy blocks the click without dropping the accessible name.
 */

const Glyph = () => <svg data-testid="glyph" />;

describe('PrimaryButton', () => {
  it('renders its label', () => {
    render(<PrimaryButton label="Send it" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send it' })).toBeInTheDocument();
  });

  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(<PrimaryButton label="Send it" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Send it' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire when disabled, and is really disabled', async () => {
    const onClick = vi.fn();
    render(<PrimaryButton label="Send it" onClick={onClick} disabled />);

    const button = screen.getByRole('button', { name: 'Send it' });
    // The attribute, not just the colour. userEvent would happily click a
    // button that was only styled grey, and so would a user.
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('THE BUG: renders static and non-interactive when onClick is omitted', () => {
    render(<PrimaryButton label="Read only" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Read only')).toBeInTheDocument();
  });

  it('does not fire while busy, and keeps its accessible name', async () => {
    const onClick = vi.fn();
    render(<PrimaryButton label="Send it" onClick={onClick} busy />);

    // Compose swaps the label for the spinner; on the web that would rename the
    // control to "" mid-flight, so the name has to survive.
    const button = screen.getByRole('button', { name: 'Send it' });
    expect(button).toHaveAttribute('aria-busy', 'true');

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is not marked busy when it is idle', () => {
    render(<PrimaryButton label="Send it" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send it' })).not.toHaveAttribute('aria-busy');
  });

  it('hides the leading adornment from the accessible name', () => {
    render(<PrimaryButton label="Send it" onClick={vi.fn()} leading={<Glyph />} />);
    // Decoration must not leak into the name, or it reads as "graphic Send it".
    expect(screen.getByRole('button', { name: 'Send it' })).toBeInTheDocument();
  });
});

describe('GhostButton', () => {
  it('renders its label', () => {
    render(<GhostButton label="Not now" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(<GhostButton label="Not now" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire when disabled, and is really disabled', async () => {
    const onClick = vi.fn();
    render(<GhostButton label="Not now" onClick={onClick} disabled />);

    const button = screen.getByRole('button', { name: 'Not now' });
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('THE BUG: renders static and non-interactive when onClick is omitted', () => {
    render(<GhostButton label="Read only" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Read only')).toBeInTheDocument();
  });
});

describe('IconButton', () => {
  it('names itself for screen readers, since the glyph carries no text', () => {
    render(<IconButton icon={<Glyph />} label="Delete visit" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Delete visit' })).toBeInTheDocument();
  });

  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(<IconButton icon={<Glyph />} label="Delete visit" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete visit' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire when disabled, and is really disabled', async () => {
    const onClick = vi.fn();
    render(<IconButton icon={<Glyph />} label="Delete visit" onClick={onClick} disabled />);

    const button = screen.getByRole('button', { name: 'Delete visit' });
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('THE BUG: renders static and non-interactive when onClick is omitted', () => {
    render(<IconButton icon={<Glyph />} label="Verified" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Still announced. Dropping the control also drops the accessible name
    // unless the span claims role=img, leaving the glyph invisible to a reader.
    expect(screen.getByRole('img', { name: 'Verified' })).toBeInTheDocument();
  });

  it('scales the glyph to half the tile', () => {
    const { container } = render(
      <IconButton icon={<Glyph />} label="Edit" onClick={vi.fn()} size={48} />,
    );

    const button = container.querySelector('button');
    expect(button?.style.getPropertyValue('--auntie-icon-size')).toBe('48px');
    expect(button?.style.getPropertyValue('--auntie-icon-glyph')).toBe('24px');
  });

  it('clamps the glyph so a tiny tile still renders a legible one', () => {
    const { container } = render(
      <IconButton icon={<Glyph />} label="Edit" onClick={vi.fn()} size={16} />,
    );

    // Half of 16 is 8, below the 14px floor the source clamps to.
    expect(container.querySelector('button')?.style.getPropertyValue('--auntie-icon-glyph')).toBe(
      '14px',
    );
  });

  it('renders the caller-supplied glyph, never one of its own', () => {
    render(<IconButton icon={<Glyph />} label="Edit" onClick={vi.fn()} />);
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
  });
});
