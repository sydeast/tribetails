import { useId } from 'react';
import { kitTipPopover, useKitTip } from './DenScreenKit';
import './Buttons.css';

export interface HeldButtonProps {
  label: string;
  /** One short sentence: why this is held. Shown as a tip, and read as the button's description. */
  reason: string;
  /** Which kit button this stands in for. */
  tone?: 'primary' | 'ghost';
  className?: string;
}

/**
 * A button that is shown, cannot be used, and says why (#2199, operator ruling
 * 2026-11-14: for an Auntie "the button is disabled but visible").
 *
 * NOT THE NATIVE `disabled`. A disabled button takes no focus and, in most
 * browsers, no pointer events, so a reason hung on it is never reached by a
 * keyboard, a screen reader moving by Tab, or a finger. This one is
 * `aria-disabled`: it stays in the tab order, is announced as unavailable, and
 * carries the reason as its description (`aria-describedby`, on a node that is
 * always mounted, the `KitTooltip` rule).
 *
 * The reason opens on hover, on focus and on a press. A press is the phone's
 * way in: a touch opens it at once and it stays up while the finger is down
 * and after it lifts, so a tap and a long press both read it. Escape, moving
 * away or scrolling puts it away (`useKitTip`).
 *
 * IT HAS NO `onClick` TO GIVE. Nothing a caller passes can run from here, which
 * is the point: the held action cannot be reached through this control.
 */
export function HeldButton({ label, reason, tone = 'ghost', className }: HeldButtonProps) {
  const { open, setOpen, place, buttonRef, bodyRef } = useKitTip();
  const tipId = useId();
  const cls = ['auntie-btn', `auntie-btn--${tone}`, 'auntie-is-disabled', className].filter(Boolean).join(' ');
  return (
    <span className="kit-tip">
      <button
        ref={buttonRef}
        type="button"
        className={cls}
        aria-disabled="true"
        aria-describedby={tipId}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onTouchStart={() => setOpen(true)}
        // Opens, never toggles: the pointer or the focus has already opened it
        // by the time a click arrives.
        onClick={() => setOpen(true)}
      >
        <span className="auntie-btn__label">{label}</span>
      </button>
      <span
        ref={bodyRef}
        id={tipId}
        role="tooltip"
        className="kit-tip-body kit-tip-inline"
        hidden={!open}
        popover={kitTipPopover()}
        style={place === null ? undefined : { top: `${place.top}px`, left: `${place.left}px` }}
      >
        {reason}
      </span>
    </span>
  );
}
