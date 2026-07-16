import type { CSSProperties, ReactNode } from 'react';
import { type BrandGradient } from './Avatar';
import './IconTile.css';

export type IconTileTone =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'error'
  | 'teal'
  | 'purple'
  | 'orange'
  | 'muted';

/**
 * Tone to token. One swatch drives the wash, the rim, and the glyph, so every
 * tile in a list resolves to the SAME brand palette. Mirrors
 * AuntieStatusTone.color() in AuntieTones.kt exactly, including the two pairs
 * that deliberately collide: `orange` and `neutral` are not aliases of `error`
 * and `muted`, they are separate names the source maps onto shared swatches.
 */
const TONE_TOKEN: Record<IconTileTone, string> = {
  neutral: 'var(--color-text-dim)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
  teal: 'var(--color-accent)',
  purple: 'var(--color-tertiary)',
  orange: 'var(--color-primary)',
  muted: 'var(--color-text-faint)',
};

interface Props {
  /** Caller-supplied glyph. No icon is hardcoded here, matching the Compose source. */
  icon: ReactNode;
  /**
   * Accessible name. Omit for a tile that only restates adjacent text, which is
   * the common case on a list row; it is then hidden from the accessibility tree
   * rather than announced as a second, redundant thing. Ports the Compose
   * `contentDescription: String? = null` default.
   */
  label?: string;
  /** Rendered size in px. The glyph and the corner scale off it. */
  size?: number;
  tone?: IconTileTone;
  /**
   * Overrides the tone wash with a brand gradient, e.g. BRAND_GRADIENTS[0]. Typed
   * to the gradient tokens rather than `string` so a raw colour cannot be passed
   * in through the back door. Ports the Compose `background: Brush?`.
   */
  background?: BrandGradient;
  className?: string;
}

/**
 * Rounded-square tile holding a single glyph, ported from AuntieIconTile.kt. The
 * Den standard leading element on list rows, stat cards, and section headers.
 *
 * The tile derives its look from a tone: the glyph takes the tone colour and the
 * backdrop is a soft wash of that same colour. Pass `background` to override the
 * wash with a brand gradient; the glyph then renders in a legible on-gradient
 * colour rather than the tone tint.
 */
export function IconTile({
  icon,
  label,
  size = 42,
  tone = 'neutral',
  background,
  className,
}: Props) {
  // The tone swatch and the size ride down as custom properties so the stylesheet
  // derives every wash and rim from them with color-mix, instead of shipping eight
  // near-identical rule blocks that could drift apart.
  const style = {
    '--tile-size': `${size}px`,
    '--tile-tone': TONE_TOKEN[tone],
    ...(background !== undefined ? { '--tile-gradient': background } : {}),
  } as CSSProperties;

  const className_ = [
    'icon-tile',
    background !== undefined ? 'icon-tile-gradient' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={className_}
      style={style}
      data-tone={tone}
      {...(label !== undefined ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <span className="icon-tile-glyph">{icon}</span>
    </span>
  );
}
