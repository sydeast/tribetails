import type { CSSProperties, ReactNode } from 'react';
import './Buttons.css';

/**
 * Den buttons, ported 2026-07-15 from the LIVE Compose source:
 *   ui/components/PrimaryButton.kt     -> PrimaryButton
 *   ui/components/GhostButton.kt       -> GhostButton
 *   ui/components/AuntieIconButton.kt  -> IconButton
 *
 * There is no DangerButton in the Compose source. The destructive affordance
 * lives on AuntieIconButton's `destructive` flag, so it is ported there and
 * nowhere else rather than invented as a fourth component.
 *
 * ONE DELIBERATE DEPARTURE FROM THE SOURCE, and it is the point of the port:
 * every Compose original takes a REQUIRED onClick and unconditionally applies
 * .clickable. That is how the wasm admin ships badges that hover, show a hand
 * cursor, and do nothing: callers with nothing to run pass `{}`. Here onClick is
 * optional, and omitting it renders a <span> instead, which carries no button
 * role, no cursor, and no hover. A caller who wants a badge can say so.
 */

function classes(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

interface ShellProps {
  base: string;
  onClick?: (() => void) | undefined;
  disabled: boolean;
  busy: boolean;
  className?: string | undefined;
  /** Only set for icon-only controls, whose accessible name is not in the DOM. */
  ariaLabel?: string | undefined;
  /** Static glyphs need role=img or the aria-label on a bare span is inert. */
  staticRole?: 'img' | undefined;
  style?: CSSProperties | undefined;
  children: ReactNode;
}

function ControlShell({
  base,
  onClick,
  disabled,
  busy,
  className,
  ariaLabel,
  staticRole,
  style,
  children,
}: ShellProps) {
  const cls = classes(
    base,
    !onClick && 'auntie-is-static',
    disabled && 'auntie-is-disabled',
    className,
  );

  if (!onClick) {
    return (
      <span className={cls} role={staticRole} aria-label={ariaLabel} style={style}>
        {children}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      // Genuinely disabled, not grey. A styled-only button still fires, still
      // takes focus, and still submits.
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      style={style}
    >
      {children}
    </button>
  );
}

export interface PrimaryButtonProps {
  label: string;
  /** Omit to render a static, non-interactive element. See the file header. */
  onClick?: () => void;
  disabled?: boolean;
  /** Ports Compose's `loading`. Blocks the click and marks the control aria-busy. */
  busy?: boolean;
  leading?: ReactNode;
  className?: string;
}

export function PrimaryButton({
  label,
  onClick,
  disabled = false,
  busy = false,
  leading,
  className,
}: PrimaryButtonProps) {
  return (
    <ControlShell
      base="auntie-btn auntie-btn--primary"
      onClick={onClick}
      disabled={disabled}
      busy={busy}
      className={className}
    >
      {busy ? <span className="auntie-btn__spinner" aria-hidden="true" /> : null}
      {!busy && leading ? (
        <span className="auntie-btn__leading" aria-hidden="true">
          {leading}
        </span>
      ) : null}
      {/* Compose swaps the label out for the spinner. On the web that would drop
          the button's accessible name mid-flight and rename the control to
          nothing, so the label stays and the spinner joins it. */}
      <span className="auntie-btn__label">{label}</span>
    </ControlShell>
  );
}

export interface GhostButtonProps {
  label: string;
  /** Omit to render a static, non-interactive element. See the file header. */
  onClick?: () => void;
  disabled?: boolean;
  leading?: ReactNode;
  className?: string;
}

/** No busy state: GhostButton.kt has no `loading` parameter, so neither does this. */
export function GhostButton({
  label,
  onClick,
  disabled = false,
  leading,
  className,
}: GhostButtonProps) {
  return (
    <ControlShell
      base="auntie-btn auntie-btn--ghost"
      onClick={onClick}
      disabled={disabled}
      busy={false}
      className={className}
    >
      {leading ? (
        <span className="auntie-btn__leading" aria-hidden="true">
          {leading}
        </span>
      ) : null}
      <span className="auntie-btn__label">{label}</span>
    </ControlShell>
  );
}

export interface IconButtonProps {
  /** Caller-supplied glyph, per the source's "never hardcodes a glyph" rule. */
  icon: ReactNode;
  /** Ports `contentDescription`. The control's only accessible name. */
  label: string;
  /** Omit to render a static, non-interactive element. See the file header. */
  onClick?: () => void;
  disabled?: boolean;
  /** Delete/remove actions, which resolve to the brand error colour. */
  destructive?: boolean;
  /** Faint until hovered. For drag handles and inline row affordances. */
  revealOnHover?: boolean;
  /** Tile edge in px. Ports the source's `size: Dp = 38.dp`. */
  size?: number;
  className?: string;
}

const DEFAULT_ICON_SIZE = 38;
const GLYPH_RATIO = 0.5;
const GLYPH_MIN = 14;
const GLYPH_MAX = 28;

export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  destructive = false,
  revealOnHover = false,
  size = DEFAULT_ICON_SIZE,
  className,
}: IconButtonProps) {
  // Clamped so a very small or very large tile still renders a sensible glyph.
  const glyph = Math.min(GLYPH_MAX, Math.max(GLYPH_MIN, Math.round(size * GLYPH_RATIO)));

  // Cast because CSSProperties has no index signature for custom properties.
  const style = {
    '--auntie-icon-size': `${size}px`,
    '--auntie-icon-glyph': `${glyph}px`,
  } as CSSProperties;

  return (
    <ControlShell
      base={classes(
        'auntie-icon-btn',
        destructive && 'auntie-icon-btn--destructive',
        revealOnHover && 'auntie-icon-btn--reveal',
      )}
      onClick={onClick}
      disabled={disabled}
      busy={false}
      className={className}
      ariaLabel={label}
      staticRole="img"
      style={style}
    >
      <span className="auntie-icon-btn__glyph" aria-hidden="true">
        {icon}
      </span>
    </ControlShell>
  );
}
