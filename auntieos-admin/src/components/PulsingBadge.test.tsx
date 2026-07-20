// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PulsingBadge } from './PulsingBadge';

/**
 * The count rules are the part with actual logic (the 99+ cap, and 0 meaning
 * "dot, no number"), so they carry most of the specs.
 *
 * The animation itself is a stylesheet concern and is not asserted here; jsdom
 * does not run it. What IS asserted is the structure the stylesheet keys off, so
 * a rename cannot quietly detach the animation from the element.
 */

function badgeRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('.pulsing-badge');
  if (!(root instanceof HTMLElement)) throw new Error('pulsing-badge root not rendered');
  return root;
}

describe('PulsingBadge count', () => {
  it('shows the count', () => {
    render(<PulsingBadge count={3} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows a bare dot at zero rather than a "0"', () => {
    // Compose: `if (count > 0)`. A badge reading 0 is worse than no badge.
    const { container } = render(<PulsingBadge count={0} />);
    expect(screen.queryByText('0')).toBeNull();
    expect(container.querySelector('.pulsing-badge-dot')).not.toBeNull();
  });

  it('defaults to a bare dot', () => {
    const { container } = render(<PulsingBadge />);
    expect(badgeRoot(container).classList.contains('pulsing-badge-counted')).toBe(false);
  });

  it('caps above 99 at 99+', () => {
    render(<PulsingBadge count={100} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('shows 99 as itself, the last value before the cap', () => {
    // Boundary: Compose caps on `count > 99`, so 99 is NOT capped.
    render(<PulsingBadge count={99} />);
    expect(screen.getByText('99')).toBeInTheDocument();
  });

  it('caps a very large count', () => {
    render(<PulsingBadge count={98765} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('treats a negative count as no count', () => {
    // Not reachable by design, but `count > 0` is the guard, so -1 must not
    // render "-1" in a 10px dot.
    const { container } = render(<PulsingBadge count={-1} />);
    expect(screen.queryByText('-1')).toBeNull();
    expect(badgeRoot(container).classList.contains('pulsing-badge-counted')).toBe(false);
  });

  it('grows into a pill when counted, so the number is not clipped', () => {
    const { container } = render(<PulsingBadge count={12} />);
    expect(badgeRoot(container).classList.contains('pulsing-badge-counted')).toBe(true);
  });
});

describe('PulsingBadge pulse', () => {
  it('renders the halo by default', () => {
    const { container } = render(<PulsingBadge />);
    expect(container.querySelector('.pulsing-badge-halo')).not.toBeNull();
  });

  it('drops the halo when not pulsing', () => {
    const { container } = render(<PulsingBadge pulsing={false} />);
    expect(container.querySelector('.pulsing-badge-halo')).toBeNull();
    // The dot itself must survive: `pulsing={false}` means still, not gone.
    expect(container.querySelector('.pulsing-badge-dot')).not.toBeNull();
  });

  it('hides the halo from the accessibility tree', () => {
    // It is a decorative ring around a thing that is already announced.
    const { container } = render(<PulsingBadge count={3} label="3 unread" />);
    expect(container.querySelector('.pulsing-badge-halo')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('PulsingBadge accessibility', () => {
  it('announces the label when given one', () => {
    render(<PulsingBadge count={3} label="3 unread messages" />);
    expect(screen.getByRole('status', { name: '3 unread messages' })).toBeInTheDocument();
  });

  it('takes no status role without a label', () => {
    // A nameless live region would announce nothing on change, which is noise
    // with no payload.
    render(<PulsingBadge count={3} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('still leaves the count readable as text without a label', () => {
    // The fallback: no label, but the number itself is real DOM text, not a
    // shape painted on a canvas.
    render(<PulsingBadge count={7} />);
    expect(screen.getByText('7')).toBeInTheDocument();
  });
});

describe('PulsingBadge styling', () => {
  it('defaults the colour to the primary token', () => {
    const { container } = render(<PulsingBadge />);
    expect(badgeRoot(container).style.getPropertyValue('--badge-color')).toBe('var(--color-primary)');
  });

  it('rides a caller colour token down', () => {
    const { container } = render(<PulsingBadge color="var(--color-error)" />);
    expect(badgeRoot(container).style.getPropertyValue('--badge-color')).toBe('var(--color-error)');
  });

  it('defaults the size to 10px, matching the Compose default', () => {
    const { container } = render(<PulsingBadge />);
    expect(badgeRoot(container).style.getPropertyValue('--badge-size')).toBe('10px');
  });

  it('rides the size down', () => {
    const { container } = render(<PulsingBadge size={18} />);
    expect(badgeRoot(container).style.getPropertyValue('--badge-size')).toBe('18px');
  });

  it('keeps a caller className alongside its own', () => {
    const { container } = render(<PulsingBadge className="nav-badge" />);
    const root = badgeRoot(container);
    expect(root.classList.contains('pulsing-badge')).toBe(true);
    expect(root.classList.contains('nav-badge')).toBe(true);
  });
});
