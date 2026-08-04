import { formatWhen, machineWhen, type NotificationEntry } from '../api/notifications';
import { unreadNotifications, unreadNotificationCount } from '../lib/notificationsFeed';
import { notificationDetailSummary } from '../lib/notificationDetail';
import { useBulkMarkRead } from '../lib/useBulkMarkRead';
import { inboxSection } from '../lib/inboxSections';
import { type Async } from '../lib/async';
import { DenPanel, EmptyHint } from './DenScreenKit';
import { AsyncRegion } from './AsyncRegion';
import { Banner } from './Banner';
import { PrimaryButton } from './Buttons';
import './NotificationsDigest.css';

interface NotificationsDigestProps {
  /**
   * The `notifications` stream, ALREADY subscribed by the caller. The Inbox
   * owns the subscription because it also needs the unread count for its
   * cross-section header badge; passing the state down keeps one listener on
   * the screen rather than two racing copies of the same query.
   */
  state: Async<NotificationEntry[]>;
  /** Rows shown before the "+N more" line. A digest, not the full feed. */
  limit?: number;
}

/**
 * The Inbox's Notifications section: the archive's `NotificationsSection`
 * (InboxScreen.kt), restored. Unread business alerts, each with a checkbox,
 * and one bulk "Mark read (N)" action wired to `bulkMarkNotificationsRead`.
 *
 * Deliberately UNREAD-ONLY, exactly as the archive was. This is a digest of
 * what still wants attention, not a second copy of the Notifications screen:
 * the full feed, per-row mark read/unread, and read history all stay on
 * `/notifications`, and every shared decision (what counts as active, what
 * counts as unread, how a bulk batch behaves) comes from
 * `lib/notificationsFeed.ts` and `lib/useBulkMarkRead.ts` so the two surfaces
 * cannot drift.
 *
 * Fail-loud: a failed stream renders the error, never "no unread
 * notifications". An empty-looking inbox and an unreadable one must not look
 * alike, which is the whole reason `AsyncRegion` owns that branch.
 */
export function NotificationsDigest({ state, limit = 6 }: NotificationsDigestProps) {
  const bulk = useBulkMarkRead(state);
  const section = inboxSection('notifications');
  const selectedCount = bulk.selectedIds.size;

  return (
    <DenPanel
      title={section.title}
      subtitle={section.subtitle}
      trailing={
        selectedCount > 0 ? (
          <PrimaryButton
            label={`Mark read (${selectedCount})`}
            onClick={() => void bulk.markSelectedRead()}
            disabled={bulk.busy}
            busy={bulk.busy}
          />
        ) : undefined
      }
    >
      {bulk.error ? (
        <Banner tone="error" title="Marking read failed" onDismiss={() => bulk.setError(null)}>
          {bulk.error}
        </Banner>
      ) : null}

      <AsyncRegion
        state={state}
        what="notifications"
        isEmpty={(data) => unreadNotificationCount(data) === 0}
        loading={<EmptyHint>Loading notifications…</EmptyHint>}
        empty={
          <EmptyHint>
            No unread notifications. Business alerts land here when MyTribe dispatches them.
          </EmptyHint>
        }
      >
        {(data) => {
          const unread = unreadNotifications(data);
          const shown = unread.slice(0, limit);
          const hidden = unread.length - shown.length;
          return (
            <>
              <ul className="notif-digest__rows">
                {shown.map((entry) => {
                  // AO-28: prefer the human title (catalog label); fall back to
                  // the raw key for rows dispatched before titles existed.
                  const label = entry.title || entry.key || '(no key)';
                  // R5: the meta line was `category · status`, and `status` was
                  // the dispatcher's own pipeline state leaking onto a card.
                  // What replaces it is the notification's OWN subject: kin,
                  // date, time, resolved server-side, which is what a digest
                  // row needs to be worth glancing at.
                  const meta = [entry.category, notificationDetailSummary(entry)]
                    .filter((v) => (v ?? '') !== '')
                    .join(' · ');
                  return (
                    <li key={entry._id} className="notif-digest__row">
                      <input
                        type="checkbox"
                        className="notif-digest__select"
                        aria-label={`Select ${label}`}
                        checked={bulk.selectedIds.has(entry._id)}
                        onChange={(e) => bulk.toggle(entry._id, e.target.checked)}
                      />
                      <span className="notif-digest__body">
                        <span className="notif-digest__title">{label}</span>
                        {meta === '' ? null : <span className="notif-digest__meta">{meta}</span>}
                      </span>
                      <time className="notif-digest__time" dateTime={machineWhen(entry.createdAt)}>
                        {formatWhen(entry.createdAt)}
                      </time>
                    </li>
                  );
                })}
              </ul>
              {hidden > 0 ? (
                <p className="notif-digest__more">+{hidden} more unread in Notifications</p>
              ) : null}
            </>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}
