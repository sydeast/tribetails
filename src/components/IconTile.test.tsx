// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IconTile, type IconTileTone } from './IconTile';
import { BRAND_GRADIENTS } from './Avatar';

/**
 * The tile's job is to resolve every leading glyph in the app to the same brand
 * palette, so the tone-to-token map is the thing worth pinning: a tone pointing
 * at the wrong swatch makes a list read as two different states at once, and it
 * looks intentional.
 *
 * The accessibility half matters for the opposite reason to Avatar's. A tile
 * usually sits beside a label that already says the thing, so the bug here is
 * announcing it twice, not failing to announce it.
 */

const GLYPH = <svg data-testid="glyph" />;

function tileRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('.icon-tile');
  if (!(root instanceof HTMLElement)) throw new Error('icon-tile root not rendered');
  return root;
}

describe('IconTile tone', () => {
  // Mirrors AuntieStatusTone.color() in AuntieTones.kt, one line per branch.
  const CASES: ReadonlyArray<readonly [IconTileTone, string]> = [
    ['neutral', 'var(--color-text-dim)'],
    ['success', 'var(--color-success)'],
    ['warning', 'var(--color-warning)'],
    ['error', 'var(--color-error)'],
    ['teal', 'var(--color-accent)'],
    ['purple', 'var(--color-tertiary)'],
    ['orange', 'var(--color-primary)'],
    ['muted', 'var(--color-text-faint)'],
  ];

  it.each(CASES)('maps %s to %s', (tone, token) => {
    const { container } = render(<IconTile icon={GLYPH} tone={tone} />);
    expect(tileRoot(container).style.getPropertyValue('--tile-tone')).toBe(token);
  });

  it('defaults to neutral, matching the Compose default', () => {
    const { container } = render(<IconTile icon={GLYPH} />);
    expect(tileRoot(container).style.getPropertyValue('--tile-tone')).toBe('var(--color-text-dim)');
    expect(tileRoot(container).getAttribute('data-tone')).toBe('neutral');
  });

  it('only ever resolves a tone to a token, never a raw colour', () => {
    for (const [tone] of CASES) {
      const { container, unmount } = render(<IconTile icon={GLYPH} tone={tone} />);
      expect(tileRoot(container).style.getPropertyValue('--tile-tone')).toMatch(/^var\(--color-[a-z-]+\)$/);
      unmount();
    }
  });
});

describe('IconTile gradient backdrop', () => {
  it('rides a brand gradient down when given one', () => {
    const { container } = render(<IconTile icon={GLYPH} background={BRAND_GRADIENTS[0]} />);
    const root = tileRoot(container);
    expect(root.style.getPropertyValue('--tile-gradient')).toBe('var(--gradient-orange-pink)');
    expect(root.classList.contains('icon-tile-gradient')).toBe(true);
  });

  it('stays on the tone wash with no gradient, and sets no gradient property', () => {
    const { container } = render(<IconTile icon={GLYPH} tone="teal" />);
    const root = tileRoot(container);
    expect(root.classList.contains('icon-tile-gradient')).toBe(false);
    // Left unset rather than set to something empty, so the stylesheet's own
    // default is what applies.
    expect(root.style.getPropertyValue('--tile-gradient')).toBe('');
  });
});

describe('IconTile accessibility', () => {
  it('names the tile when it carries meaning of its own', () => {
    render(<IconTile icon={GLYPH} label="Overdue" />);
    expect(screen.getByRole('img', { name: 'Overdue' })).toBeInTheDocument();
  });

  it('hides an unlabelled tile rather than announcing a nameless image', () => {
    // The common list-row case: the row's text already says it. Ports the Compose
    // `contentDescription = null` default.
    const { container } = render(<IconTile icon={GLYPH} />);
    expect(tileRoot(container).getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('does not mark a labelled tile hidden', () => {
    // Both at once would name the tile and then hide the name.
    const { container } = render(<IconTile icon={GLYPH} label="Overdue" />);
    expect(tileRoot(container).hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('IconTile rendering', () => {
  it('renders the caller glyph', () => {
    render(<IconTile icon={GLYPH} label="Overdue" />);
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
  });

  it('rides the size down for the glyph and corner to scale off', () => {
    const { container } = render(<IconTile icon={GLYPH} size={64} />);
    expect(tileRoot(container).style.getPropertyValue('--tile-size')).toBe('64px');
  });

  it('defaults to 42px, matching the Compose default', () => {
    const { container } = render(<IconTile icon={GLYPH} />);
    expect(tileRoot(container).style.getPropertyValue('--tile-size')).toBe('42px');
  });

  it('keeps a caller className alongside its own', () => {
    const { container } = render(<IconTile icon={GLYPH} className="row-lead" />);
    const root = tileRoot(container);
    expect(root.classList.contains('icon-tile')).toBe(true);
    expect(root.classList.contains('row-lead')).toBe(true);
  });
});
