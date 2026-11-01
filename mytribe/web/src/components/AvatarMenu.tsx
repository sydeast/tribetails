import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { BusyLabel } from './Loading';
/**
 * The header avatar and its small menu (#1309): Account, Notification settings,
 * Sign out. Before this the avatar was a bare link that went straight to
 * Account after a blank "Loading your account…" line, with no quick way out.
 *
 * A disclosure menu, not an ARIA application widget: the button announces
 * `aria-haspopup`/`aria-expanded`, the items are real links and one button, and
 * Escape or a click outside closes it. Items are plain tab stops in order, so
 * the keyboard path needs no roving focus.
 */
export function AvatarMenu(props: { initial: string; onSignOut: () => void; signingOut: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  return (
    <div className="avatar-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="avatar"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {props.initial}
      </button>
      {open && (
        <div className="avatar-menu__panel glass" role="menu" aria-label="Account menu">
          <Link role="menuitem" to="/account" onClick={() => setOpen(false)}>
            Account
          </Link>
          <Link role="menuitem" to="/account/notifications" onClick={() => setOpen(false)}>
            Notification settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className="avatar-menu__out"
            disabled={props.signingOut}
            onClick={props.onSignOut}
          >
            {props.signingOut ? <BusyLabel>Signing out…</BusyLabel> : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
