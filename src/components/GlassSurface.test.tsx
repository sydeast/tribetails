// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GlassSurface } from './GlassSurface';

describe('GlassSurface', () => {
  it('renders its children', () => {
    render(
      <GlassSurface>
        <p>Today&rsquo;s pack</p>
      </GlassSurface>,
    );

    expect(screen.getByText('Today’s pack')).toBeInTheDocument();
  });

  it('renders multiple children in order', () => {
    const { container } = render(
      <GlassSurface>
        <span>first</span>
        <span>second</span>
      </GlassSurface>,
    );

    expect(container.querySelector('.glass-surface')?.textContent).toBe('firstsecond');
  });

  it('keeps a caller className alongside its own', () => {
    const { container } = render(
      <GlassSurface className="stat-card">
        <span>x</span>
      </GlassSurface>,
    );

    const el = container.querySelector('.glass-surface');
    expect(el?.classList.contains('stat-card')).toBe(true);
  });

  it('adds no role of its own', () => {
    const { container } = render(
      <GlassSurface>
        <button type="button">Inner</button>
      </GlassSurface>,
    );

    // Presentation only. A wrapper that invented a landmark would bury the
    // caller's real semantics, which is the opposite of the point of the port.
    expect(container.querySelector('.glass-surface')?.hasAttribute('role')).toBe(false);
    expect(screen.getByRole('button', { name: 'Inner' })).toBeInTheDocument();
  });
});
