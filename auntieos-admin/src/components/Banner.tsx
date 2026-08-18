import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  /**
   * Opt in to a close affordance even when the caller has no `onDismiss` of
   * its own to run. #406: a banner with nothing to notify (e.g. a static
   * "Archived" notice computed from the record, not from local state) used
   * to have no way to get a close button at all, short of a screen inventing
   * a `useState` just to hold the dismissed flag. This is that button,
   * built once here so any caller gets it for one prop. Passing `onDismiss`
   * still works exactly as before and implies dismissible on its own.
   */
  dismissible?: boolean;
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
  dismissible,
  onDismiss,
  trailing,
  className,
  children,
}: Props) {
  // The tone swatch rides down as a custom property so the stylesheet can derive
  // every wash and rim from it with color-mix, instead of shipping five near
  // identical rule blocks that could drift apart.
  const style = { '--banner-tone': TONE_TOKEN[tone] } as CSSProperties;

  const canDismiss = dismissible === true || onDismiss !== undefined;
  const [hidden, setHidden] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // The element focus should return to once this banner is gone. Snapshotted
  // once, on mount, same idiom as Dialog's restoreRef: "whatever opened it"
  // means whatever held focus the instant before this box existed, not
  // whatever happens to be focused at the moment of dismissal (which is
  // usually the close button itself, about to disappear).
  const restoreRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!canDismiss) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Deliberately mount-only: re-snapshotting on every render would capture
    // the close button itself the instant it receives focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDismiss() {
    setHidden(true);
    onDismissRef.current?.();
    // A banner that mounted alongside a Dialog (invoice overlay opens with
    // this notice already showing) snapshotted the dialog's own panel as
    // restoreRef, per Dialog's own focus-on-open. Returning focus there is
    // correct. A banner that mounted LATER, inside an already-open dialog
    // (e.g. clicking Archive while the overlay is up), snapshotted whatever
    // triggered that — also correct, and still inside the trap. What is
    // never correct is a snapshot that has since left the DOM, or one that
    // sits outside the dialog this banner lives in: either would punch focus
    // out of an open aria-modal panel.
    const snap = restoreRef.current;
    const dialog = rootRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    const target = snap?.isConnected && (!dialog || dialog.contains(snap)) ? snap : dialog;
    target?.focus?.();
  }

  useEffect(() => {
    if (!canDismiss) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      // Registered on `window`, which sits outside `document` on the capture
      // path, so this always runs before Dialog's own document-level Escape
      // handler regardless of which of the two mounted first: Escape closes
      // THIS box, not the whole overlay it happens to live inside.
      e.stopPropagation();
      handleDismiss();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDismiss]);

  if (hidden) return null;

  return (
    <div
      ref={rootRef}
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

        {canDismiss && (
          <button type="button" className="banner-dismiss" onClick={handleDismiss} aria-label="Dismiss">
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
