import type { ReactNode } from 'react';
import './GlassSurface.css';

interface Props {
  className?: string;
  children: ReactNode;
}

/**
 * Frosted container, ported from LiquidGlassSurface in AuntieGlass.kt.
 *
 * The Compose version reaches the glass look with Modifier.blur + a translucent
 * surfaceGlass fill + a rim border. The web equivalent is backdrop-filter, not
 * filter: Compose's blur sits under the background, whereas CSS filter would blur
 * the children too and smear the content. backdrop-filter blurs only what shows
 * through, which is what the Compose stack was reaching for.
 *
 * Presentation only, so no landmark or role: the caller owns the semantics of
 * whatever it wraps.
 */
export function GlassSurface({ className, children }: Props) {
  return <div className={['glass-surface', className ?? ''].filter(Boolean).join(' ')}>{children}</div>;
}
