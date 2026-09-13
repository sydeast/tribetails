import { useOneShot } from '../../lib/useOneShot';
import { listConversations } from '../../api/inbox';
import { unreadClientMessages, unreadClientMessageCount } from '../../lib/dashboardInsights';
import { threadClock, threadMachineTime } from '../../lib/inboxFormat';
import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { LoadingRow } from '../../components/LoadingRow';
import { AsyncRegion } from '../../components/AsyncRegion';
import { GhostButton } from '../../components/Buttons';
import './widgets.css';

interface UnreadMessagesWidgetProps {
  /** Router nav to the Inbox screen (the "Open inbox" CTA); omitted in tests. */
  onOpenInbox?: () => void;
  /** Max rows shown; the headline count is always the full unread total. */
  limit?: number;
}

/**
 * AO-38 / punch-list W6 — Unread Client Messages dashboard widget. Loads the
 * `listConversations` summaries (the SAME one-shot the Inbox screen reads, see
 * `api/inbox.ts`) and surfaces the unread threads, newest first, with a
 * headline total. Empty is a real caught-up state, distinct from a failed load
 * (AsyncRegion never shows the empty copy during an error). All logic is in
 * `lib/dashboardInsights.ts`; this only renders.
 */
export function UnreadMessagesWidget({ onOpenInbox, limit = 5 }: UnreadMessagesWidgetProps) {
  const rows = useOneShot(listConversations, 'listConversations');

  return (
    <DenPanel
      title="Unread client messages"
      subtitle="Threads waiting on a reply, newest first."
      hoverLift
      trailing={onOpenInbox ? <GhostButton label="Open inbox" onClick={onOpenInbox} /> : undefined}
    >
      <AsyncRegion
        state={rows}
        what="conversations"
        isEmpty={(data) => unreadClientMessageCount(data) === 0}
        loading={<LoadingRow label="Loading messages…" className="den-hint" />}
        empty={<EmptyHint>Inbox is all caught up.</EmptyHint>}
      >
        {(data) => {
          const unread = unreadClientMessages(data, limit);
          const total = unreadClientMessageCount(data);
          return (
            <div className="dash-widget">
              <p className="dash-widget__count">
                {total} <span className="dash-widget__count-unit">unread</span>
              </p>
              <ul className="dash-widget__list">
                {unread.map((m) => (
                  <li key={m.kinfolkId} className="dash-widget__row">
                    <span className="dash-widget__row-name">{m.household}</span>
                    <span className="dash-widget__row-preview">
                      {m.preview === '' ? '(no preview)' : m.preview}
                    </span>
                    <time className="dash-widget__row-time" dateTime={threadMachineTime(m.atMs)}>
                      {threadClock(m.atMs)}
                    </time>
                  </li>
                ))}
              </ul>
              {total > unread.length && (
                <p className="dash-widget__more">+{total - unread.length} more waiting in the inbox</p>
              )}
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}
