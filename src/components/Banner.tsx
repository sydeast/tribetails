import type { CSSProperties, ReactNode } from 'react';
import './Banner.css';

export type BannerTone = 'info' | 'success' | 'warning' | 'error' | 'suggestion';

/**
 * Tone to token. One swatch per tone drives the rail, the wash, the border, the
 * glyph tile, and the pill, so a banner can never read as two different states
 * at once. Mirrors AuntieBannerTone.color() in AuntieTones.kt exactly.
 */
const TONE_TOKEN: Record<BannerTone, string> = {
  info: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
  suggestion: 'var(--color-tertiary)',
};

/**
 * Only these two get role="alert".
 *
 * The wasm admin renders to a canvas and publishes no accessibility tree at all:
 * verified 2026-07-15, zero navigation elements, zero buttons, zero labels. A red
 * banner there is not an error message, it is a red rectangle, because nothing can
 * read it. The DOM gives that back for free and this map is what spends it.
 *
 * Success and suggestion are deliberately excluded. role="alert" interrupts a
 * screen reader mid-sentence, so spending it on "Saved" would train operators to
 * tune out the interruption that matters.
 */
const ALERT_TONES: ReadonlySet<BannerTone> = new Set<BannerTone>(['warning', 'error']);

interface Props {
  tone?: BannerTone;
  title?: string;
  /** Caller-supplied glyph. No icon is hardcoded here, matching the Compose source. */
  icon?: ReactNode;
  /** Dashed border: the Den convention for advisory or placeholder state (a stubbed feature) versus solid for live committed state. */
  dashed?: boolean;
  /** Short SCREAMING_SNAKE chip beside the title (STUBBED, NEEDS_ATTENTION). */
  pillLabel?: string;
  onDismiss?: () => void;
  /** Action slot, e.g. a Retry button. */
  trailing?: ReactNode;
  className?: string;
  /** Rich body slot. The caller owns the copy, same as the Compose body lambda. */
  children: ReactNode;
}

/**
 * Persistent inline banner, the fail-loud policy primitive. Ported from
 * AuntieBanner.kt. Surfaces info, success, warning, error, and suggestion inline
 * rather than swallowing them.
 *
 * Error-surface conventions follow AsyncRegion.tsx, which is the reference for
 * anything in this app that can fail.
 */
export function Banner({
  tone = 'info',
  title,
  icon,
  dashed = false,
  pillLabel,
  onDismiss,
  trailing,
  className,
  children,
}: Props) {
  // The tone swatch rides down as a custom property so the stylesheet can derive
  // every wash and rim from it with color-mix, instead of shipping five near
  // identical rule blocks that could drift apart.
  const style = { '--banner-tone': TONE_TOKEN[tone] } as CSSProperties;

  return (
    <div
      className={['banner', dashed ? 'banner-dashed' : '', className ?? ''].filter(Boolean).join(' ')}
      style={style}
      {...(ALERT_TONES.has(tone) ? { role: 'alert' } : {})}
      data-tone={tone}
    >
      <div className="banner-rail" aria-hidden="true" />
      <div className="banner-row">
        {icon !== undefined && (
          <div className="banner-glyph" aria-hidden="true">
            {icon}
          </div>
        )}

        <div className="banner-main">
          {(title !== undefined || pillLabel !== undefined) && (
            <div className="banner-head">
              {title !== undefined && <h3 className="banner-title">{title}</h3>}
              {pillLabel !== undefined && <span className="banner-pill">{pillLabel.toUpperCase()}</span>}
            </div>
          )}

          <div className="banner-body">{children}</div>

          {trailing !== undefined && <div className="banner-trailing">{trailing}</div>}
        </div>

        {onDismiss !== undefined && (
          <button type="button" className="banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
            {/* Stroked X rather than a glyph font: the Compose source draws it on a
                Canvas, and an SVG keeps the port from depending on an icon set the
                repo does not have yet. */}
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M7 7 L17 17 M17 7 L7 17" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
