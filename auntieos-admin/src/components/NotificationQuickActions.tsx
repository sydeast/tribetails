import {
  applicableNotificationActions,
  type NotificationRoute,
} from '../lib/notificationActions';
import { type NotificationEntry } from '../api/notifications';
import { GhostButton, PrimaryButton } from './Buttons';
import type { BatchBookingAction } from '../api/bookingsWrite';

/**
 * The per-row quick-action bar, ported from the archive's
 * `NotificationsScreen.kt` QuickActionBar.
 *
 * The archive rendered these as icon-only buttons. They are labelled here
 * instead: an operator triaging a feed should not have to learn seven glyphs to
 * tell "archive" from "deny", and the labels are what make the row screen-
 * readable without a tooltip.
 *
 * WHICH BUTTONS APPEAR is decided entirely by the pure
 * `applicableNotificationActions`, never by this component. That is the point of
 * the split: the "unknown targetType renders no Open button" rule is a decision
 * with a test, not a `&&` buried in JSX. A notification whose target this build
 * does not understand gets read/unread and Archive and nothing else, which is
 * strictly better than an Open button that navigates nowhere.
 */
export interface NotificationQuickActionsProps {
  entry: NotificationEntry;
  /** Current read state, read off `readAt` by the parent. */
  read: boolean;
  /**
   * Current archive state. Decides which DIRECTION the file-away control points,
   * so an archived row offers Restore and never a second Archive that the server
   * would accept as a no-op restamp.
   */
  archived: boolean;
  /** True while a write for THIS row is in flight. */
  busy: boolean;
  onToggleRead: () => void;
  onArchive: () => void;
  onRestore: () => void;
  /** Handed a route from the pure table; the router performs the navigation. */
  onNavigate: (route: NotificationRoute) => void;
  onBookingAction: (bookingId: string, action: BatchBookingAction) => void;
}

export function NotificationQuickActions({
  entry,
  read,
  archived,
  busy,
  onToggleRead,
  onArchive,
  onRestore,
  onNavigate,
  onBookingAction,
}: NotificationQuickActionsProps) {
  const actions = applicableNotificationActions(entry);

  return (
    <div className="notif-row__actions">
      {actions.bookingId !== '' ? (
        <>
          <PrimaryButton
            label="Approve"
            onClick={() => onBookingAction(actions.bookingId, 'APPROVE')}
            disabled={busy}
          />
          <GhostButton
            label="Deny"
            onClick={() => onBookingAction(actions.bookingId, 'REJECT')}
            disabled={busy}
          />
        </>
      ) : null}

      {/* Navigation is not disabled by `busy`: leaving the screen never races a
          write, and a stuck call should not trap the operator on this row. */}
      {actions.open ? (
        <GhostButton label="Open" onClick={() => onNavigate(actions.open!)} />
      ) : null}

      {actions.quote ? (
        <GhostButton label="Create quote" onClick={() => onNavigate(actions.quote!)} />
      ) : null}

      <GhostButton label={read ? 'Mark unread' : 'Mark read'} onClick={onToggleRead} disabled={busy} />
      {/* One control, two directions, chosen by the row's own state. Archiving
          used to have no inverse anywhere in the product, which made this button
          a one-way door; `unarchiveNotification` is the way back. */}
      <GhostButton
        label={archived ? 'Restore' : 'Archive'}
        onClick={archived ? onRestore : onArchive}
        disabled={busy}
      />
    </div>
  );
}
