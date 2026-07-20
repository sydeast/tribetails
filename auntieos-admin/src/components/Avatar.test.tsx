// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Avatar, BRAND_GRADIENTS, gradientForSeed, normalizeInitials } from './Avatar';

/**
 * Two things are under test here and they fail in different ways.
 *
 * gradientForSeed is the deterministic bit: if it drifts, every pet quietly
 * changes colour, which no screenshot diff of a single avatar would catch. Its
 * specs are pure and would run under the default node environment; they live here
 * because the file they test does, and splitting them would buy nothing.
 *
 * The component is the accessibility and fail-visible bit. The wasm app it
 * replaces renders avatars to a canvas with no accessibility tree at all
 * (verified 2026-07-15: zero labels), and its Gallery collapses a broken
 * thumbnail rather than falling back. Both are asserted below.
 */

function gradientOf(el: HTMLElement): string {
  return el.style.getPropertyValue('--avatar-gradient');
}

function avatarRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('.avatar');
  if (!(root instanceof HTMLElement)) throw new Error('avatar root not rendered');
  return root;
}

describe('gradientForSeed', () => {
  it('returns the same gradient for the same seed across calls', () => {
    // The entire point of the seed: one pet, one colour, forever.
    const first = gradientForSeed('Rufus');
    for (let i = 0; i < 50; i++) expect(gradientForSeed('Rufus')).toBe(first);
  });

  it('only ever returns a brand gradient token', () => {
    for (let i = 0; i < 500; i++) {
      expect(BRAND_GRADIENTS).toContain(gradientForSeed(`entity-${i}`));
    }
  });

  it('spreads different seeds across every option', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(gradientForSeed(`entity-${i}`));
    // Every gradient is reachable; none of them is dead code.
    expect(seen.size).toBe(BRAND_GRADIENTS.length);
  });

  it('spreads roughly evenly rather than favouring one gradient', () => {
    const counts = new Map<string, number>();
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const g = gradientForSeed(`pet_${i}`);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    // A hash that clumps would still be deterministic and still pass every test
    // above it, while making the roster look like it only owns one colour.
    for (const g of BRAND_GRADIENTS) {
      expect(counts.get(g) ?? 0).toBeGreaterThan((n / BRAND_GRADIENTS.length) * 0.5);
    }
  });

  it('sends an empty seed to the first gradient, as the Compose source does', () => {
    // Kotlin: `if (key.isEmpty()) return pairs.first()`.
    expect(gradientForSeed('')).toBe(BRAND_GRADIENTS[0]);
  });

  it('matches the Kotlin hash on known seeds', () => {
    // Golden vectors computed from the Compose rule verbatim:
    //   var h = 0; for (ch in key) h = (h * 31 + ch.code) and 0x7FFFFFFF
    // then indexed modulo the list length. These pin the hash itself, so a
    // "harmless" refactor of it cannot silently repaint the app.
    expect(gradientForSeed('AB')).toBe(BRAND_GRADIENTS[2081 % 4]);
    expect(gradientForSeed('Rufus')).toBe(BRAND_GRADIENTS[79316033 % 4]);
    expect(gradientForSeed('Mochi')).toBe(BRAND_GRADIENTS[74516386 % 4]);
    expect(gradientForSeed('Biscuit')).toBe(BRAND_GRADIENTS[1561031689 % 4]);
    expect(gradientForSeed('pet_01H8XK')).toBe(BRAND_GRADIENTS[1733709956 % 4]);
  });

  it('stays exact on long seeds, where 32-bit overflow bites', () => {
    // A Firestore id is ~20 chars. Past ~7 characters the running hash exceeds
    // 2^31 and the Kotlin Int wraps; a port that let the number grow as a double
    // would agree on short seeds and diverge exactly here.
    expect(gradientForSeed('a-very-long-entity-identifier-0001')).toBe(BRAND_GRADIENTS[1302947585 % 4]);
    const long = 'x'.repeat(5000);
    expect(BRAND_GRADIENTS).toContain(gradientForSeed(long));
  });

  it('gives ASCII case-variants of a seed the same gradient', () => {
    // Characterization, not a wish. Four gradients is a power of two, so only the
    // low 2 bits of the hash select, and flipping ASCII case moves the hash by
    // multiples of 32, which never touches those bits. Verified: 2000/2000 case
    // pairs land in the same bucket. Harmless (it makes 'rufus' and 'Rufus' agree)
    // but worth pinning, because it is NOT what the Compose source does: its list
    // is five long, so case does move the colour there.
    //
    // If this test ever fails, the gradient list length changed. Re-read the
    // fidelity note on BRAND_GRADIENTS before touching it.
    expect(gradientForSeed('ab')).toBe(gradientForSeed('AB'));
    expect(gradientForSeed('rufus')).toBe(gradientForSeed('Rufus'));
  });

  it('distinguishes seeds that differ by more than case', () => {
    expect(gradientForSeed('Rufus')).not.toBe(gradientForSeed('Mochi'));
  });
});

