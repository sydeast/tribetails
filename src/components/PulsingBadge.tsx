import type { CSSProperties } from 'react';
import './PulsingBadge.css';

interface Props {
  /** 0 renders a bare dot. Above 99 it caps at "99+", as in the Compose source. */
  count?: number;
  /**
   * A colour TOKEN, e.g. 'var(--color-error)'. Ports the Compose `color: Color`
   * parameter, which callers pass theme colours to (c.primary, c.error).
   */
  color?: string;
  pulsing?: boolean;
  /** Diameter of the dot in px. The halo and the count scale off it. */
  size?: number;
  /**
   * Accessible name, e.g. "3 unread messages". Worth passing: a pulsing dot is
   * pure decoration to a screen reader otherwise, and an uncounted dot has no
   * text to fall back on.
   */
  label?: string;
  className?: string;
}

/**
 * A dot that breathes, optionally carrying a count. Ported from PulsingBadge in
 * AuntieMotion.kt.
 *
 * The halo is a second dot behind the first, scaling out and fading as it goes,
 * on a 900ms alternating loop.
 */
export function PulsingBadge({
  count = 0,
  color = 'var(--color-primary)',
  pulsing = true,
  size = 10,
  label,
  className,
}: Props) {
  const counted = count > 0;

  const style = {
    '--badge-size': `${size}px`,
    '--badge-color': color,
  } as CSSProperties;

  const className_ = ['pulsing-badge', counted ? 'pulsing-badge-counted' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={className_}
      style={style}
      {...(label !== undefined ? { role: 'status', 'aria-label': label } : {})}
    >
      {/* Compose keeps the halo mounted at alpha 0 when not pulsing because it has
          to hold the animation slot. The DOM has no such constraint, so a still
          badge simply has no halo element and no idle animation to composite. */}
      {pulsing && <span className="pulsing-badge-halo" aria-hidden="true" />}
      <span className="pulsing-badge-dot">
        {counted && <span className="pulsing-badge-count">{count > 99 ? '99+' : count}</span>}
      </span>
    </span>
  );
}
