import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { BusyLabel } from './Loading';
import { businessLabel } from '../lib/businessLabel';
/**
 * The header avatar and its small menu (#1309): Account, Notification settings,
 * About (#1411), Sign out. Before this the avatar was a bare link that went straight to
 * Account after a blank "Loading your account…" line, with no quick way out.
 *
 * A disclosure menu, not an ARIA application widget: the button announces
 * `aria-haspopup`/`aria-expanded`, the items are real links and one button, and
 * Escape or a click outside closes it. Items are plain tab stops in order, so
 * the keyboard path needs no roving focus.
 *
 * #1454: Edit Tribe Profile sits between Account and Notification settings at
 * every width. At phone width it is the only way into the editor, since the
 * Tribe page's own button is hidden there; the same entry the Android account
 * menu has had (TabRoute.kt accountMenu).
 *
 * #1457 (#1295 mobile map): Invoices sits between Account and Edit Tribe
 * Profile for a member with billing access (`billingAccessOf(home)`), at every
 * width. On a phone it is the one door to the bills; the desktop nav keeps its
 * own Invoices link as well. Android's accountMenu takes the same flag.
 *
 * #1459 (#1295 mobile map): Back to Directory, to the tribe picker at /pick,
 * sits directly above Sign out for operators only. It replaces the header's
 * "Switch tribe" icon, so the menu is the one place an operator leaves a tribe,
 * the same as Android's accountMenu.
 *
 * #1849: the panel is a solid surface (it used to be the frosted glass card,
 * which showed the page through its rows), and a failed sign-out is said in
 * the menu, which stays open.
 *
 * #1490: About reads "About {business name}" (the #1295 map), "About your
 * Auntie" when no name is cached, the About screen's own title. Android's
 * accountMenu takes the name the same way.
 */
export function AvatarMenu(props: {
  initial: string;
  onSignOut: () => void;
  signingOut: boolean;
  /** Plain sentence from `useSignOut().error`; shown in the menu when sign-out failed. */
  signOutError?: string | null | undefined;
  /** `billingAccessOf(home)`: false leaves Invoices out of the menu. */
  billingAccess: boolean;
  /** Operators only: true draws Back to Directory above Sign out. */
  isOperator: boolean;
  /** `getMyHome.businessName`; blank or missing reads "About your Auntie". */
  businessName?: string | null | undefined;
}) {
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
        <div className="avatar-menu__panel" role="menu" aria-label="Account menu">
          <Link role="menuitem" to="/account" onClick={() => setOpen(false)}>
            Account
          </Link>
          {props.billingAccess && (
            <Link role="menuitem" to="/invoices" onClick={() => setOpen(false)}>
              Invoices
            </Link>
          )}
          <Link role="menuitem" to="/tribe/edit" onClick={() => setOpen(false)}>
            Edit Tribe Profile
          </Link>
          <Link role="menuitem" to="/account/notifications" onClick={() => setOpen(false)}>
            Notification settings
          </Link>
          {/* #1411: the business's hours, number and privacy policy. */}
          <Link role="menuitem" to="/about" onClick={() => setOpen(false)}>
            About {businessLabel(props.businessName)}
          </Link>
          {props.isOperator && (
            <Link role="menuitem" to="/pick" onClick={() => setOpen(false)}>
              Back to Directory
            </Link>
          )}
          <button
            type="button"
            role="menuitem"
            className="avatar-menu__out"
            disabled={props.signingOut}
            onClick={props.onSignOut}
          >
            {props.signingOut ? <BusyLabel>Signing out…</BusyLabel> : 'Sign out'}
          </button>
          {props.signOutError && (
            <p className="avatar-menu__error" role="alert">
              {props.signOutError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
