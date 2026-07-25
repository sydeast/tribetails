import { useCallback, useEffect, useMemo, useState } from 'react';
import { listConversations, type ConversationSummary } from '../api/inbox';
import {
  threadReadState,
  threadSender,
  threadHouseholdName,
  threadPreviewText,
  threadMessageCount,
  threadClock,
  threadMachineTime,
  threadDayLabel,
  groupThreadsByDay,
  unreadThreadCount,
  localDateIso,
  type ThreadReadState,
} from '../lib/inboxFormat';
import { NOTIFICATIONS_QUERY, type NotificationEntry } from '../api/notifications';
import { useCollection } from '../lib/firestore';
import { unreadNotificationCount } from '../lib/notificationsFeed';
import { inboxSection, inboxUnreadTotal } from '../lib/inboxSections';
import { type Async } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { NotificationsDigest } from '../components/NotificationsDigest';
import { GhostButton } from '../components/Buttons';
import { ConversationThread } from './ConversationThread';
import './Inbox.css';

/**
 * The Den filter tabs. Every predicate is a POSITIVE membership test against
 * the enumerated `ThreadReadState` (the Sessions.tsx / Invoices.tsx / AO-12
 * convention), never a negation of the other bucket.
 */
type FilterKey = 'all' | 'unread';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (state: ThreadReadState) => boolean;
}

const FILTERS: readonly FilterDef[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'unread', label: 'Unread', test: (s) => s === 'unread' },
];

interface InboxProps {
  /**
   * Row-open override. The router mounts this screen PROPLESS, and in that case
   * opening a row now shows the in-screen `ConversationThread` detail view
   * (reads the thread via `getConversationThread`, replies via
   * `replyToConversation`), a sibling view of this list. A caller (a test, or a
   * future detail ROUTE) can still pass its own `onSelectThread` to take over
   * selection instead; when it does, the in-screen thread view never opens.
   */
  onSelectThread?: (kinfolkId: string) => void;
}

/**
 * Admin Inbox ("The Den · Inbox"), STACKED SECTIONS per the archive's
 * `InboxScreen.kt`: a Notifications digest above the kinfolk<->auntie message
 * threads. `lib/inboxSections.ts` owns the order and the cross-section unread
 * total; the header badge is the sum of every section that has actually
 * resolved, never a fabricated number for one that has not.
 *
 * ── Where Channels went ───────────────────────────────────────────────────
 * The archive had a third section for the Twilio streams (voicemails, calls,
 * SMS, email). Those streams are Task 6.1 and do not exist here yet, so this
 * screen ships two sections rather than an empty panel titled "Channels": a
 * placeholder that never fills is the same dead surface as a "coming soon"
 * banner, which the plan forbids for our own code. The seam is
 * `INBOX_SECTIONS` plus `inboxUnreadTotal`'s N-count signature; 6.1 appends
 * its section and its panel with no change to the badge logic. (Android is
 * already ahead here: `ui/inbox/InboxScreen.kt` has the full channel enum,
 * because the Android app has the streams.)
 *
 * The message list loads once via the one-shot `listConversations` callable
 * (see `api/inbox.ts` for why this is a callable, not a `useCollection`
 * stream),
 * classifies every row's read state (`threadReadState`) and last sender
 * (`threadSender`) through positive enumerations, never negation (the
 * `sessionFormat.ts` / AO-12 convention), and groups the FILTERED rows by
 * LOCAL calendar day (`groupThreadsByDay`, the AO-18 fix applied to this
 * callable's epoch-ms `lastMessageAtMs`, see `lib/inboxFormat.ts`), newest day
 * and newest thread first, the activity-feed order Notifications.tsx also
 * uses (the inverse of Sessions.tsx's chronological schedule order).
 *
 * Opening a row hands off to the sibling `ConversationThread` view, which
 * reads the thread and sends the reply (unless a caller overrides selection
 * via `InboxProps.onSelectThread`).
 */
