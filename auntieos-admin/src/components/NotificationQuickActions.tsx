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
/**
 * One kind of write this row can have in flight. Issue #707: a single `busy`
 * boolean disabled all six buttons for the ~10s a Mark read round trip took,
 * which read as the whole row hanging. Narrowed to the writes that are
 * actually running, so only the buttons that write the same thing show as
 * pending; the other CTAs stay live.
 */
export type NotificationPendingKind = 'read' | 'archive' | 'booking';

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
  /**
   * The kinds of write in flight for THIS row. A set, not a single value: the
   * read write and the archive write touch different fields on the same doc
   * and can genuinely run at once (an operator can mark read and archive in
   * the same click-through before either resolves), so a single "the" pending
   * kind would drop one of them and let its button fire a second call while
   * the first is still running.
   */
  pending: ReadonlySet<NotificationPendingKind>;
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
  pending,
  onToggleRead,
  onArchive,
  onRestore,
  onNavigate,
  onBookingAction,
}: NotificationQuickActionsProps) {
  const actions = applicableNotificationActions(entry);
  const bookingPending = pending.has('booking');
  const readPending = pending.has('read');
  const archivePending = pending.has('archive');

  return (
    // The card body toggles its detail on any click (issue #705). This bar
    // sits inside that body, so a click on any of its buttons must not also
    // bubble up and toggle the card.
    <div className="notif-row__actions" onClick={(e) => e.stopPropagation()}>
      {actions.bookingId !== '' ? (
        <>
          {/* PrimaryButton's own `busy` prop ports Compose's `loading` and
              already draws a spinner in place of its leading slot, so Approve
              gets that for free. */}
          <PrimaryButton
            label="Approve"
            onClick={() => onBookingAction(actions.bookingId, 'APPROVE')}
            busy={bookingPending}
          />
          <GhostButton
            label="Deny"
            onClick={() => onBookingAction(actions.bookingId, 'REJECT')}
            disabled={bookingPending}
            leading={bookingPending ? <span className="notif-row__pending" aria-hidden="true" /> : undefined}
          />
        </>
      ) : null}

      {/* Navigation is never disabled by a pending write: leaving the screen
          never races it, and a stuck call should not trap the operator on this
          row. */}
      {actions.open ? (
        <GhostButton label="Open" onClick={() => onNavigate(actions.open!)} />
      ) : null}

      {actions.quote ? (
        <GhostButton label="Create quote" onClick={() => onNavigate(actions.quote!)} />
      ) : null}

      {/* GhostButton has no busy/loading state of its own (it ports
          GhostButton.kt, which has none either), so the pending indicator
          rides in the existing `leading` slot rather than adding one. */}
      <GhostButton
        label={read ? 'Mark unread' : 'Mark read'}
        onClick={onToggleRead}
        disabled={readPending}
        leading={readPending ? <span className="notif-row__pending" aria-hidden="true" /> : undefined}
      />
      {/* One control, two directions, chosen by the row's own state. Archiving
          used to have no inverse anywhere in the product, which made this button
          a one-way door; `unarchiveNotification` is the way back. */}
      <GhostButton
        label={archived ? 'Restore' : 'Archive'}
        onClick={archived ? onRestore : onArchive}
        disabled={archivePending}
        leading={archivePending ? <span className="notif-row__pending" aria-hidden="true" /> : undefined}
      />
    </div>
  );
}