describe('normalizeInitials', () => {
  it('uppercases', () => {
    expect(normalizeInitials('ab')).toBe('AB');
  });

  it('keeps at most two characters', () => {
    expect(normalizeInitials('Rufus')).toBe('RU');
  });

  it('strips whitespace', () => {
    expect(normalizeInitials(' r m ')).toBe('RM');
  });

  it('allows a single character', () => {
    expect(normalizeInitials('r')).toBe('R');
  });
});

describe('Avatar accessible name', () => {
  it('names the photo', () => {
    render(<Avatar label="Rufus" imageUrl="https://cdn.example/rufus.jpg" />);
    expect(screen.getByRole('img', { name: 'Rufus' })).toBeInTheDocument();
  });

  it('names the monogram fallback', () => {
    render(<Avatar label="Rufus" initials="RU" />);
    expect(screen.getByRole('img', { name: 'Rufus' })).toBeInTheDocument();
  });

  it('names a gradient-only tile with nothing else to show', () => {
    // The bare-decorative-div case. Even with no photo, no initials, no glyph and
    // no emoji, the avatar still announces who it is.
    render(<Avatar label="Rufus" />);
    expect(screen.getByRole('img', { name: 'Rufus' })).toBeInTheDocument();
  });

  it('announces the name once, not alongside the monogram', () => {
    // role="img" prunes its subtree, so "RU" must not reach the tree beside "Rufus".
    render(<Avatar label="Rufus" initials="RU" />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });
});

describe('Avatar broken image fallback', () => {
  it('falls back to the gradient tile instead of collapsing to an empty box', () => {
    const { container } = render(
      <Avatar label="Rufus" initials="RU" imageUrl="https://cdn.example/gone.jpg" />,
    );

    const img = container.querySelector('img');
    if (img === null) throw new Error('expected a photo before the error');
    fireEvent.error(img);

    // The photo is gone, the monogram is showing, and the tile is still on-brand.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('RU')).toBeInTheDocument();
    expect(gradientOf(avatarRoot(container))).toBe(gradientForSeed('RU'));
  });

  it('keeps the accessible name through the failure', () => {
    // The failure mode that matters most: a broken URL must not also cost the
    // avatar its name and leave a nameless coloured circle.
    const { container } = render(<Avatar label="Rufus" imageUrl="https://cdn.example/gone.jpg" />);
    const img = container.querySelector('img');
    if (img === null) throw new Error('expected a photo before the error');
    fireEvent.error(img);

    expect(screen.getByRole('img', { name: 'Rufus' })).toBeInTheDocument();
  });

  it('falls back to the emoji when there are no initials', () => {
    const { container } = render(
      <Avatar label="Rufus" emoji="🐕" imageUrl="https://cdn.example/gone.jpg" />,
    );
    const img = container.querySelector('img');
    if (img === null) throw new Error('expected a photo before the error');
    fireEvent.error(img);

    expect(screen.getByText('🐕')).toBeInTheDocument();
  });

  it('gives a NEW url its own attempt after a previous one failed', () => {
    // A boolean `imageFailed` would stick, and every later photo for this avatar
    // would be suppressed. Compose keys the flag on the url; so does this.
    const { container, rerender } = render(
      <Avatar label="Rufus" imageUrl="https://cdn.example/gone.jpg" />,
    );
    const img = container.querySelector('img');
    if (img === null) throw new Error('expected a photo before the error');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();

    rerender(<Avatar label="Rufus" imageUrl="https://cdn.example/fresh.jpg" />);

    const retried = container.querySelector('img');
    expect(retried).not.toBeNull();
    expect(retried?.getAttribute('src')).toBe('https://cdn.example/fresh.jpg');
  });

  it('treats a blank url as no url at all', () => {
    // Firestore hands back '' for an unset photo far more often than it hands
    // back a genuinely broken link.
    const { container } = render(<Avatar label="Rufus" initials="RU" imageUrl="   " />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('RU')).toBeInTheDocument();
  });
});

describe('Avatar content resolution', () => {
  it('prefers the photo over the initials', () => {
    const { container } = render(
      <Avatar label="Rufus" initials="RU" imageUrl="https://cdn.example/rufus.jpg" />,
    );
    expect(container.querySelector('img')).not.toBeNull();
    expect(screen.queryByText('RU')).toBeNull();
  });

  it('prefers the initials over the glyph', () => {
    render(<Avatar label="Rufus" initials="RU" glyph={<svg data-testid="glyph" />} />);
    expect(screen.getByText('RU')).toBeInTheDocument();
    expect(screen.queryByTestId('glyph')).toBeNull();
  });

  it('prefers the glyph over the emoji', () => {
    render(<Avatar label="Rufus" glyph={<svg data-testid="glyph" />} emoji="🐕" />);
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
    expect(screen.queryByText('🐕')).toBeNull();
  });

  it('falls to the emoji when it is all there is', () => {
    render(<Avatar label="Rufus" emoji="🐕" />);
    expect(screen.getByText('🐕')).toBeInTheDocument();
  });
});

describe('Avatar styling', () => {
  it('seeds the gradient off the initials by default', () => {
    const { container } = render(<Avatar label="Rufus" initials="RU" />);
    expect(gradientOf(avatarRoot(container))).toBe(gradientForSeed('RU'));
  });

  it('lets gradientSeed override the initials, so one pet keeps one colour', () => {
    // The real reason the prop exists: initials change when a pet is renamed, the
    // document id does not.
    const { container } = render(
      <Avatar label="Rufus" initials="RU" gradientSeed="pet_01H8XK" />,
    );
    expect(gradientOf(avatarRoot(container))).toBe(gradientForSeed('pet_01H8XK'));
  });

  it('gives the same entity the same gradient across separate renders', () => {
    const a = render(<Avatar label="Rufus" gradientSeed="pet_01H8XK" />);
    const first = gradientOf(avatarRoot(a.container));
    a.unmount();

    const b = render(<Avatar label="Rufus" gradientSeed="pet_01H8XK" />);
    expect(gradientOf(avatarRoot(b.container))).toBe(first);
  });

  it('uses a token, never a raw colour', () => {
    const { container } = render(<Avatar label="Rufus" initials="RU" />);
    expect(gradientOf(avatarRoot(container))).toMatch(/^var\(--gradient-[a-z-]+\)$/);
  });

  it('rides the size down for the type and glyph to scale off', () => {
    const { container } = render(<Avatar label="Rufus" initials="RU" size={64} />);
    expect(avatarRoot(container).style.getPropertyValue('--avatar-size')).toBe('64px');
  });

  it('rings by default and drops the ring on request', () => {
    const on = render(<Avatar label="Rufus" initials="RU" />);
    expect(avatarRoot(on.container).classList.contains('avatar-ring')).toBe(true);
    on.unmount();

    const off = render(<Avatar label="Rufus" initials="RU" ring={false} />);
    expect(avatarRoot(off.container).classList.contains('avatar-ring')).toBe(false);
  });

  it('carries the shape as an attribute for the stylesheet to switch on', () => {
    const { container } = render(<Avatar label="Rufus" initials="RU" shape="rounded" />);
    expect(avatarRoot(container).getAttribute('data-shape')).toBe('rounded');
  });

  it('keeps a caller className alongside its own', () => {
    const { container } = render(<Avatar label="Rufus" initials="RU" className="roster-avatar" />);
    const root = avatarRoot(container);
    expect(root.classList.contains('avatar')).toBe(true);
    expect(root.classList.contains('roster-avatar')).toBe(true);
  });
});