export function Inbox({ onSelectThread }: InboxProps) {
  const [threads, setThreads] = useState<Async<ConversationSummary[]>>({ status: 'loading' });
  // The SAME bounded listener the Notifications screen uses (createdAt desc,
  // capped 200). Subscribed here rather than inside NotificationsDigest so the
  // header badge can read its unread count without a second copy of the query.
  const notifications = useCollection<NotificationEntry>(NOTIFICATIONS_QUERY);
  const [filter, setFilter] = useState<FilterKey>('all');
  // The thread/detail view: a sibling VIEW of this list (the Communicate.tsx /
  // Templates.tsx pattern), not a route. Opening a row sets it; ConversationThread
  // renders in place. Only used when the caller does NOT pass its own
  // onSelectThread (the router mounts this screen propless).
  const [openThread, setOpenThread] = useState<{ id: string; name: string } | null>(null);

  // Roving-tabindex keyboard nav for the filter tablist below (Left/Right,
  // Home/End, roving tabIndex); called unconditionally at the top level per
  // the Rules of Hooks, since the tabs themselves render inside AsyncRegion's
  // conditionally-invoked render prop.
  const { getTabProps } = useRovingTabs({
    count: FILTERS.length,
    activeIndex: FILTERS.findIndex((f) => f.key === filter),
  });

  // Computed once per render pass, not per keystroke/tick, same rationale as
  // Sessions.tsx's / Invoices.tsx's todayIso.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  // Hoisted so a failed load can hand AsyncRegion a real retry, same shape as
  // FormSchemas.tsx's / FeatureFlags.tsx's load().
  const load = useCallback(() => {
    let live = true;
    setThreads({ status: 'loading' });
    listConversations()
      .then((data) => live && setThreads({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setThreads({
            status: 'error',
            message: `listConversations failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Per-section unread counts. `null` means "not resolved", NOT zero: a count
  // is a claim, and a failed or in-flight read cannot support one (the
  // StatCard / AsyncRegion policy this app follows throughout, see
  // lib/async.ts). `inboxUnreadTotal` sums only what is genuinely known.
  const unreadCount = inboxUnreadTotal([
    notifications.status === 'ready' ? unreadNotificationCount(notifications.data) : null,
    threads.status === 'ready' ? unreadThreadCount(threads.data) : null,
  ]);

  const messagesSection = inboxSection('messages');

  // Thread detail takes over the whole screen when a row is opened (and no
  // external onSelectThread overrides selection). Reading a thread clears its
  // unread server-side, so on Back we reload the list to reflect that.
  if (openThread) {
    return (
      <ConversationThread
        kinfolkId={openThread.id}
        kinfolkName={openThread.name}
        onBack={() => {
          setOpenThread(null);
          load();
        }}
      />
    );
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Inbox"
        title="Inbox"
        subtitle="Business alerts and two-way message threads with kinfolk, newest first."
        trailing={
          unreadCount !== null && unreadCount > 0 ? (
            <span className="inbox__badge">{unreadCount} unread</span>
          ) : undefined
        }
      />

      <NotificationsDigest state={notifications} />

      <DenPanel title={messagesSection.title} subtitle={messagesSection.subtitle}>
        <AsyncRegion
          state={threads}
          what="messages"
          isEmpty={(data) => data.length === 0}
          loading={<p className="inbox__hint">Loading messages…</p>}
          empty={
            <EmptyHint>
              No messages yet. When a kinfolk messages you from MyTribe, the thread shows up here.
            </EmptyHint>
          }
        >
          {(data) => {
            // Row-open handler: an external onSelectThread wins; otherwise open the
            // in-screen ConversationThread, resolving the household name from this
            // same loaded row (no second lookup).
            const openHandler =
              onSelectThread ??
              ((id: string) => {
                const r = data.find((x) => x.kinfolkId === id);
                setOpenThread({ id, name: threadHouseholdName(r?.kinfolkName ?? '', id) });
              });
            // Non-null: FILTERS lists both FilterKey members above, and
            // `filter` only ever holds a key set via setFilter(f.key) from
            // that same array (the Sessions.tsx/Invoices.tsx .find()! comment).
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = data.filter((row) => activeFilter.test(threadReadState(row.unreadForAdmin)));
            const groups = groupThreadsByDay(visible);

            return (
              <>
                <div className="inbox__tabs" role="tablist" aria-label="Filter message threads">
                  {FILTERS.map((f, index) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'inbox__tab inbox__tab--active' : 'inbox__tab'}
                      onClick={() => setFilter(f.key)}
                      {...getTabProps(index)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {groups.length === 0 ? (
                  <EmptyHint>Nothing matches this filter.</EmptyHint>
                ) : (
                  <ul className="inbox__list">
                    {groups.map((g) => (
                      <li key={g.dayKeyValue} className="inbox__day-group">
                        <h3 className="inbox__day-header">{threadDayLabel(g.dayKeyValue, todayIso)}</h3>
                        <ul className="inbox__day-rows">
                          {g.rows.map((row) => (
                            <ThreadRow key={row.kinfolkId} row={row} onSelectThread={openHandler} />
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}

                <GhostButton label="Reload" onClick={load} className="inbox__reload" />
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}

interface ThreadRowProps {
  row: ConversationSummary;
  onSelectThread?: ((kinfolkId: string) => void) | undefined;
}

function ThreadRow({ row, onSelectThread }: ThreadRowProps) {
  const readState = threadReadState(row.unreadForAdmin);
  const sender = threadSender(row.lastSenderRole);
  const household = threadHouseholdName(row.kinfolkName, row.kinfolkId);
  const preview = threadPreviewText(row.lastMessagePreview);
  const count = threadMessageCount(row.messageCount);

  const body = (
    <>
      {readState === 'unread' ? <span className="inbox__dot" aria-hidden="true" /> : <span aria-hidden="true" />}
      <span className="inbox__row-who">
        <span className="inbox__row-name">{household}</span>
        <span className="inbox__row-preview">
          {sender === 'auntie' ? 'You: ' : ''}
          {preview || '(no message yet)'}
        </span>
      </span>
      <span className="inbox__row-side">
        <time className="inbox__row-time" dateTime={threadMachineTime(row.lastMessageAtMs)}>
          {threadClock(row.lastMessageAtMs)}
        </time>
        <span className="inbox__row-count">{count}</span>
      </span>
    </>
  );

  // Static, non-interactive row unless a thread/detail handler is wired: a
  // live no-op button is the dead-control anti-pattern (see ControlShell in
  // components/Buttons.tsx and the InboxProps doc above).
  return (
    <li className={readState === 'unread' ? 'inbox__row inbox__row--unread' : 'inbox__row'}>
      {onSelectThread ? (
        <button type="button" className="inbox__row-main" onClick={() => onSelectThread(row.kinfolkId)}>
          {body}
        </button>
      ) : (
        <div className="inbox__row-main inbox__row-main--static">{body}</div>
      )}
    </li>
  );
}
