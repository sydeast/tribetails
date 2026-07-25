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
import { DenScreenHeading, DenPanel, EmptyHint, ErrorHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { NotificationsDigest } from '../components/NotificationsDigest';
import { GhostButton } from '../components/Buttons';
import { ConversationThread } from './ConversationThread';
import {
  VOICEMAILS_QUERY,
  CALLS_QUERY,
  SMS_QUERY,
  EMAILS_QUERY,
  type VoicemailRow,
  type CallRow,
  type SmsRow,
  type EmailRow,
} from '../api/inboxChannels';
import {
  CHANNEL_FILTERS,
  voicemailEntry,
  callEntry,
  smsEntry,
  emailEntry,
  mergeChannelEntries,
  filterChannelEntries,
  awaitingReplyCount,
  entryTitle,
  entryWhen,
  entryMachineWhen,
  type ChannelFilterKey,
  type InboxEntry,
} from '../lib/inboxChannels';
import { ThreadActionsCard } from '../components/ThreadActionsCard';
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
 * ── Channels, the archive's third section (Task 6.1) ──────────────────────
 * `ChannelsPanel` below merges the four external streams (voicemails, calls,
 * SMS, email) into one list, newest first, off four bounded `useCollection`
 * listeners. Going through `useCollection` rather than a hand-rolled read is
 * what makes a sandbox account safe here: all four collections are
 * `isAuntie()`-only and already listed in `SUPPRESSED_IN_TEST_MODE`, and the
 * suppression is applied centrally inside that hook.
 *
 * The header badge is UNCHANGED and still sums notifications and message
 * threads only. `lib/inboxChannels.ts` carries the full reasoning; the short
 * version is that the nav rail's number comes off one listener on
 * `conversations`, and a channel count folded in here but not there would print
 * two different numbers for one word.
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

      <ChannelsPanel />
    </div>
  );
}

/**
 * The Channels section: voicemails, calls, texts and email in one list.
 *
 * ── FOUR LISTENERS, FOUR INDEPENDENT OUTCOMES ─────────────────────────────
 * This does NOT wrap the four in a single `AsyncRegion`, and that is the whole
 * design. Collapsing four reads into one state means the worst of them decides
 * what the operator sees: one failing collection would hide three that loaded
 * fine, and one slow collection would hold three finished ones behind a
 * spinner. So each stream reports for itself. Rows from the streams that are
 * ready render immediately, a stream that failed gets its own named error line,
 * and a stream still in flight is disclosed as still in flight.
 *
 * The empty state is therefore reachable only when all four are `ready` and the
 * merge is genuinely empty. "No channel activity" printed while a read was
 * failing would be the exact claim `lib/async.ts` exists to prevent.
 */
