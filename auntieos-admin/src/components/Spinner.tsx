import './Spinner.css';

interface SpinnerProps {
  /** Accessible name: what is loading, e.g. "Reading the connection". */
  label: string;
  className?: string;
}

/**
 * The one spinner in the admin (issue #714). A small rotating ring, CSS only,
 * that stops animating under `prefers-reduced-motion: reduce` (Spinner.css,
 * belt and braces on top of the global guard in base.css).
 *
 * Carries its own accessible name (`role="img"` plus `aria-label`) and
 * `aria-busy`, so a caller can drop it in on its own, next to a button or
 * inline in a sentence, and a screen reader still says what is loading. It
 * does not claim `role="status"` itself: that is a live-region announcement,
 * and the caller already owns one (AsyncRegion's wrapper, or its own hand-rolled
 * loading branch), so a second one here would double-announce the same text.
 */
export function Spinner({ label, className }: SpinnerProps) {
  return (
    <span
      className={className ? `spinner ${className}` : 'spinner'}
      role="img"
      aria-label={label}
      aria-busy="true"
    />
  );
}
