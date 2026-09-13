import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  groupThreadsByWaiting,
  inboxArrangementFromFlags,
  unreadThreadCount,
  localDateIso,
  type ThreadReadState,
  type InboxArrangement,
} from '../lib/inboxFormat';
import { getFeatureFlags } from '../api/featureFlags';
import { inboxSection } from '../lib/inboxSections';
import { type Async } from '../lib/async';
import { useCollection } from '../lib/firestore';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, EmptyHint, ErrorHint } from '../components/DenScreenKit';
import { LoadingRow } from '../components/LoadingRow';
import { AsyncRegion } from '../components/AsyncRegion';
import { GhostButton } from '../components/Buttons';
import { ConversationThread } from './ConversationThread';
import { markAllThreadsRead } from '../api/inboxThread';
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
import { IconTile, type IconTileTone } from '../components/IconTile';
import './Inbox.css';

// ── glyphs ──────────────────────────────────────────────────────────────────
//
// The inbox mock (`ui-ideas/auntieos-inbox-2026-05-27.html`) puts a Lucide
// line icon on every channel chip, on every row's tile and on every meta pip.
// No icon package is installed here (the NavGlyphs.tsx / Directory.tsx
// precedent), so the paths are inline: 24-unit viewBox, `currentColor`
// stroke, `aria-hidden`, the same idiom the nav rail uses. Keyed by the name
// the mock's comments use for each one.

type GlyphKey =
  | 'inbox'
  | 'voicemail'
  | 'phone'
  | 'phoneMissed'
  | 'messageSquare'
  | 'mail'
  | 'check'
  | 'arrowUpRight'
  | 'image'
  | 'circleSlash'
  | 'reply';

const GLYPH_PATHS: Record<GlyphKey, string> = {
  inbox:
    'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  voicemail: 'M10 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm12 0a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM6 16h12',
  phone:
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z',
  phoneMissed:
    'm22 2-7 7M15 2l7 7M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z',
  messageSquare: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm18 3-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7',
  check: 'm6 10 4 4 8-8',
  arrowUpRight: 'M7 17 17 7M7 7h10v10',
  image:
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm6 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm10 6-3.09-3.09a2 2 0 0 0-2.82 0L6 21',
  circleSlash: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM4.93 4.93l14.14 14.14',
  reply: 'M9 17 4 12l5-5M20 18v-2a4 4 0 0 0-4-4H4',
};

function Glyph({ name, size = 14 }: { name: GlyphKey; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPH_PATHS[name]} />
    </svg>
  );
}

/** The mock's chip icons: Inbox / Voicemail / Phone / MessageSquare / Mail, in filter order. */
const FILTER_GLYPH: Record<ChannelFilterKey, GlyphKey> = {
  all: 'inbox',
  voicemail: 'voicemail',
  call: 'phone',
  sms: 'messageSquare',
  email: 'mail',
};

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

/**
 * Which read state each waiting/answered section holds, so the filter chips and
 * the sections agree by construction rather than through a second hand-written
 * mapping that could drift from `groupThreadsByWaiting`.
 */
const SECTION_READ_STATE: Record<'waiting' | 'answered', ThreadReadState> = {
  waiting: 'unread',
  answered: 'read',
};

/**
 * What the bulk "Mark all read" write is doing right now.
 *
 * There is deliberately no optimistic branch. The nav rail's badge reads the
 * SAME `unreadForAdmin` flag off its own listener (`lib/useUnreadInbox.ts`), so
 * a local clear that the server then refused would leave every screen in the
 * app printing a zero that is not true. The count reported below always comes
 * from the server's own answer, and the list is re-read afterwards.
 */