function ChannelsPanel() {
  const [filter, setFilter] = useState<ChannelFilterKey>('all');
  const [openEntry, setOpenEntry] = useState<InboxEntry | null>(null);

  // Four bounded, server-ordered listeners. Sandbox suppression, the `_id`
  // stamp and the error-with-retry contract all come from `useCollection`.
  const voicemails = useCollection<VoicemailRow>(VOICEMAILS_QUERY);
  const calls = useCollection<CallRow>(CALLS_QUERY);
  const sms = useCollection<SmsRow>(SMS_QUERY);
  const emails = useCollection<EmailRow>(EMAILS_QUERY);

  const { getTabProps } = useRovingTabs({
    count: CHANNEL_FILTERS.length,
    activeIndex: CHANNEL_FILTERS.findIndex((f) => f.key === filter),
  });

  const streams = [
    { what: 'voicemails', state: voicemails, entries: mapWhenReady(voicemails, voicemailEntry) },
    { what: 'calls', state: calls, entries: mapWhenReady(calls, callEntry) },
    { what: 'text messages', state: sms, entries: mapWhenReady(sms, smsEntry) },
    { what: 'emails', state: emails, entries: mapWhenReady(emails, emailEntry) },
  ];

  const failed = streams.filter((s) => s.state.status === 'error');
  const pending = streams.filter((s) => s.state.status === 'loading');
  const merged = mergeChannelEntries(streams.map((s) => s.entries));
  const visible = filterChannelEntries(merged, filter);

  // "Waiting on a reply", deliberately NOT "unread": see lib/inboxChannels.ts.
  // Null while the voicemail read is unresolved, because a count is a claim.
  const awaiting = voicemails.status === 'ready' ? awaitingReplyCount(voicemails.data) : null;

  const section = inboxSection('channels');

  return (
    <DenPanel
      title={section.title}
      subtitle={section.subtitle}
      trailing={
        awaiting !== null && awaiting > 0 ? (
          <span className="inbox__badge">{awaiting} waiting on a reply</span>
        ) : undefined
      }
    >
      <div className="inbox__tabs" role="tablist" aria-label="Filter channels">
        {CHANNEL_FILTERS.map((f, index) => (
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

      {/* One line per failed stream, naming the collection that failed and
          offering its own re-subscribe. Firestore detaches a listener
          permanently after its error callback, so Retry re-subscribes rather
          than merely re-rendering (see lib/firestore.ts). */}
      {failed.map((s) => (
        <ErrorHint key={s.what}>
          Couldn&rsquo;t load {s.what}: {s.state.status === 'error' ? s.state.message : ''}
          {s.state.status === 'error' && s.state.retry ? (
            <>
              {' '}
              <button type="button" className="inbox__inline-retry" onClick={s.state.retry}>
                Retry
              </button>
            </>
          ) : null}
        </ErrorHint>
      ))}

      {pending.length > 0 && (
        <p className="inbox__hint" role="status" aria-live="polite">
          Still loading {pending.map((s) => s.what).join(', ')}
          {'…'}
        </p>
      )}

      {visible.length === 0 ? (
        failed.length === 0 && pending.length === 0 ? (
          <EmptyHint>
            {filter === 'all'
              ? 'No voicemails, calls, texts or emails yet. Inbound messages land here once Twilio is pointed at the webhooks.'
              : 'Nothing on this channel yet.'}
          </EmptyHint>
        ) : null
      ) : (
        <ul className="inbox__list inbox__list--flat">
          {visible.map((entry) => (
            <ChannelRow key={`${entry.channel}:${entry.id}`} entry={entry} onOpen={setOpenEntry} />
          ))}
        </ul>
      )}

      {openEntry !== null && (
        <ThreadActionsCard entry={openEntry} onClose={() => setOpenEntry(null)} />
      )}
    </DenPanel>
  );
}

/**
 * Rows for a stream that has really resolved, and an empty list otherwise.
 *
 * `[]` here is NOT a fabricated empty result: the caller already reports
 * loading and error separately, so this only ever supplies "nothing to merge
 * from a stream that is being disclosed some other way".
 */
function mapWhenReady<T>(state: Async<T[]>, toEntry: (row: T) => InboxEntry): InboxEntry[] {
  return state.status === 'ready' ? state.data.map(toEntry) : [];
}

function ChannelRow({ entry, onOpen }: { entry: InboxEntry; onOpen: (entry: InboxEntry) => void }) {
  const pills = [
    entry.statusHint === 'missed' ? { key: 'missed', label: 'missed', tone: 'error' } : null,
    entry.statusHint === 'unread' ? { key: 'unread', label: 'waiting on a reply', tone: 'warning' } : null,
    entry.statusHint === 'replied' ? { key: 'replied', label: 'replied', tone: 'success' } : null,
    entry.direction === 'outbound' ? { key: 'direction', label: 'sent', tone: 'muted' } : null,
    entry.mediaCount > 0
      ? { key: 'media', label: `${entry.mediaCount} attached`, tone: 'muted' }
      : null,
  ].filter((p): p is { key: string; label: string; tone: string } => p !== null);

  return (
    <li className="inbox__row">
      <button type="button" className="inbox__row-main inbox__row-main--channel" onClick={() => onOpen(entry)}>
        <span className="inbox__channel-tag" data-channel={entry.channel} aria-hidden="true">
          {CHANNEL_ABBR[entry.channel]}
        </span>
        <span className="inbox__row-who">
          <span className="inbox__row-name">{entryTitle(entry)}</span>
          <span className="inbox__row-preview">{entry.preview || '(no content)'}</span>
        </span>
        <span className="inbox__row-side">
          <time className="inbox__row-time" dateTime={entryMachineWhen(entry.timestamp)}>
            {entryWhen(entry.timestamp)}
          </time>
          {pills.length > 0 && (
            <span className="inbox__pills">
              {pills.map((p) => (
                <span key={p.key} className="inbox__pill" data-tone={p.tone}>
                  {p.label}
                </span>
              ))}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * The tile glyph per channel. Text rather than an icon font, and `aria-hidden`,
 * because the row's own accessible name already carries the household and the
 * preview; announcing "VM" before it would be noise, not information.
 */
const CHANNEL_ABBR: Record<InboxEntry['channel'], string> = {
  voicemail: 'VM',
  call: 'CALL',
  sms: 'SMS',
  email: 'MAIL',
};

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