type BulkReadState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'done'; cleared: number }
  | { status: 'failed'; message: string };

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
 * `InboxScreen.kt`: kinfolk<->auntie message threads with an external Channels
 * section below. `lib/inboxSections.ts` owns the section definitions; the
 * header badge reflects message thread state only (product ruling D1: Inbox =
 * conversations/messages, Notifications = alerts/bell).
 *
 * ── Channels, the archive's third section (Task 6.1) ──────────────────────
 * `ChannelsPanel` below merges the four external streams (voicemails, calls,
 * SMS, email) into one list, newest first, off four bounded `useCollection`
 * listeners. Going through `useCollection` rather than a hand-rolled read is
 * what makes a sandbox account safe here: all four collections are
 * `isAuntie()`-only and already listed in `SUPPRESSED_IN_TEST_MODE`, and the
 * suppression is applied centrally inside that hook.
 *
 * Channels do not contribute to the badge. `lib/inboxChannels.ts` carries the
 * full reasoning; the short version is that the nav rail's number comes off one
 * listener on `conversations`, and a channel count folded in here but not there
 * would print two different numbers for one word.
 *
 * The message list loads once via the one-shot `listConversations` callable
 * (see `api/inbox.ts` for why this is a callable, not a `useCollection`
 * stream),
 * classifies every row's read state (`threadReadState`) and last sender
 * (`threadSender`) through positive enumerations, never negation (the
 * `sessionFormat.ts` / AO-12 convention), and groups the FILTERED rows TWICE.
 *
 * ── TWO ARRANGEMENTS, ONE FLAG, BOTH REAL ─────────────────────────────────
 * `auntieos.inbox.waitingSections` (Admin → More → Feature Flags) picks which
 * of the two the list is drawn in, and it is read fresh on every mount so
 * flipping it and opening the Inbox is enough to see the other one. ON, the
 * default, is the sectioned arrangement described below. OFF is the
 * arrangement that preceded PR #301: one flat list grouped by local day, with
 * the day headers back at h3. Nothing else changes between the two: the filter
 * chips, the unread badge, the rows and "Mark all read" are the same feature on
 * either side. `lib/featureFlagsCatalog.ts` carries the flag's exit plan.
 *
 * ── TWO LEVELS OF GROUPING (ARM A), AND WHY BOTH ──────────────────────────
 * `groupThreadsByWaiting` splits the list into "Waiting on a reply" and
 * "Answered", because the operator's first question is who is waiting on them,
 * and a strictly chronological list buries three live threads under ninety
 * finished ones. `groupThreadsByDay` then runs INSIDE each section, so the
 * AO-18 local-day fix (applied to this callable's epoch-ms `lastMessageAtMs`,
 * see `lib/inboxFormat.ts`) still decides every date header, newest day and
 * newest thread first, the activity-feed order Notifications.tsx also uses
 * (the inverse of Sessions.tsx's chronological schedule order). The day
 * grouping was not replaced; it moved one level down.
 *
 * The panel's "Mark all read" action clears every waiting thread server-side
 * (`markAllThreadsRead`) and then re-reads the list. Never optimistically: see
 * `BulkReadState` above.
 *
 * Opening a row hands off to the sibling `ConversationThread` view, which
 * reads the thread and sends the reply (unless a caller overrides selection
 * via `InboxProps.onSelectThread`).
 */
export function Inbox({ onSelectThread }: InboxProps) {
  const [threads, setThreads] = useState<Async<ConversationSummary[]>>({ status: 'loading' });
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

  // ── which arrangement to draw (the A/B flag) ────────────────────────────
  //
  // Read fresh on every mount, NOT through `useSharedOneShot`: a five-minute
  // cache would swallow the flip the operator just made, and the whole point of
  // this flag is that flipping it and opening the Inbox shows the other layout.
  // One extra callable, on one screen, is what buys that.
  //
  // `null` means "not decided yet", and the list waits for it (below). A
  // FAILED read is not left null: it resolves to the catalog default, because
  // `false` here is the other arrangement rather than a safe off, and a flag
  // call that failed must never be the thing that re-lays out the Inbox.
  const [arrangement, setArrangement] = useState<InboxArrangement | null>(null);
  useEffect(() => {
    let live = true;
    getFeatureFlags()
      .then((flags) => {
        if (live) setArrangement(inboxArrangementFromFlags(flags));
      })
      .catch(() => {
        if (live) setArrangement(inboxArrangementFromFlags({}));
      });
    return () => {
      live = false;
    };
  }, []);

  // Bulk mark-read. The ref, not the state, is the re-entrancy guard: a second
  // click can land before React has re-rendered with `status: 'working'`, and
  // two in-flight calls would report two different counts for one action.
  const [bulkRead, setBulkRead] = useState<BulkReadState>({ status: 'idle' });
  const bulkReadInFlight = useRef(false);
  const markAllRead = useCallback(() => {
    if (bulkReadInFlight.current) return;
    bulkReadInFlight.current = true;
    setBulkRead({ status: 'working' });
    markAllThreadsRead()
      .then((res) => {
        bulkReadInFlight.current = false;
        setBulkRead({ status: 'done', cleared: res.cleared });
        // Re-read rather than assume: `cleared` is bounded server-side, so a
        // long backlog can leave threads still unread, and the badge must show
        // what is genuinely left.
        load();
      })
      .catch((err: unknown) => {
        bulkReadInFlight.current = false;
        setBulkRead({
          status: 'failed',
          message: `markAllThreadsRead failed: ${err instanceof Error ? err.message : 'Mark all read failed'}`,
        });
      });
  }, [load]);

  // Badge semantics: counts unread message threads only. The nav rail's count
  // (lib/useUnreadInbox.ts) counts the SAME threads off ONE bounded listener
  // to keep the two numbers in sync. Notifications live on the Notifications
  // screen per product ruling D1. Channels badge counts "waiting on a reply"
  // under a different noun to avoid collision with the rail's word.
  const unreadCount =
    threads.status === 'ready' ? unreadThreadCount(threads.data) : null;

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
        subtitle="Voicemails, calls, SMS and emails, everywhere kinfolk reach out."
        trailing={
          unreadCount !== null && unreadCount > 0 ? (
            <span className="inbox__badge">{unreadCount} unread</span>
          ) : undefined
        }
      />

      <DenPanel
        title={messagesSection.title}
        subtitle={messagesSection.subtitle}
        trailing={
          // Offered only when something is actually waiting. A permanently
          // visible control that would clear nothing is the dead-control
          // anti-pattern this screen already avoids on its rows.
          unreadCount !== null && unreadCount > 0 ? (
            <GhostButton
              label={bulkRead.status === 'working' ? 'Marking…' : 'Mark all read'}
              onClick={markAllRead}
              disabled={bulkRead.status === 'working'}
            />
          ) : undefined
        }
      >
        {bulkRead.status === 'done' && (
          <p className="inbox__hint" role="status" aria-live="polite">
            {bulkRead.cleared === 1
              ? '1 thread marked read'
              : `${bulkRead.cleared} threads marked read`}
          </p>
        )}
        {bulkRead.status === 'failed' && <ErrorHint>{bulkRead.message}</ErrorHint>}

        <AsyncRegion
          state={threads}
          what="messages"
          isEmpty={(data) => data.length === 0}
          loading={<LoadingRow label="Loading messages…" className="inbox__hint" />}
          empty={
            <EmptyHint>
              No messages yet. When a kinfolk messages you from MyTribe, the thread shows up here.
            </EmptyHint>
          }
        >
          {(data) => {
            // The flag decides the SHAPE of everything below, so drawing rows
            // before it resolves would show one arrangement and then redraw in
            // the other, on the one screen whose whole purpose is comparing
            // them. The wait is a single callable bounded by lib/fns's 20s
            // timeout, and a failure resolves to the default rather than
            // hanging here (see the effect above).
            if (arrangement === null) {
              // `div[role=status][aria-live=polite]` is the app's ONE in-flight
              // marker (components/AsyncRegion.tsx), and the visual harness
              // waits on exactly that selector before it photographs a screen.
              // A bare `<p role="status">` would not do: the Inbox already
              // keeps a permanent one for announcements, which is why the
              // harness ignores that shape.
              return (
                <div role="status" aria-live="polite">
                  <p className="inbox__hint">Reading the inbox layout setting…</p>
                </div>
              );
            }
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
            // ARM A, the arrangement that ships by default: status FIRST, day
            // WITHIN it. `groupThreadsByDay` is not replaced; it still decides
            // every date header, so the AO-18 local-day fix applies inside both
            // sections exactly as it did on the flat list.
            //
            // An empty section still renders its header, but only when the
            // active filter would have LET rows into it. Under the Unread chip,
            // "Answered / Nothing answered yet" would be a plain falsehood:
            // there ARE answered threads, the filter is hiding them.
            //
            // Empty under ARM B, which has no sections at all: computing them
            // there would be work whose result the flat branch throws away.
            const sections =
              arrangement === 'waitingSections'
                ? groupThreadsByWaiting(visible).filter(
                    (s) => s.threads.length > 0 || activeFilter.test(SECTION_READ_STATE[s.key]),
                  )
                : [];

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

                {visible.length === 0 ? (
                  <EmptyHint>Nothing matches this filter.</EmptyHint>
                ) : arrangement === 'flatByDay' ? (
                  // ── ARM B: the arrangement that preceded PR #301 ─────────
                  // One flat list, `groupThreadsByDay` at the top level, day
                  // headers back up to h3 because nothing sits above them here.
                  // Byte-for-byte the markup #301 replaced, so what the
                  // operator compares is the real previous Inbox and not a
                  // reconstruction of it.
                  <ul className="inbox__list">
                    {groupThreadsByDay(visible).map((g) => (
                      <li key={g.dayKeyValue} className="inbox__day-group">
                        <h3 className="inbox__day-header">
                          {threadDayLabel(g.dayKeyValue, todayIso)}
                        </h3>
                        <ul className="inbox__day-rows">
                          {g.rows.map((row) => (
                            <ThreadRow key={row.kinfolkId} row={row} onSelectThread={openHandler} />
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="inbox__sections">
                    {sections.map((section) => (
                      <li key={section.key} className="inbox__status-group" data-status={section.key}>
                        <h3 className="inbox__status-header">{section.label}</h3>
                        {section.threads.length === 0 ? (
                          // The header stays. An absent section reads the same
                          // as one that has not loaded; an empty one answers
                          // "is anyone waiting on me" outright.
                          <EmptyHint>
                            {section.key === 'waiting'
                              ? 'Nothing is waiting on a reply.'
                              : 'No answered threads yet.'}
                          </EmptyHint>
                        ) : (
                          <ul className="inbox__list">
                            {groupThreadsByDay(section.threads).map((g) => (
                              <li key={g.dayKeyValue} className="inbox__day-group">
                                <h4 className="inbox__day-header">
                                  {threadDayLabel(g.dayKeyValue, todayIso)}
                                </h4>
                                <ul className="inbox__day-rows">
                                  {g.rows.map((row) => (
                                    <ThreadRow key={row.kinfolkId} row={row} onSelectThread={openHandler} />
                                  ))}
                                </ul>
                              </li>
                            ))}
                          </ul>
                        )}
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
  /**
   * The open sheet is held by KEY, not by value, and re-read out of the live
   * merge below on every render.
   *
   * Holding the `InboxEntry` object froze it at the moment of the click, so a
   * voicemail whose state the sheet itself had just written kept describing the
   * state it was in before — the row behind the sheet restyled itself off the
   * listener and the sheet did not. Any action gated on that state (Dismiss)
   * would have had to guess from local booleans instead of reading the record.
   * The key is `channel:id` because the four collections are independent and
   * their document ids are only unique within one.
   */
  const [openKey, setOpenKey] = useState<string | null>(null);

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

  // Resolved against the WHOLE merge, not the filtered view, so changing the
  // channel filter with a sheet open does not yank the sheet out from under the
  // operator. A row that genuinely disappeared (deleted underneath us) closes
  // the sheet rather than leaving a card describing a record that is gone.
  const openEntry = openKey === null ? null : (merged.find((e) => entryKey(e) === openKey) ?? null);

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
            <Glyph name={FILTER_GLYPH[f.key]} />
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
            <ChannelRow
              key={entryKey(entry)}
              entry={entry}
              onOpen={(e) => setOpenKey(entryKey(e))}
            />
          ))}
        </ul>
      )}

      {openEntry !== null && <ThreadActionsCard entry={openEntry} onClose={() => setOpenKey(null)} />}
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

/**
 * The one identity a channel row has across renders: its React key, and the
 * handle the open sheet is held by. Four independent collections mean a
 * document id alone is not unique across the merged list.
 */
function entryKey(entry: InboxEntry): string {
  return `${entry.channel}:${entry.id}`;
}

function ChannelRow({ entry, onOpen }: { entry: InboxEntry; onOpen: (entry: InboxEntry) => void }) {
  // The mock's `.meta` pips, in its order: direction first, then the state,
  // then the media count. Each is a tiny glyph and a dim word; the two states
  // that need answering (a missed call, a voicemail nobody has replied to) take
  // the tone the mock paints the whole row in.
  //
  // The nouns are this screen's, not the mock's. "waiting on a reply" rather
  // than "unread" is the `lib/inboxChannels.ts` ruling: the nav rail already
  // owns the word "unread" for message threads, and a voicemail's `replyStatus`
  // is a different fact from a thread's `unreadForAdmin`.
  const pips = [
    entry.direction === 'outbound' ? { key: 'direction', label: 'sent', tone: 'muted', glyph: 'arrowUpRight' } : null,
    entry.direction === 'inbound' && entry.channel !== 'voicemail'
      ? { key: 'direction', label: 'received', tone: 'muted', glyph: 'check' }
      : null,
    entry.statusHint === 'missed' ? { key: 'missed', label: 'missed', tone: 'error', glyph: 'phoneMissed' } : null,
    entry.statusHint === 'unread'
      ? { key: 'unread', label: 'waiting on a reply', tone: 'warning', glyph: 'voicemail' }
      : null,
    entry.statusHint === 'replied' ? { key: 'replied', label: 'replied', tone: 'success', glyph: 'reply' } : null,
    // Muted, not hidden. The merge in `lib/inboxChannels.ts` shows everything
    // that came in, so dismissing a voicemail marks it rather than deleting it
    // from the operator's view; the pip is how the next person reading the
    // list can tell "somebody closed this" from "nobody has looked".
    entry.statusHint === 'dismissed'
      ? { key: 'dismissed', label: 'dismissed', tone: 'muted', glyph: 'circleSlash' }
      : null,
    entry.mediaCount > 0
      ? { key: 'media', label: `${entry.mediaCount} attached`, tone: 'muted', glyph: 'image' }
      : null,
  ].filter((p): p is { key: string; label: string; tone: string; glyph: GlyphKey } => p !== null);

  const title = entryTitle(entry);
  // The mock's `.cp`: the number or address after the name. Skipped when it IS
  // the name (a caller who matched no household), or the row would read
  // "+1555… · +1555…".
  const counterpart = entry.counterpart !== '' && entry.counterpart !== title ? entry.counterpart : null;

  return (
    <li className="inbox__row inbox__row--card" data-channel={entry.channel}>
      <button type="button" className="inbox__row-main inbox__row-main--channel" onClick={() => onOpen(entry)}>
        <IconTile
          icon={<Glyph name={rowGlyph(entry)} size={16} />}
          size={36}
          tone={rowTone(entry)}
          className="inbox__tile"
        />
        <span className="inbox__row-who">
          <span className="inbox__row-head">
            <span className="inbox__row-name">{title}</span>
            {counterpart !== null && <span className="inbox__row-counterpart">· {counterpart}</span>}
          </span>
          <span className="inbox__row-preview inbox__row-preview--clamp">{entry.preview || '(no content)'}</span>
          {pips.length > 0 && (
            <span className="inbox__pips">
              {pips.map((p) => (
                <span key={p.key} className="inbox__pip" data-tone={p.tone}>
                  <Glyph name={p.glyph} size={11} />
                  {p.label}
                </span>
              ))}
            </span>
          )}
        </span>
        <time className="inbox__row-time" dateTime={entryMachineWhen(entry.timestamp)}>
          {entryWhen(entry.timestamp)}
        </time>
      </button>
    </li>
  );
}

/**
 * The tile glyph per channel: the mock's `channelIcon`, with a missed call
 * taking the PhoneMissed variant. Mirrors `channelIcon` in the Android screen.
 */
function rowGlyph(entry: InboxEntry): GlyphKey {
  switch (entry.channel) {
    case 'voicemail':
      return 'voicemail';
    case 'call':
      return entry.statusHint === 'missed' ? 'phoneMissed' : 'phone';
    case 'sms':
      return 'messageSquare';
    case 'email':
      return 'mail';
  }
}

/**
 * The mock's `channelAccent`: an unread voicemail is warning, a missed call is
 * error, everything else is primary orange. Mirrors `accentTone` on Android.
 */
function rowTone(entry: InboxEntry): IconTileTone {
  if (entry.channel === 'voicemail' && entry.statusHint === 'unread') return 'warning';
  if (entry.channel === 'call' && entry.statusHint === 'missed') return 'error';
  return 'orange';
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
    <li
      className={
        readState === 'unread' ? 'inbox__row inbox__row--card inbox__row--unread' : 'inbox__row inbox__row--card'
      }
    >
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
